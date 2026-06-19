import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { TERMINAL_BOTTOM_RADIUS_CLASS } from '../design';
import { getPlatform } from '../../lib/platform';
import { registerProxyOrigin } from '../../lib/iframe-proxy-registry';
import { registerSurfaceFocusHandle } from '../../lib/terminal-registry';
import type { IframeProxyResult } from '../../lib/platform/types';
import { usePaneChrome } from './use-pane-chrome';
import { WallActionsContext } from './wall-context';
import {
  openAgentBrowserScreenModal,
  registerAgentBrowserScreen,
  type ChromeActions,
  type ScreenActions,
  type ScreenRegistration,
} from './agent-browser-screen';
import { hostPathDisplay } from './browser-url';

type IframePanelParams = {
  surfaceType?: string;
  url?: string;
};

// Sandbox the proxied frame so a tool's `if (top !== self) top.location = …`
// framebust cannot navigate the Wall away — allow-top-navigation is omitted on
// purpose (docs/specs/dor-browser.md → "Iframe Renderer"). Everything else a local
// dev tool needs is granted; allow-same-origin is safe here because the frame's
// origin (the loopback proxy) is never same-origin with the host webview.
const PROXY_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads';
const IFRAME_ALLOW = 'autoplay; clipboard-read; clipboard-write; fullscreen; geolocation; microphone; camera';

type Resolution =
  | { kind: 'empty' }
  | { kind: 'resolving' }
  | { kind: 'proxied'; src: string; origin: string }
  // The host can't run a proxy (e.g. the web host) — keep the blind raw-iframe
  // fallback rather than hiding the surface (Open Decision #4).
  | { kind: 'raw'; src: string }
  | { kind: 'error'; reason: 'frame-refused' | 'unreachable' | 'scheme'; detail?: string };

type IframeHistory = {
  entries: string[];
  index: number;
};

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

