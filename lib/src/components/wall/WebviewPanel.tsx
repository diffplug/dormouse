/**
 * The `webview` renderer (`docs/specs/webview-pane.md`): a native view the host
 * keeps per Surface id and places over this panel's placeholder. The view is
 * not in the DOM and paints above it, so the placeholder only marks where it
 * goes and shows why it is absent.
 */
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PaneMessage, TERMINAL_BOTTOM_RADIUS_CLASS } from '../design';
import { getPlatform } from '../../lib/platform';
import type { PaneWebviewPage, PaneWebviewRect } from '../../lib/platform/types';
import { registerSurfaceFocusHandle } from '../../lib/terminal-registry';
import { isSeenObserved } from '../../lib/surface-sight';
import { usePaneWebviewsOccluded } from '../../lib/pane-webview-occlusion';
import { setPaneWebviewFocus } from '../../lib/window-focus';
import type { PaneProps } from './pane-props';
import { usePaneChrome } from './use-pane-chrome';
import { useSurfaceSight } from './use-surface-visibility';
import { PaneWriteContext, WallActionsContext } from './wall-context';
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

type Status = { kind: 'opening' } | { kind: 'open' } | { kind: 'error'; error: string };

function chromeOf(page: { url: string; title: string | null }): ChromeSnapshot {
  return { url: page.url, displayUrl: hostPathDisplay(page.url), title: page.title, key: null };
}

export function WebviewPanel({ id, params, parked }: PaneProps) {
  // BrowserPanel mounts this panel only on a host that has pane webviews.
  const host = getPlatform().paneWebview!;
  const actions = useContext(WallActionsContext);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
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

  // Unlike the iframe's, every URL the host reports is persisted: the page
  // cannot forge it.
  const showPage = useCallback((next: PaneWebviewPage) => {
    setPage({ url: next.url, title: next.title || null });
    paneWriteRef.current.setTitle(id, tabDisplayTitle(next));
    const committed = browserSurfaceUrl(next.url);
    if (committed && committed !== urlRef.current) paneWriteRef.current.updateParams(id, { url: committed });
  }, [id]);

  // Opens the view, or adopts the one this Surface already has: it outlives
  // the panel, and only `closeBrowserSurface` destroys it.
  const hasUrl = url !== null;
  useEffect(() => {
    if (!hasUrl) return;
    let live = true;
    setStatus({ kind: 'opening' });
    void host.open(id, urlRef.current!).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setStatus({ kind: 'error', error: result.error });
        return;
      }
      setStatus({ kind: 'open' });
      showPage(result.page);
    });
    return () => { live = false; };
  }, [host, id, hasUrl, attempt, showPage]);

  useEffect(() => {
    const unsubscribe = host.onEvent((event) => {
      if (event.id !== id) return;
      switch (event.kind) {
        case 'page': showPage(event); break;
        case 'pointerdown': actionsRef.current.onClickPanel(id); break;
        case 'leader': actionsRef.current.onFrameLeader(); break;
        case 'focus': setPaneWebviewFocus(id, event.focused); break;
        case 'open-window': {
          const next = browserSurfaceUrl(event.url);
          if (next) setPendingOpenUrl(next);
          break;
        }
      }
    });
    // An unmounted panel's view is hidden, and a hidden view never holds focus.
    return () => { unsubscribe(); setPaneWebviewFocus(id, false); };
  }, [host, id, showPage]);

  // Shown only while its pane is in sight and no overlay is open, following
  // the placeholder's laid-out rect every frame.
  const seen = isSeenObserved(useSurfaceSight(parked, id));
  const occluded = usePaneWebviewsOccluded();
  const shown = seen && !occluded && status.kind === 'open' && url !== null;
  useLayoutEffect(() => {
    if (!shown) return;
    let frame = 0;
    let placed: PaneWebviewRect | null = null;
    const follow = () => {
      const box = elRef.current!.getBoundingClientRect();
      if (!placed || placed.x !== box.x || placed.y !== box.y || placed.width !== box.width || placed.height !== box.height) {
        placed = { x: box.x, y: box.y, width: box.width, height: box.height };
        host.place(id, placed);
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => {
      cancelAnimationFrame(frame);
      host.place(id, null);
    };
  }, [host, id, shown]);

  useEffect(() => {
    if (status.kind !== 'open') return;
    return registerSurfaceFocusHandle(id, {
      // The app document's focus parks here first, so when the keyboard comes
      // back to the app webview it lands on this pane, not on what had it before.
      focus: () => {
        elRef.current?.focus({ preventScroll: true });
        host.focus(id);
      },
      blur: () => host.focus(null),
    });
  }, [host, id, status.kind]);

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
      if (statusRef.current.kind !== 'error' && urlRef.current !== null) host.navigate(id, next);
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
  const pageRef = useRef(page);
  pageRef.current = page;
  const registrationRef = useRef<ScreenRegistration | null>(null);
  useEffect(() => {
    const registration = registerAgentBrowserScreen(id, {
      snapshot: { renderMode: 'webview', viewport: { w: 0, h: 0, dpr: 1 }, syncEngaged: false },
      actions: screenActions,
      chrome: chromeOf(pageRef.current),
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
      ) : null}
      {pendingOpenUrl && (
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
