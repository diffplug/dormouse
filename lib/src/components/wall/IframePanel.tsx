import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { XIcon } from '@phosphor-icons/react';
import { modalActionButton, PaneMessage, PopupButtonRow, popupButton, TERMINAL_BOTTOM_RADIUS_CLASS } from '../design';
import { getPlatform } from '../../lib/platform';
import { registerSurfaceFocusHandle } from '../../lib/terminal-registry';
import type { IframeNetworkOffer, IframeProxyResult } from '../../lib/platform/types';
import { IFRAME_HTTP_ONLY } from '../../lib/platform/iframe-proxy-types';
import type { PaneProps } from './pane-props';
import { usePaneChrome } from './use-pane-chrome';
import { PaneWriteContext, WallActionsContext } from './wall-context';
import {
  openAgentBrowserScreenModal,
  registerAgentBrowserScreen,
  type ChromeActions,
  type ScreenActions,
  type ScreenRegistration,
} from './agent-browser-screen';
import { isToolParams, toolScopeFromParams } from './browser-surface';
import { builtinHandler } from 'dor-tools-builtin/file-viewer-format';
import { IFRAME_ALLOW, IFRAME_SANDBOX } from '../../lib/iframe-policy';
import { connectIframeTheme } from '../../lib/themes/iframe-theme';
import { connectToolEditor, withToolEditorConsent } from '../../lib/tool-editor';
import { offeredRenderModes } from './browser-automation';
import { browserSurfaceUrl, hostPathDisplay, iframeRefusal } from './browser-url';
import { isRealBlur } from '../../lib/window-focus';
import { changeNetworkPolicy, getNetworkPolicySnapshot, subscribeToNetworkPolicy } from '../../remote/burrow/network-policy-store';
import { ALLOWED_NETWORK_REACH, withAllowedNetworks } from '../../remote/network-policy';
import { useBusyAction } from '../remote-control-shared';

// Uninstrumented documents (docs/specs/dor-browser.md → "Iframe Shim"). The
// lead admits the shim's pageshow report, which races the frame's load event
// to the parent. The proxy instruments HTML only, so a frame is judged only
// once its shim has reported: a proxied image, PDF or JSON document served
// from the start is working, not lost.
const SHIM_REPORT_TIMEOUT_MS = 1000;
const SHIM_REPORT_LEAD_MS = 250;
// A frame is transparent until its first document loads, so the pane's themed
// background shows instead of the frame's white canvas: transparent, not
// hidden, so it still lays out and loads. One whose load never fires shows
// after this.
const FIRST_PAINT_FALLBACK_MS = 1000;

type Resolution =
  | { kind: 'empty' }
  | { kind: 'resolving' }
  | { kind: 'proxied'; src: string; origin: string }
  // The host can't run a proxy (e.g. the web host) — keep the blind raw-iframe
  // fallback rather than hiding the surface.
  | { kind: 'raw'; src: string }
  // The upstream is off this machine, on a public address or a network the
  // policy does not allow (docs/specs/dor-browser.md → "Iframe External Origins").
  | { kind: 'external'; origin: string; publicAddress: boolean; offer?: IframeNetworkOffer }
  // 'non-http' is the panel's own refusal of a non-http(s) `params.url`;
  // 'scheme'/'unreachable' come back from the proxy.
  | { kind: 'error'; reason: 'unreachable' | 'scheme' | 'non-http'; detail?: string };

type IframeHistory = {
  entries: string[];
  index: number;
};

/** The policy's allowed networks as one value, so a change to them is seen; `null` until it is read. */
function allowedNetworksKey(): string | null {
  const state = getNetworkPolicySnapshot();
  return state.kind === 'ready' ? [...state.network.policy.allowed].sort().join(' ') : null;
}

const networksOf = (key: string) => new Set(key.split(' ').filter(Boolean));

/** Add `prefixes` to the allowed networks, from the service's latest answer. Whether any was new. */
async function allowNetworks(prefixes: readonly string[]): Promise<boolean> {
  let added = false;
  await changeNetworkPolicy(({ policy }) => {
    const next = withAllowedNetworks(policy, prefixes);
    added = next !== null;
    return next;
  });
  return added;
}