export function IframePanel({ api, params }: IDockviewPanelProps<IframePanelParams>) {
  const actions = useContext(WallActionsContext);
  const elRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  usePaneChrome(api, elRef);
  const sourceUrl = typeof params?.url === 'string' ? params.url : '';
  const [liveUrl, setLiveUrl] = useState(sourceUrl);
  // A new-tab/window request from the proxy shim, pending the user's choice to
  // open it as a new pane (docs/specs/dor-browser.md → "Iframe Shim").
  const [pendingOpenUrl, setPendingOpenUrl] = useState<string | null>(null);
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
    if (persist) api.updateParameters({ url: nextUrl });
    api.setTitle?.(hostPathDisplay(nextUrl, true));
  }, [api]);

  const commitUrl = useCallback((nextUrl: string) => applyFrameUrl(nextUrl, true), [applyFrameUrl]);
  const observeFrameUrl = useCallback((nextUrl: string) => applyFrameUrl(nextUrl, false), [applyFrameUrl]);

  const goToHistoryIndex = useCallback((nextIndex: number) => {
    const prev = historyRef.current;
    if (nextIndex < 0 || nextIndex >= prev.entries.length) return;
    const nextUrl = prev.entries[nextIndex];
    setLiveUrl(nextUrl);
    setHistory({ ...prev, index: nextIndex });
    api.updateParameters({ url: nextUrl });
    api.setTitle?.(hostPathDisplay(nextUrl, true));
    // Force a proxy re-resolution so the frame actually reloads. After an
    // observed in-frame navigation, params.url stays at the source URL, so a
    // Back to that same URL is a no-op write — without bumping the nonce the
    // proxy effect (deps: sourceUrl, reloadNonce) wouldn't re-fire and the frame
    // would keep showing the navigated page while the chrome shows the target.
    setReloadNonce((n) => n + 1);
  }, [api]);

  // Ask the host to front the target with its transparent proxy. The returned
  // URL is a loopback origin that serves the page's bytes (instrumented for
  // loopback) so Dormouse — now the server — gets a keyboard side-channel, an
  // accurate focus model, and real error pages. Reachability/frame-refusal are
  // diagnosed by the proxy and shown as a served page inside the frame.
  const [resolution, setResolution] = useState<Resolution>(() => (sourceUrl ? { kind: 'resolving' } : { kind: 'empty' }));
  useEffect(() => {
    if (!sourceUrl) {
      setResolution({ kind: 'empty' });
      return;
    }
    const createProxy = getPlatform().createIframeProxyUrl;
    if (!createProxy) {
      setResolution({ kind: 'raw', src: sourceUrl });
      return;
    }
    let cancelled = false;
    setResolution({ kind: 'resolving' });
    createProxy(sourceUrl).then(
      (result: IframeProxyResult) => {
        if (cancelled) return;
        if (result.ok) setResolution({ kind: 'proxied', src: result.url, origin: originOf(result.url) });
        else setResolution({ kind: 'error', reason: result.reason, detail: result.detail });
      },
      () => {
        if (!cancelled) setResolution({ kind: 'error', reason: 'unreachable' });
      },
    );
    return () => { cancelled = true; };
  }, [sourceUrl, reloadNonce]);

  // Register a screen controller so the embed surface shows the unified
  // browser chrome (URL + the far-left chip → Display modal) and can swap back
  // to a live screencast. Gated on the host being able to spawn an
  // agent-browser (agentBrowserOpen) — without it there's no screencast to
  // swap to, so the embed surface keeps its plain title (e.g. the web host).
  const swapCapable = !!getPlatform().agentBrowserOpen;
  const screenActions = useMemo<ScreenActions>(() => ({
    engageSync() {},
    applyDevice() {},
    applyViewport() {},
    openModal() { openAgentBrowserScreenModal(api.id); },
    // iframe is the current backend; ab-screencast / ab-popout swap to
    // agent-browser. Wired only when the host can spawn one — without it the
    // modal hides its Render section, but the chrome (URL/nav) still shows.
    setRenderMode: swapCapable
      ? (mode) => { if (mode !== 'iframe') actionsRef.current.onSwapRenderMode(api.id, mode); }
      : undefined,
  }), [api.id, swapCapable]);
  const chromeActions = useMemo<ChromeActions>(() => ({
    navigate(next) { commitUrl(next); },
    back() { goToHistoryIndex(historyIndexRef.current - 1); },
    forward() { goToHistoryIndex(historyIndexRef.current + 1); },
    reload() { setReloadNonce((n) => n + 1); },
  }), [commitUrl, goToHistoryIndex]);
  const registrationRef = useRef<ScreenRegistration | null>(null);
  // Register the screen controller unconditionally so the browser chrome (URL +
  // far-left chip) shows for every iframe surface, on every host — `dor iframe`
  // is a full browser-chrome tab, not a lesser one (docs/specs/dor-browser.md).
  // The render-swap action is gated separately (screenActions.setRenderMode).
  useEffect(() => {
    const registration = registerAgentBrowserScreen(api.id, {
      snapshot: {
        state: 'SYNCED',
        renderMode: 'iframe',
        viewport: { w: 0, h: 0, dpr: 1 },
        paneCss: { w: 0, h: 0 },
        displayDpr: 1,
        syncEngaged: false,
      },
      actions: screenActions,
      chrome: { url: liveUrl, displayUrl: hostPathDisplay(liveUrl), title: api.title ?? null, key: null },
      chromeActions,
      hostCapable: false,
      // embed→popout spawns the new agent-browser headed and mounts it
      // popped-out, so it needs both spawn and pop-out host capabilities.
      canPopOut: !!getPlatform().agentBrowserPopOut,
    });
    registrationRef.current = registration;
    return () => { registration.dispose(); registrationRef.current = null; };
  }, [api.id, swapCapable, screenActions, chromeActions]);
  // Keep the header's URL current as navigation and in-frame location changes
  // land. The iframe src is still driven only by sourceUrl.
  useEffect(() => {
    registrationRef.current?.updateChrome({ url: liveUrl, displayUrl: hostPathDisplay(liveUrl), title: api.title ?? null, key: null });
  }, [liveUrl, api.title]);

  // Trust postMessage from this frame's origin (validated by the Wall's
  // keyboard/focus/location channel) only while the proxied surface is live.
  const proxyOrigin = resolution.kind === 'proxied' ? resolution.origin : null;
  useEffect(() => {
    if (!proxyOrigin) return;
    return registerProxyOrigin(proxyOrigin);
  }, [proxyOrigin]);

  // A cross-origin click reaches only the frame, so the Wall never sees the
  // mousedown — and on WebKit the iframe element's own `focus` event doesn't
  // fire for it either. The shim posts `pointerdown` from inside the frame;
  // adopt it as entering the pane (select + passthrough), exactly like clicking
  // any other pane. Only genuine clicks emit `pointerdown`, so command-mode
  // arrow navigation never triggers it, and onClickPanel is idempotent for
  // repeat clicks. (We can't gate on dockview's `api.isActive`: in a split each
  // sole panel is always "active" within its own group.)
  useEffect(() => {
    if (!proxyOrigin) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== proxyOrigin) return;
      const data = e.data as { __dormouse?: unknown; url?: unknown } | null;
      if (data?.__dormouse === 'pointerdown') {
        actions.onClickPanel(api.id);
        return;
      }
      if (data?.__dormouse === 'open-window' && typeof data.url === 'string') {
        // Single-frame renderer: a new-tab/window request becomes a new pane.
        // Map a proxy-origin URL back to the upstream; pass externals through.
        const mapped = upstreamUrlFromFrameLocation(data.url, liveUrl || sourceUrl, proxyOrigin) ?? data.url;
        setPendingOpenUrl(mapped);
        return;
      }
      if (data?.__dormouse === 'location') {
        const nextUrl = upstreamUrlFromFrameLocation(data.url, liveUrl || sourceUrl, proxyOrigin);
        if (nextUrl) observeFrameUrl(nextUrl);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [api, proxyOrigin, actions, liveUrl, sourceUrl, observeFrameUrl]);

  // Raw fallback frames have no injected shim, but focusing a cross-origin
  // iframe still blurs the parent window while the document itself remains
  // focused. Adopt that as entering the pane so hosts without a proxy keep the
  // same click/focus behavior, albeit without the proxied leader side-channel.
  useEffect(() => {
    if (resolution.kind !== 'raw') return;
    const onWindowBlur = () => {
      if (document.hasFocus() && document.activeElement === iframeRef.current) {
        actions.onClickPanel(api.id);
      }
    };
    window.addEventListener('blur', onWindowBlur);
    return () => window.removeEventListener('blur', onWindowBlur);
  }, [api.id, resolution.kind, actions]);

  // Register a focus handle so onClickPanel → enterTerminalMode can focus the
  // frame like any other surface (spec → "#3"), and exitTerminalMode can hand
  // focus back. Focusing the element moves keyboard focus into the frame.
  useEffect(() => {
    if (resolution.kind !== 'proxied' && resolution.kind !== 'raw') return;
    return registerSurfaceFocusHandle(api.id, {
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
  }, [api.id, resolution.kind]);

  const src = resolution.kind === 'proxied' || resolution.kind === 'raw' ? resolution.src : '';

  return (
    <div
      ref={elRef}
      // tabIndex makes this focusable so the focus handle can park focus here
      // (in the top document) when the frame blurs; outline-none hides the ring.
      tabIndex={-1}
      className={`relative h-full w-full overflow-hidden bg-terminal-bg outline-none ${TERMINAL_BOTTOM_RADIUS_CLASS}`}
      // A cross-origin iframe is an out-of-process frame; Chromium maps pointer
      // events to it relative to its nearest compositing/containing ancestor.
      // Dockview's root (.dv-dockview) sets `contain: layout`, so without this
      // the frame's reference is that far-away root and clicks land offset by the
      // pane's distance from it. translateZ(0) gives this container its own layer
      // co-located with the frame, collapsing the offset to ~0. It's identity, so
      // getBoundingClientRect (overlay measurement) is unaffected.
      style={{ transform: 'translateZ(0)' }}
      onMouseDown={() => actions.onClickPanel(api.id)}
    >
      {src ? (
        <iframe
          ref={iframeRef}
          className="block h-full w-full border-0 bg-white"
          src={src}
          title={api.title ?? liveUrl}
          allow={IFRAME_ALLOW}
          {...(resolution.kind === 'proxied' ? { sandbox: PROXY_SANDBOX, 'data-dormouse-proxy': 'true' } : {})}
          referrerPolicy="strict-origin-when-cross-origin"
        />
      ) : (
        <PanelMessage resolution={resolution} url={sourceUrl} />
      )}
      {pendingOpenUrl && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-terminal-bg/95 px-6 text-center">
          <div className="max-w-sm text-sm text-foreground">
            This page wants to open a new tab:
            <div className="mt-1 break-all font-mono text-xs text-muted">{pendingOpenUrl}</div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const u = pendingOpenUrl;
                setPendingOpenUrl(null);
                if (u) actions.onOpenBrowserPane?.(api.id, u);
              }}
              className="rounded border border-border px-2.5 py-1 text-sm text-foreground transition-colors hover:border-foreground"
            >
              Open in new pane
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); setPendingOpenUrl(null); }}
              className="rounded border border-border px-2.5 py-1 text-sm text-muted transition-colors hover:text-foreground"
            >
              Cancel
            </button>
          </div>
          <div className="text-xs text-muted/80">
            Pages that open many tabs work better in agent-browser — open the chip → Render.
          </div>
        </div>
      )}
    </div>
  );
}

