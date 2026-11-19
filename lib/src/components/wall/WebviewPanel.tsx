/**
 * The `webview` renderer (`docs/specs/webview-pane.md`): a native view the host
 * keeps per Surface id and places over this panel's placeholder. The view is
 * not in the DOM and paints above it, so the placeholder only marks where it
 * goes and shows why it is absent.
 */
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PaneMessage, TERMINAL_BOTTOM_RADIUS_CLASS } from '../design';
import { getPlatform } from '../../lib/platform';
import type { PaneWebviewPage } from '../../lib/platform/types';
import { rectsEqual } from '../../lib/rect-tween';
import { registerSurfaceFocusHandle } from '../../lib/terminal-registry';
import { isSeenObserved } from '../../lib/surface-sight';
import { usePaneWebviewsOccluded } from '../../lib/pane-webview-occlusion';
import { setPaneWebviewFocus } from '../../lib/window-focus';
import type { PaneProps } from './pane-props';
import { usePaneChrome } from './use-pane-chrome';
import { useSurfaceSight } from './use-surface-visibility';
import { PaneWriteContext, PassthroughPaneIdContext, WallActionsContext } from './wall-context';
import {
  openAgentBrowserScreenModal,
  registerAgentBrowserScreen,
  type ChromeActions,
  type ChromeSnapshot,
  type ScreenActions,
  type ScreenRegistration,
} from './agent-browser-screen';
import { offeredRenderModes } from './browser-automation';
import { browserSurfaceUrl, hostPathDisplay, tabDisplayTitle } from './browser-url';
import { NewTabPrompt } from './IframePanel';

/** How long a pane's rect must hold still before its page is worth a still. */
const STILL_AFTER_MOVE_MS = 300;

type Status = { kind: 'opening' } | { kind: 'open' } | { kind: 'error'; error: string };

function chromeOf(page: { url: string; title: string | null }): ChromeSnapshot {
  return { url: page.url, displayUrl: hostPathDisplay(page.url), title: page.title, key: null };
}

/** The app's CSP admits no `data:` image, so a still is decoded for a canvas. */
async function decodeStill(url: string | null): Promise<ImageBitmap | null> {
  if (!url) return null;
  try {
    const bytes = Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
    return await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  } catch {
    return null;
  }
}

function Still({ image }: { image: ImageBitmap }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => { ref.current!.getContext('2d')?.drawImage(image, 0, 0); }, [image]);
  return (
    <canvas
      ref={ref}
      width={image.width}
      height={image.height}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full object-cover object-left-top"
    />
  );
}