/** What the panel shows for the host's answer to framing `url`. */
function resolutionOf(url: string, result: IframeProxyResult): Resolution {
  if (result.ok) return { kind: 'proxied', src: result.url, origin: originOf(result.url) };
  if (result.reason !== 'external') return { kind: 'error', reason: result.reason, detail: result.detail };
  return { kind: 'external', origin: originOf(url) || url, publicAddress: result.publicAddress === true, offer: result.offer };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function sameUrl(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/** A redirect: `nextUrl` takes the place of the entry that redirected, when
 *  that is the current one, so Back does not land on it to redirect again. */
function redirectHistory(history: IframeHistory, fromUrl: string | null, nextUrl: string): IframeHistory {
  const current = history.entries[history.index];
  if (current === undefined || fromUrl === null || !sameUrl(current, fromUrl)) return appendHistory(history, nextUrl);
  return { entries: [...history.entries.slice(0, history.index), nextUrl], index: history.index };
}

function appendHistory(history: IframeHistory, nextUrl: string): IframeHistory {
  const current = history.entries[history.index] ?? '';
  if (!nextUrl || sameUrl(current, nextUrl)) return history;
  return {
    entries: [...history.entries.slice(0, history.index + 1), nextUrl],
    index: history.index + 1,
  };
}

function upstreamUrlFromFrameLocation(frameUrl: unknown, targetUrl: string, proxyOrigin: string): string | null {
  if (typeof frameUrl !== 'string' || !targetUrl || !proxyOrigin) return null;
  try {
    const frame = new URL(frameUrl);
    if (frame.origin !== proxyOrigin) return null;
    const target = new URL(targetUrl);
    return `${target.origin}${frame.pathname}${frame.search}${frame.hash}`;
  } catch {
    return null;
  }
}

export function IframePanel({ id, title, params, onReady }: PaneProps & {
  /** A frame after a document loads. */
  onReady?: () => void;
}) {
  const actions = useContext(WallActionsContext);
  const paneWrite = useContext(PaneWriteContext);
  const elRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  usePaneChrome(id, elRef);
  const rawUrl = typeof params?.url === 'string' ? params.url : '';
  // Normalize once, at the source. `sourceUrl` is not only what gets framed: it
  // seeds `liveUrl` and the history entries, and it is the upstream base
  // `upstreamUrlFromFrameLocation` parses. Normalizing only at the frame would
  // leave a schemeless `host:port` parsed as scheme `host:` everywhere else —
  // `.origin` is the string "null", so an in-frame navigation would map to
  // `null/<path>` and Back would persist that into `params.url`. A non-http(s)
  // URL has no normalized form, so it survives raw and the refusal below fires.
  const framedUrl = browserSurfaceUrl(rawUrl);
  const sourceUrl = framedUrl ?? rawUrl;
  const isTool = isToolParams(params);
  const [liveUrl, setLiveUrl] = useState(sourceUrl);
  // A new-tab/window request from the proxy shim, pending the user's choice to
  // open it as a new pane (docs/specs/dor-browser.md → "Iframe Shim").
  const [pendingOpenUrl, setPendingOpenUrl] = useState<string | null>(null);
  // The proxied frame loaded a document with no shim in it (docs/specs/dor-browser.md
  // → "Iframe Shim").
  const [uninstrumented, setUninstrumented] = useState(false);
  const lastShimReportRef = useRef(Number.NEGATIVE_INFINITY);
  const shimCheckRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [history, setHistory] = useState<IframeHistory>(() => (
    sourceUrl ? { entries: [sourceUrl], index: 0 } : { entries: [], index: -1 }
  ));
  // Mirror the live index into a ref so the back/forward actions stay stable —
  // otherwise chromeActions (and the screen registration depending on it) would
  // churn on every navigation.
  const historyIndexRef = useRef(history.index);
  historyIndexRef.current = history.index;
  const historyRef = useRef(history);
  historyRef.current = history;
  // Bumped by the header's reload button to re-resolve the proxy (a cross-origin
  // frame can't be reloaded via its contentWindow).
  const [reloadNonce, setReloadNonce] = useState(0);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // Params are still the persisted/source URL for session restore and
  // render-swaps. Keep a small browser-like history on top so iframe chrome
  // Back/Forward are real even though the cross-origin frame history itself is
  // not reachable from the parent webview.
  useEffect(() => {
    if (!sourceUrl) {
      setLiveUrl('');
      setHistory({ entries: [], index: -1 });
      return;
    }
    setLiveUrl(sourceUrl);
    setHistory((prev) => appendHistory(prev, sourceUrl));
  }, [sourceUrl]);

  // Show a URL in the frame chrome + history. `persist` writes it back to the
  // panel params (a real navigation we initiated); an observed frame URL does
  // not, since params stay the source/restore URL.
  const applyFrameUrl = useCallback((nextUrl: string, persist: boolean) => {
    if (!nextUrl) return;
    setLiveUrl(nextUrl);
    setHistory((prev) => appendHistory(prev, nextUrl));
    if (persist) paneWrite.updateParams(id, { url: nextUrl });
    paneWrite.setTitle(id, hostPathDisplay(nextUrl, true));
  }, [paneWrite, id]);

  const commitUrl = useCallback((nextUrl: string) => applyFrameUrl(nextUrl, true), [applyFrameUrl]);
  // The proxy answered a frame load's redirect off its upstream origin
  // (docs/specs/dor-browser.md → "Iframe External Origins"): open the target
  // here, through the same gate as the URL bar.
  const followRedirect = useCallback((fromUrl: string | null, nextUrl: string) => {
    setLiveUrl(nextUrl);
    setHistory((prev) => redirectHistory(prev, fromUrl, nextUrl));
    paneWrite.updateParams(id, { url: nextUrl });
    paneWrite.setTitle(id, hostPathDisplay(nextUrl, true));
    setReloadNonce((n) => n + 1);
  }, [paneWrite, id]);
  const observeFrameUrl = useCallback((nextUrl: string) => applyFrameUrl(nextUrl, false), [applyFrameUrl]);

  const goToHistoryIndex = useCallback((nextIndex: number) => {
    const prev = historyRef.current;
    if (nextIndex < 0 || nextIndex >= prev.entries.length) return;
    const nextUrl = prev.entries[nextIndex];
    setLiveUrl(nextUrl);
    setHistory({ ...prev, index: nextIndex });
    paneWrite.updateParams(id, { url: nextUrl });
    paneWrite.setTitle(id, hostPathDisplay(nextUrl, true));
    // Force a proxy re-resolution so the frame actually reloads. After an
    // observed in-frame navigation, params.url stays at the source URL, so a
    // Back to that same URL is a no-op write — without bumping the nonce the
    // proxy effect (deps: sourceUrl, reloadNonce) wouldn't re-fire and the frame
    // would keep showing the navigated page while the chrome shows the target.
    setReloadNonce((n) => n + 1);
  }, [paneWrite, id]);

  // Ask the host to front the target with its transparent proxy. The returned
  // URL is a loopback origin that serves the page's bytes (instrumented for
  // loopback) so Dormouse — now the server — gets a keyboard side-channel, an
  // accurate focus model, and real error pages. Reachability is diagnosed by
  // the proxy and shown as a served page inside the frame.
  const [resolution, setResolution] = useState<Resolution>(() => (sourceUrl ? { kind: 'resolving' } : { kind: 'empty' }));
  // The allowed networks, read here so an answer can tell whether they changed
  // while it was in flight (the re-ask effect below skips a resolving pane).
  const allowedKey = useSyncExternalStore(subscribeToNetworkPolicy, allowedNetworksKey);
  const allowedKeyRef = useRef(allowedKey);
  allowedKeyRef.current = allowedKey;
  const resolutionRef = useRef(resolution);
  resolutionRef.current = resolution;
  // This mounted view's lease on its proxy grant (docs/specs/dor-browser.md →
  // "Iframe Proxy Leases"): Reload, Back and Forward keep the grant and its
  // origin, and unmounting — a kill, a swap, a transfer — ends it. Minted by
  // the effect that releases it, so a released id is never asked for again:
  // StrictMode's mount, unmount, mount gets a second lease, and no transport
  // can deliver a create of the first after its release.
  const [lease, setLease] = useState<string | null>(null);
  useEffect(() => {
    const minted = `${id}#${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    setLease(minted);
    return () => getPlatform().releaseIframeProxy?.(minted);
  }, [id]);
  useEffect(() => {
    if (!isTool || resolution.kind !== 'proxied' || !iframeRef.current) return;
    return connectIframeTheme(iframeRef.current, resolution.origin);
  }, [isTool, resolution]);
  useEffect(() => {
    if (!isTool || !builtinHandler('kind', params.toolName)?.editor || toolScopeFromParams(params) !== 'builtin'
      || resolution.kind !== 'proxied' || !iframeRef.current) return;
    return connectToolEditor(id, String(params.toolTarget ?? title), iframeRef.current, resolution.origin);
  }, [id, isTool, params?.toolName, params?.toolScope, params?.toolTarget, title, resolution]);
  useEffect(() => {
    if (!sourceUrl) {
      setResolution({ kind: 'empty' });
      return;
    }
    // The panel is the sink every writer of `params.url` ends at, and the raw
    // fallback hands the string straight to `<iframe src>` under a sandbox that
    // keeps allow-same-origin — so the scheme is checked here rather than only
    // at the two callers the spec names (docs/specs/dor-browser.md → "Iframe
    // Shim"). The header's URL editor is the third: `normalizeNavUrl` keeps a
    // typed `javascript:` or `data:` scheme on purpose. React blanks a
    // `javascript:` src and nothing else, which is not a boundary to rely on.
    // `framedUrl` is the string this guard checks and `sourceUrl` is the string
    // that gets framed, so they are the same value wherever one exists at all.
    if (!framedUrl) {
      setResolution({ kind: 'error', reason: 'non-http' });
      return;
    }
    const createProxy = getPlatform().createIframeProxyUrl;
    if (!createProxy) {
      setResolution({ kind: 'raw', src: sourceUrl });
      return;
    }
    setResolution({ kind: 'resolving' });
    // The lease arrives with the first effect pass.
    if (lease === null) return;
    let cancelled = false;
    const askedUnder = allowedKeyRef.current;
    createProxy(sourceUrl, lease).then(
      (result: IframeProxyResult) => {
        if (cancelled) return;
        // The host may have read the networks before the change: ask again under the new ones.
        if (askedUnder !== null && allowedKeyRef.current !== askedUnder) setReloadNonce((n) => n + 1);
        else setResolution(resolutionOf(sourceUrl, result));
      },
      () => {
        if (!cancelled) setResolution({ kind: 'error', reason: 'unreachable' });
      },
    );
    return () => { cancelled = true; };
  }, [sourceUrl, reloadNonce, lease]);

  // A change to the allowed networks — from this pane's warning, another's, or
  // Settings, in any window — re-asks the host where it could matter: a
  // refused page once one is added, and a framed one once one is removed, so
  // that preview closes with its grant. The first reading is the baseline the
  // pane was resolved under.
  const seenAllowedKeyRef = useRef(allowedKey);
  useEffect(() => {
    const before = seenAllowedKeyRef.current;
    seenAllowedKeyRef.current = allowedKey;
    if (before === null || allowedKey === null || before === allowedKey) return;
    const was = networksOf(before);
    const now = networksOf(allowedKey);
    const current = resolutionRef.current;
    const affected = current.kind === 'external' ? [...now].some((cidr) => !was.has(cidr))
      : current.kind === 'proxied' && [...was].some((cidr) => !now.has(cidr));
    const createProxy = getPlatform().createIframeProxyUrl;
    if (!affected || !createProxy || lease === null) return;
    let cancelled = false;
    createProxy(sourceUrl, lease).then((result) => {
      if (cancelled || resolutionRef.current !== current) return;
      const next = resolutionOf(sourceUrl, result);
      if (current.kind !== 'proxied' || next.kind !== 'proxied' || next.origin !== current.origin) setResolution(next);
    }, () => {});
    return () => { cancelled = true; };
  }, [allowedKey, sourceUrl, lease]);

  // Register a screen controller so the embed surface shows the unified
  // browser chrome (URL + the far-left chip → Display modal) and can swap back
  // to a live screencast. Gated on the host being able to launch an automated
  // browser — without one there's no screencast to swap to, so the embed
  // surface keeps its plain title (e.g. the web host). A tool never pops out
  // or changes provider (`docs/specs/dor-tool.md` -> Declaring tools); the
  // other registration site is `agent-browser-surface-controller.ts`.
  const renderModes = useMemo(() => offeredRenderModes(isTool, null), [isTool]);
  const swapCapable = renderModes.some((mode) => mode !== 'iframe');
  const agentBrowserCapable = renderModes.includes('agent-browser-screencast');
  const screenActions = useMemo<ScreenActions>(() => ({
    engageSync() {},
    applyViewport() {},
    openModal() { openAgentBrowserScreenModal(id); },
    // iframe is the current backend; every other offered mode swaps to an
    // automated browser. Wired only when the host can launch one — without it
    // the modal hides its Render section, but the chrome (URL/nav) still shows.
    setRenderMode: swapCapable
      ? (mode, opts) => { if (mode !== 'iframe' && renderModes.includes(mode)) {
        if (opts?.viewport) actionsRef.current.onSwapRenderMode(id, mode, opts.viewport);
        else actionsRef.current.onSwapRenderMode(id, mode);
      } }
      : undefined,
  }), [id, swapCapable, renderModes]);
  const setRenderMode = screenActions.setRenderMode;
  const openInAgentBrowser = setRenderMode && agentBrowserCapable ? () => setRenderMode('agent-browser-screencast') : undefined;
  // A Tool's header offers no navigation (`ToolPaneHeader`); reload is its one
  // chrome action that replaces the document.
  const chromeActions = useMemo<ChromeActions>(() => ({
    // A URL-bar Enter always loads: the pane's own params.url after an
    // in-frame navigation is a no-op write the proxy effect never sees.
    navigate(next) { commitUrl(next); setReloadNonce((n) => n + 1); },
    back() { goToHistoryIndex(historyIndexRef.current - 1); },
    forward() { goToHistoryIndex(historyIndexRef.current + 1); },
    reload() {
      const reload = () => {
        const current = historyRef.current.entries[historyIndexRef.current];
        if (current) paneWrite.updateParams(id, { url: current });
        // Unmount even a raw frame: assigning its unchanged src does not reload
        // it. The resolving effect then mounts the current page on the same lease.
        setResolution({ kind: 'resolving' });
        setReloadNonce((n) => n + 1);
      };
      if (isTool) withToolEditorConsent(id, reload); else reload();
    },
  }), [id, isTool, paneWrite, commitUrl, goToHistoryIndex]);
  const registrationRef = useRef<ScreenRegistration | null>(null);
  // Register the screen controller unconditionally so the browser chrome (URL +
  // far-left chip) shows for every iframe surface, on every host — `dor iframe`
  // is a full browser-chrome tab, not a lesser one (docs/specs/dor-browser.md).
  // The render-swap action is gated separately (screenActions.setRenderMode).
  useEffect(() => {
    const registration = registerAgentBrowserScreen(id, {
      snapshot: {
        state: 'SYNCED',
        renderMode: 'iframe',
        viewport: { w: 0, h: 0, dpr: 1 },
        paneCss: { w: 0, h: 0 },
        displayDpr: 1,
        syncEngaged: false,
      },
      actions: screenActions,
      chrome: { url: liveUrl, displayUrl: hostPathDisplay(liveUrl), title: title ?? null, key: null },
      chromeActions,
      hostCapable: false,
      renderModes,
      // An embed renders at the pane size, so a swap to screencast follows it.
      viewportSetting: () => ({ mode: 'pane-sync' }),
    });
    registrationRef.current = registration;
    return () => { registration.dispose(); registrationRef.current = null; };
  }, [id, screenActions, chromeActions, renderModes]);
  // Keep the header's URL current as navigation and in-frame location changes
  // land. The iframe src is still driven only by sourceUrl.
  useEffect(() => {
    registrationRef.current?.updateChrome({ url: liveUrl, displayUrl: hostPathDisplay(liveUrl), title: title ?? null, key: null });
  }, [liveUrl, title]);

  // Trust postMessage from this frame's origin only while the proxied surface is live.
  const proxyOrigin = resolution.kind === 'proxied' ? resolution.origin : null;

  // A new frame source starts over: no verdict until its shim reports.
  useEffect(() => {
    setUninstrumented(false);
    lastShimReportRef.current = Number.NEGATIVE_INFINITY;
    return () => clearTimeout(shimCheckRef.current);
  }, [resolution]);
  const onFrameLoad = useCallback(() => {
    if (!proxyOrigin || lastShimReportRef.current === Number.NEGATIVE_INFINITY) return;
    const loadedAt = performance.now();
    clearTimeout(shimCheckRef.current);
    shimCheckRef.current = setTimeout(() => {
      if (lastShimReportRef.current < loadedAt - SHIM_REPORT_LEAD_MS) setUninstrumented(true);
    }, SHIM_REPORT_TIMEOUT_MS);
  }, [proxyOrigin]);

  // A focused cross-origin frame owns the keyboard and the mouse, so the Wall
  // sees neither its clicks nor its dual-tap chord, and on WebKit the iframe
  // element's own `focus` event doesn't fire for a click either. The shim posts
  // `pointerdown` and `leader` out instead. The page shares the shim's origin and
  // can post either with no gesture, so each counts only from this frame while it
  // holds focus: the shim takes focus before it posts a press, and focus reaches
  // this document first. A frame without focus moves no selection, mode, or focus.
  useEffect(() => {
    if (!proxyOrigin) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== proxyOrigin) return;
      const data = e.data as { __dormouse?: unknown; url?: unknown; loaded?: unknown; from?: unknown } | null;
      if (data?.__dormouse === 'pointerdown' || data?.__dormouse === 'leader') {
        const frame = iframeRef.current;
        if (document.activeElement !== frame || e.source !== frame?.contentWindow) return;
        if (data.__dormouse === 'leader') actions.onFrameLeader();
        else actions.onClickPanel(id);
        return;
      }
      if (data?.__dormouse === 'open-window' && typeof data.url === 'string') {
        // Single-frame renderer: a new-tab/window request becomes a new pane.
        // Map a proxy-origin URL back to the upstream; pass externals through.
        // The framed page chose this string, so the scheme is checked here and
        // not left to the confirm prompt — which is consent, not a boundary.
        const mapped = browserSurfaceUrl(
          upstreamUrlFromFrameLocation(data.url, liveUrl || sourceUrl, proxyOrigin) ?? data.url,
        );
        if (mapped) setPendingOpenUrl(mapped);
        return;
      }
      if (data?.__dormouse === 'navigate' && typeof data.url === 'string') {
        // Any document on the proxy origin can send this, not only the proxy's
        // redirect page, so it is a URL-bar entry: re-checked, then gated.
        const next = browserSurfaceUrl(data.url);
        if (next) followRedirect(upstreamUrlFromFrameLocation(data.from, liveUrl || sourceUrl, proxyOrigin), next);
        return;
      }
      if (data?.__dormouse === 'location') {
        // Only a location on the proxy origin is the shim reporting its own
        // document; a clicked link's href can name anywhere.
        const nextUrl = upstreamUrlFromFrameLocation(data.url, liveUrl || sourceUrl, proxyOrigin);
        if (!nextUrl) return;
        // Only a load report vouches for the document that just loaded: a
        // clicked link's report comes from the page being left.
        if (data.loaded === true) lastShimReportRef.current = performance.now();
        setUninstrumented(false);
        observeFrameUrl(nextUrl);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [id, proxyOrigin, actions, liveUrl, sourceUrl, observeFrameUrl, followRedirect]);

  // Raw fallback frames have no injected shim, but focusing a cross-origin
  // iframe still blurs the parent window while the document itself remains
  // focused. Adopt that as entering the pane so hosts without a proxy keep the
  // same click/focus behavior, albeit without the proxied leader side-channel.
  // Focus alone is no gesture, so it acknowledges nothing.
  useEffect(() => {
    if (resolution.kind !== 'raw') return;
    const onWindowBlur = () => {
      if (!isRealBlur() && document.activeElement === iframeRef.current) {
        actions.onEnterPanel(id);
      }
    };
    window.addEventListener('blur', onWindowBlur);
    return () => window.removeEventListener('blur', onWindowBlur);
  }, [id, resolution.kind, actions]);

  // Register a focus handle so onClickPanel → enterPassthrough can focus the
  // frame like any other surface, and enterCommandMode can hand focus back.
  // Focusing the element moves keyboard focus into the frame.
  useEffect(() => {
    if (resolution.kind !== 'proxied' && resolution.kind !== 'raw') return;
    return registerSurfaceFocusHandle(id, {
      // Skip if the frame already holds focus: re-focusing a cross-origin frame
      // on WebKit can blank it (the frame is already focused after a click).
      focus: () => {
        if (document.activeElement !== iframeRef.current) iframeRef.current?.focus();
      },
      // Pull focus back into the top document so the Wall's window keydown
      // listener receives command-mode keys after the leader exits passthrough —
      // blurring a cross-origin frame doesn't reliably hand focus back on WebKit.
      blur: () => {
        iframeRef.current?.blur();
        elRef.current?.focus();
      },
    });
  }, [id, resolution.kind]);

  const src = resolution.kind === 'proxied' || resolution.kind === 'raw' ? resolution.src : '';
  // Declining an external page goes back to the page before it, or, with none,
  // closes the pane it would have opened in.
  const cancelExternal = () => {
    if (historyIndexRef.current > 0) goToHistoryIndex(historyIndexRef.current - 1);
    else actions.onKill(id);
  };

  // Shown from the first load on: navigation, reload, and history re-resolve
  // the proxy and mount a new frame, which must not hide again. Only losing the
  // URL starts over.
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    if (!sourceUrl) setPainted(false);
  }, [sourceUrl]);
  useEffect(() => {
    if (painted || !src) return;
    const timer = setTimeout(() => setPainted(true), FIRST_PAINT_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [painted, src]);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onLoad = useCallback(() => {
    onFrameLoad();
    setPainted(true);
    requestAnimationFrame(() => onReadyRef.current?.());
  }, [onFrameLoad]);

  return (
    <div
      ref={elRef}
      // tabIndex makes this focusable so the focus handle can park focus here
      // (in the top document) when the frame blurs; outline-none hides the ring.
      tabIndex={-1}
      className={`relative h-full w-full overflow-hidden bg-terminal-bg outline-none ${TERMINAL_BOTTOM_RADIUS_CLASS}`}
      // A cross-origin iframe is an out-of-process frame; Chromium maps pointer
      // events to it relative to its nearest compositing/containing ancestor. If that
      // ancestor is a far-away layout-contained root, clicks land offset by the pane's
      // distance from it. translateZ(0) gives this container its own layer co-located
      // with the frame, collapsing the offset to ~0. It's identity, so
      // getBoundingClientRect (overlay measurement) is unaffected.
      style={{ transform: 'translateZ(0)' }}
      onMouseDown={() => actions.onClickPanel(id)}
    >
      {src ? (
        <iframe
          ref={iframeRef}
          // White for pages that assume a white canvas, once one has loaded.
          className={`block h-full w-full border-0 bg-white${painted ? '' : ' opacity-0'}`}
          src={src}
          title={title ?? liveUrl}
          allow={IFRAME_ALLOW}
          sandbox={IFRAME_SANDBOX}
          {...(resolution.kind === 'proxied' ? { 'data-dormouse-proxy': 'true' } : {})}
          referrerPolicy="strict-origin-when-cross-origin"
          onLoad={onLoad}
        />
      ) : resolution.kind === 'external' ? (
        <ExternalPreviewPrompt
          origin={resolution.origin}
          publicAddress={resolution.publicAddress}
          offer={resolution.offer}
          onAllow={resolution.offer ? async () => {
            // The policy's event re-asks; an offer already allowed meanwhile does not move it.
            if (!await allowNetworks(resolution.offer!.prefixes)) setReloadNonce((n) => n + 1);
          } : undefined}
          onOpenInAgentBrowser={openInAgentBrowser}
          onOpenInBrowser={getPlatform().openExternal ? () => {
            getPlatform().openExternal?.(sourceUrl);
            cancelExternal();
          } : undefined}
          onCancel={cancelExternal}
        />
      ) : (
        <PanelMessage resolution={resolution} url={sourceUrl} onOpenInAgentBrowser={openInAgentBrowser} />
      )}
      {uninstrumented && (
        <PopupButtonRow
          className="absolute inset-x-1 top-1 z-10 flex-wrap"
          role="status"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <span className="min-w-0 flex-1 px-1.5 py-0.5 text-muted">
            Dormouse can’t follow this page — it isn’t an HTML page on the proxy, so the URL bar and leader chord stop at it.
          </span>
          <button type="button" className={popupButton()} onClick={() => chromeActions.reload()}>Reload</button>
          {openInAgentBrowser && (
            <button type="button" className={popupButton()} onClick={openInAgentBrowser}>Open in agent-browser</button>
          )}
          <button type="button" className={popupButton()} aria-label="Dismiss" onClick={() => setUninstrumented(false)}>
            <XIcon size={12} weight="bold" />
          </button>
        </PopupButtonRow>
      )}
      {pendingOpenUrl && (
        <NewTabPrompt
          url={pendingOpenUrl}
          // Where the Wall will open it (`onOpenBrowserPane` decides the same way).
          refusal={agentBrowserCapable ? iframeRefusal(pendingOpenUrl) : null}
          onOpen={() => {
            setPendingOpenUrl(null);
            actions.onOpenBrowserPane?.(id, pendingOpenUrl);
          }}
          onCancel={() => setPendingOpenUrl(null)}
        />
      )}
    </div>
  );
}

// What it asks is where the page is: a public address never frames, and a
// private one frames once its network is allowed, which also lets it reach
// this computer's own services — so the consent names the network, and says so.
export function ExternalPreviewPrompt({ origin, publicAddress, offer, onAllow, onOpenInAgentBrowser, onOpenInBrowser, onCancel }: {
  origin: string;
  /** Some address it is on is public, so no network can be allowed for it. */
  publicAddress: boolean;
  /** This machine's networks holding it, which `onAllow` allows. */
  offer?: IframeNetworkOffer;
  onAllow?: () => Promise<void>;
  onOpenInAgentBrowser?: () => void;
  onOpenInBrowser?: () => void;
  onCancel: () => void;
}) {
  const { busy, error, run } = useBusyAction();
  const press = (action: () => void) => ({
    onMouseDown: (e: MouseEvent) => e.stopPropagation(),
    onClick: (e: MouseEvent) => { e.stopPropagation(); action(); },
  });
  const titleId = useId();
  return (
    <div role="alertdialog" aria-labelledby={titleId} className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-terminal-bg px-6 text-center">
      <div className="max-w-md text-sm text-foreground">
        <div id={titleId} className="font-semibold">{publicAddress ? 'Website on the internet' : 'Page on another device'}</div>
        <div className="mt-1 break-all font-mono text-xs text-muted">{origin}</div>
        <p className="mt-2 text-muted">
          {publicAddress
            ? 'Previews show pages on this computer and on private networks you allow, never the internet.'
            : offer
              ? `It is on ${offer.label} (${offer.prefixes.join(', ')}), which you haven’t allowed. ${ALLOWED_NETWORK_REACH}`
              : `It is on a private network none of this computer’s connections is on. To preview it, add its range in Settings → Network. ${ALLOWED_NETWORK_REACH}`}
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {offer && onAllow && (
          <button type="button" disabled={busy} {...press(() => void run(onAllow))} className={modalActionButton({ tone: 'secondary' })}>
            Allow {offer.label} ({offer.prefixes.join(', ')})
          </button>
        )}
        {onOpenInAgentBrowser && (
          <button type="button" {...press(onOpenInAgentBrowser)} className={modalActionButton({ tone: 'primary' })}>
            Open in agent-browser
          </button>
        )}
        {onOpenInBrowser && (
          <button
            type="button"
            {...press(onOpenInBrowser)}
            className={modalActionButton({ tone: onOpenInAgentBrowser ? 'secondary' : 'primary' })}
          >
            Open in browser
          </button>
        )}
        <button type="button" {...press(onCancel)} className={modalActionButton({ tone: 'secondary' })}>
          Cancel
        </button>
      </div>
      {error ? <div role="alert" className="max-w-md text-sm text-error">{error}</div> : null}
    </div>
  );
}

function NewTabPrompt({ url, refusal, onOpen, onCancel }: {
  url: string;
  /** Why an iframe cannot show it, so it opens in agent-browser instead. */
  refusal: string | null;
  onOpen: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-terminal-bg/95 px-6 text-center">
      <div className="max-w-sm text-sm text-foreground">
        This page wants to open a new tab:
        <div className="mt-1 break-all font-mono text-xs text-muted">{url}</div>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
          className={modalActionButton({ tone: 'primary' })}
        >
          {refusal ? 'Open in agent-browser' : 'Open in new pane'}
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onCancel(); }}
          className={modalActionButton({ tone: 'secondary' })}
        >
          Cancel
        </button>
      </div>
      <div className="text-xs text-muted/80">
        {refusal
          ? `It is an https:// page, and ${refusal}.`
          : 'Pages that open many tabs work better in agent-browser — open the chip → Display.'}
      </div>
    </div>
  );
}

function PanelMessage({ resolution, url, onOpenInAgentBrowser }: {
  resolution: Resolution;
  url: string;
  onOpenInAgentBrowser?: () => void;
}) {
  if (resolution.kind === 'resolving') {
    return <PaneMessage className="text-muted">Connecting to <span className="ml-1 font-semibold">{url}</span>…</PaneMessage>;
  }
  if (resolution.kind === 'empty') {
    return <PaneMessage className="text-muted">No iframe URL was provided.</PaneMessage>;
  }
  // proxied/raw render the iframe itself, never this fallback.
  if (resolution.kind !== 'error') return null;
  // 'error' — the proxy turned a dead end into something actionable. (Unreachable
  // cases are served as a page inside the frame; this covers the synchronous
  // ones, chiefly an unproxyable scheme such as https://.)
  // agent-browser is the remedy only where the URL itself is fine and the proxy
  // can't front it. It refuses a non-http(s) target too (`normalizeConcreteOpenUrl`),
  // so pointing a refused scheme at it would be a dead end.
  const command = <code className="rounded bg-app-bg px-1 py-0.5">dor agent-browser open {url}</code>;
  return (
    <PaneMessage className="text-muted" contentClassName="flex flex-col gap-2">
      <div>{messageFor(resolution)}</div>
      {resolution.reason === 'non-http' ? (
        <div className="text-xs text-muted/80">Enter an http:// address in the URL bar above.</div>
      ) : onOpenInAgentBrowser ? (
        <div className="flex flex-col items-start gap-1.5 text-xs text-muted/80">
          <button
            type="button"
            className={modalActionButton({ tone: 'primary' })}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onOpenInAgentBrowser}
          >
            Open in agent-browser
          </button>
          <span>or run {command}</span>
        </div>
      ) : (
        <div className="text-xs text-muted/80">Open it in agent-browser: {command}</div>
      )}
    </PaneMessage>
  );
}

function messageFor(resolution: Extract<Resolution, { kind: 'error' }>): string {
  switch (resolution.reason) {
    case 'non-http':
    case 'scheme':
      return `Can’t frame this URL — ${resolution.detail ?? IFRAME_HTTP_ONLY}.`;
    case 'unreachable':
    default:
      return resolution.detail ? `Couldn’t reach the server — ${resolution.detail}.` : 'Couldn’t reach the server.';
  }
}