function PanelMessage({ resolution, url }: { resolution: Resolution; url: string }) {
  const base = 'flex h-full w-full items-center justify-center bg-terminal-bg px-6 text-center text-sm text-muted';

  if (resolution.kind === 'resolving') {
    return <div className={base}>Connecting to <span className="ml-1 font-semibold">{url}</span>…</div>;
  }
  if (resolution.kind === 'empty') {
    return <div className={base}>No iframe URL was provided.</div>;
  }
  // proxied/raw render the iframe itself, never this fallback.
  if (resolution.kind !== 'error') return null;
  // 'error' — the proxy turned a dead end into something actionable. (Most
  // unreachable/frame-refused cases are served as a page inside the frame; this
  // covers the synchronous ones, chiefly an unproxyable scheme.)
  return (
    <div className={`${base} flex-col gap-2`}>
      <div>{messageFor(resolution)}</div>
      <div className="text-xs text-muted/80">
        For arbitrary web pages, use <code className="rounded bg-app-bg px-1 py-0.5">dor ab open {url}</code>
      </div>
    </div>
  );
}

function messageFor(resolution: Extract<Resolution, { kind: 'error' }>): string {
  switch (resolution.reason) {
    case 'scheme':
      return resolution.detail
        ? `Can’t frame this URL — ${resolution.detail}.`
        : 'The iframe surface only frames local http:// servers.';
    case 'frame-refused':
      return 'This page refuses to be embedded in a frame.';
    case 'unreachable':
    default:
      return resolution.detail ? `Couldn’t reach the server — ${resolution.detail}.` : 'Couldn’t reach the server.';
  }
}