export function WebviewPanel({ id, params, parked }: PaneProps) {
  // BrowserPanel mounts this panel only on a host that has pane webviews.
  const host = getPlatform().paneWebview!;
  const actions = useContext(WallActionsContext);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const passthroughPaneId = useContext(PassthroughPaneIdContext);
  const paneWrite = useContext(PaneWriteContext);
  const paneWriteRef = useRef(paneWrite);
  paneWriteRef.current = paneWrite;
  const elRef = useRef<HTMLDivElement>(null);
  usePaneChrome(id, elRef);

  const rawUrl = typeof params?.url === 'string' ? params.url : '';
  const url = browserSurfaceUrl(rawUrl);
  const urlRef = useRef(url);
  urlRef.current = url;
  const [status, setStatus] = useState<Status>({ kind: 'opening' });
  const statusRef = useRef(status);
  statusRef.current = status;
  // Bumped to open again after a failure.
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<{ url: string; title: string | null }>(() => ({ url: url ?? rawUrl, title: null }));
  const [pendingOpenUrl, setPendingOpenUrl] = useState<string | null>(null);
  // A URL-bar entry made while the view is opening, which the host would drop.
  const pendingNavRef = useRef<string | null>(null);
  // A still of the page the placeholder shows while the view is hidden. Hiding
  // never waits for one, so it is taken while the view is shown, as the user
  // leaves the page: before any overlay can open. It never outlives its page.
  const [still, setStill] = useState<ImageBitmap | null>(null);
  const pageUrlRef = useRef(page.url);
  const shownRef = useRef(false);
  const takeStill = useCallback(() => {
    if (!shownRef.current) return;
    const at = pageUrlRef.current;
    void host.snapshot(id).then(decodeStill).then((image) => { if (image && pageUrlRef.current === at) setStill(image); });
  }, [host, id]);

  // Unlike the iframe's, every URL the host reports is persisted: the page
  // cannot forge it.
  const showPage = useCallback((next: PaneWebviewPage) => {
    if (!next.url) return;
    if (next.url !== pageUrlRef.current) setStill(null);
    pageUrlRef.current = next.url;
    setPage({ url: next.url, title: next.title || null });
    paneWriteRef.current.setTitle(id, tabDisplayTitle(next));
    const committed = browserSurfaceUrl(next.url);
    if (committed && committed !== urlRef.current) paneWriteRef.current.updateParams(id, { url: committed });
  }, [id]);

  // A first load that fails leaves the view with no page at all. It is closed,
  // so that Reload opens a new one rather than adopting it.
  const settle = useCallback((next: PaneWebviewPage) => {
    if (next.url || next.loading) {
      showPage(next);
      // A page nobody points at or types in still needs a still to hide behind.
      if (!next.loading) takeStill();
      return;
    }
    host.close(id);
    setStill(null);
    setStatus({ kind: 'error', error: 'it did not load' });
  }, [host, id, showPage, takeStill]);
  // What the host last reported while the view was opening: it can be newer
  // than the page `open` answers with, and is not reported again.
  const reportedRef = useRef<PaneWebviewPage | null>(null);

  // Opens the view, or adopts the one this Surface already has: it outlives
  // the panel, and only `closeBrowserSurface` destroys it.
  const hasUrl = url !== null;
  useEffect(() => {
    if (!hasUrl) return;
    let live = true;
    reportedRef.current = null;
    setStatus({ kind: 'opening' });
    void host.open(id, urlRef.current!).then((result) => {
      if (!live) return;
      // A failed open drops the entry, which no later open should take.
      const entry = pendingNavRef.current;
      pendingNavRef.current = null;
      if (!result.ok) {
        setStatus({ kind: 'error', error: result.error });
        return;
      }
      // Read by the event listener before the next render.
      statusRef.current = { kind: 'open' };
      setStatus(statusRef.current);
      if (entry) {
        showPage(result.page);
        host.navigate(id, entry);
      } else settle(reportedRef.current ?? result.page);
    });
    return () => { live = false; };
  }, [host, id, hasUrl, attempt, showPage, settle]);

  useEffect(() => {
    const unsubscribe = host.onEvent((event) => {
      if (event.id !== id) return;
      switch (event.kind) {
        case 'page':
          if (statusRef.current.kind === 'open') settle(event);
          else reportedRef.current = event;
          break;
        case 'pointerdown': actionsRef.current.onClickPanel(id); break;
        case 'pointerleave': takeStill(); break;
        case 'leader': actionsRef.current.onFrameLeader(); break;
        case 'focus':
          setPaneWebviewFocus(id, event.focused);
          if (!event.focused) takeStill();
          break;
        case 'open-window': {
          // Its prompt hides every pane webview, so only a page on screen may raise it.
          const next = shownRef.current ? browserSurfaceUrl(event.url) : null;
          if (next) setPendingOpenUrl(next);
          break;
        }
      }
    });
    // An unmounted panel's view is hidden, and a hidden view never holds focus.
    return () => { unsubscribe(); setPaneWebviewFocus(id, false); };
  }, [host, id, settle, takeStill]);

  // Shown only while its pane is in sight and no overlay is open, following
  // the placeholder's laid-out rect every frame.
  const seen = isSeenObserved(useSurfaceSight(parked, id));
  const occluded = usePaneWebviewsOccluded();
  const shown = seen && !occluded && status.kind === 'open' && url !== null;
  shownRef.current = shown;
  // The view has the keyboard only while it is shown and its pane is the one
  // in passthrough. Selection can leave without a press in the app webview (a
  // header chip, `dor`), and nothing else would take the keyboard back.
  const keyboard = shown && !parked && passthroughPaneId === id;
  const keyboardRef = useRef(keyboard);
  keyboardRef.current = keyboard;
  // The app document's focus parks on the placeholder first, so when the
  // keyboard comes back to the app webview it lands on this pane.
  const takeKeyboard = useCallback(() => {
    elRef.current?.focus({ preventScroll: true });
    host.focus(id);
  }, [host, id]);
  useEffect(() => {
    if (!keyboard) return;
    takeKeyboard();
    return () => host.focus(null);
  }, [host, keyboard, takeKeyboard]);

  useLayoutEffect(() => {
    if (!shown) return;
    let frame = 0;
    let placed: DOMRect | null = null;
    // A still taken at another size shows the page laid out for that size.
    let resettled: ReturnType<typeof setTimeout> | undefined;
    const follow = () => {
      const box = elRef.current!.getBoundingClientRect();
      if (!placed || !rectsEqual(placed, box)) {
        placed = box;
        host.place(id, { x: box.x, y: box.y, width: box.width, height: box.height });
        clearTimeout(resettled);
        resettled = setTimeout(takeStill, STILL_AFTER_MOVE_MS);
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(resettled);
      host.place(id, null);
    };
  }, [host, id, shown, takeStill]);

  useEffect(() => {
    if (status.kind !== 'open') return;
    return registerSurfaceFocusHandle(id, {
      // The Wall defers its focus calls by a frame, and one for a pane that
      // has since lost passthrough would take the keyboard from its successor.
      focus: () => { if (keyboardRef.current) takeKeyboard(); },
      blur: () => host.focus(null),
    });
  }, [host, id, status.kind, takeKeyboard]);

  const renderModes = useMemo(() => offeredRenderModes(false, null), []);
  const screenActions = useMemo<ScreenActions>(() => ({
    engageSync() {},
    openModal() { openAgentBrowserScreenModal(id); },
    setRenderMode(mode, opts) {
      if (mode === 'webview' || !renderModes.includes(mode)) return;
      if (opts?.viewport) actionsRef.current.onSwapRenderMode(id, mode, opts.viewport);
      else actionsRef.current.onSwapRenderMode(id, mode);
    },
  }), [id, renderModes]);
  // With no view to navigate, a URL-bar entry is where one opens.
  const chromeActions = useMemo<ChromeActions>(() => ({
    navigate(next) {
      if (statusRef.current.kind === 'open') host.navigate(id, next);
      else if (statusRef.current.kind === 'opening' && urlRef.current !== null) pendingNavRef.current = next;
      else {
        paneWriteRef.current.updateParams(id, { url: next });
        setAttempt((n) => n + 1);
      }
    },
    back() { if (statusRef.current.kind === 'open') host.history(id, 'back'); },
    forward() { if (statusRef.current.kind === 'open') host.history(id, 'forward'); },
    reload() {
      if (statusRef.current.kind === 'open') host.history(id, 'reload');
      else setAttempt((n) => n + 1);
    },
  }), [host, id]);
  const registrationRef = useRef<ScreenRegistration | null>(null);
  useEffect(() => {
    const registration = registerAgentBrowserScreen(id, {
      snapshot: { renderMode: 'webview', viewport: { w: 0, h: 0, dpr: 1 }, syncEngaged: false },
      actions: screenActions,
      chrome: chromeOf(page),
      chromeActions,
      hostCapable: false,
      renderModes,
      // A webview renders at the pane size, so a swap to screencast follows it.
      viewportSetting: () => ({ mode: 'pane-sync' }),
    });
    registrationRef.current = registration;
    return () => { registration.dispose(); registrationRef.current = null; };
  }, [id, screenActions, chromeActions, renderModes]);
  useEffect(() => {
    registrationRef.current?.updateChrome(chromeOf(page));
  }, [page]);

  return (
    <div
      ref={elRef}
      // Focusable so the focus handle can park the app document's focus here.
      tabIndex={-1}
      className={`relative h-full w-full overflow-hidden bg-terminal-bg outline-none ${TERMINAL_BOTTOM_RADIUS_CLASS}`}
      onMouseDown={() => actions.onClickPanel(id)}
    >
      {!rawUrl ? (
        <PaneMessage className="text-muted">No URL was provided.</PaneMessage>
      ) : url === null ? (
        <PaneMessage className="text-muted" contentClassName="flex flex-col gap-2">
          <div>Can’t open this URL — a webview opens http:// and https:// pages only.</div>
          <div className="text-xs text-muted/80">Enter an http:// or https:// address in the URL bar above.</div>
        </PaneMessage>
      ) : status.kind === 'error' ? (
        <PaneMessage className="text-muted">Couldn’t open the page — {status.error}.</PaneMessage>
      ) : still && !shown && status.kind === 'open' ? (
        <Still image={still} />
      ) : null}
      {pendingOpenUrl && seen && (
        <NewTabPrompt
          url={pendingOpenUrl}
          refusal={null}
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
