/**
 * Live agent-browser session viewer (see docs/specs/dor-browser.md).
 *
 * This component is a THIN VIEW. All the non-React lifecycle — the stream
 * connection + screenshot loop, viewport-sync state machine, pop-out/pop-in
 * orchestration + auto-revert, CDP observer, canonical-URL tracking, input
 * bridging, params persistence, and the screen/chrome registration — lives in a
 * surface-id-keyed controller registry (`agent-browser-surface-controller.ts`,
 * mirroring `terminal-lifecycle.ts`). The controller outlives panel unmount; the
 * view just mounts a canvas, feeds params/visibility, forwards DOM input, and
 * subscribes to one snapshot via `useSyncExternalStore`.
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { clsx } from 'clsx';
import { TERMINAL_BOTTOM_RADIUS_CLASS } from '../design';
import { getPlatform } from '../../lib/platform';
import { isEditableTarget } from '../../lib/dom';
import type { RenderMode } from './agent-browser-screen';
import { hostPathDisplay } from './browser-url';
import { resolveRenderMode } from './browser-surface';
import { MOUSE_BUTTONS, MOUSE_BUTTON_MASKS, modifiers } from './agent-browser-input';
import type { AgentBrowserTab as StreamTab } from './agent-browser-connection';
import {
  acquireAgentBrowserSurfaceController,
  type AgentBrowserSurfaceParams,
} from './agent-browser-surface-controller';
// Re-exported so existing importers (notably the panel test) keep resolving the
// park delay from here even though it now lives on the controller.
export { HIDDEN_PARK_DELAY_MS } from './agent-browser-surface-controller';
import { usePaneChrome } from './use-pane-chrome';
import { useSurfaceVisibility } from './use-surface-visibility';
import {
  ModeContext,
  SelectedIdContext,
  WallActionsContext,
} from './wall-context';

type AgentBrowserPanelParams = AgentBrowserSurfaceParams;

function tabDisplayTitle(tab: StreamTab): string {
  const title = tab.title?.trim();
  if (title) return title;
  return hostPathDisplay(tab.url) || 'untitled';
}

export function AgentBrowserPanel({ api, params, renderMode: renderModeProp }: IDockviewPanelProps<AgentBrowserPanelParams> & { renderMode?: RenderMode }) {
  const actions = useContext(WallActionsContext);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const mode = useContext(ModeContext);
  const selectedId = useContext(SelectedIdContext);
  const elRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  usePaneChrome(api, elRef);

  const session = params?.session;
  const wsPort = params?.wsPort;
  const binaryPath = params?.binaryPath;
  const url = params?.url;
  const key = params?.key;
  const syncEngaged = params?.syncEngaged;
  // poppedOut is derived from the canonical renderMode the shell passes; fall
  // back to resolving it from params for a direct mount (tests) / legacy blob.
  const seededMode = renderModeProp ?? resolveRenderMode(params);

  // The surface-scoped controller: get-or-create, keyed by surface id. Survives
  // this component's unmount (minimize, layout churn, StrictMode).
  const controller = useMemo(
    () => acquireAgentBrowserSurfaceController(api.id, { ...params, renderMode: seededMode }),
    // Only the id identifies the controller; later param changes flow through
    // updateParams below (acquire is get-or-create and ignores params when the
    // controller already exists).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api.id],
  );

  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const { tabs, status, connectionLost, hasFrame, poppedOut, streamPort } = snapshot;

  const interactive = mode === 'passthrough' && selectedId === api.id;
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  // A direct mouse click on the canvas should reach the page even when this pane
  // isn't the selected one yet — the click is what selects it (via the root
  // `onClickPanel`), but `selectedId` only updates on the next render, so gating
  // mouse-down/up on `interactive` would swallow the very first click on a
  // freshly-opened surface. Mouse forwarding therefore only requires passthrough
  // mode; keyboard/wheel still require full `interactive` so a background pane
  // never steals them.
  const passthrough = mode === 'passthrough';
  const passthroughRef = useRef(passthrough);
  passthroughRef.current = passthrough;

  // Feed later param changes into the controller (diffed internally).
  useEffect(() => {
    controller.updateParams({ session, wsPort, binaryPath, url, syncEngaged, key, renderMode: seededMode });
  }, [controller, session, wsPort, binaryPath, url, syncEngaged, key, seededMode]);

  // Lend the controller this view's live DOM bindings. Last attach wins; the
  // detach is identity-guarded inside the controller so a stale StrictMode
  // teardown can't unbind a newer view.
  useEffect(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return;
    const handle = controller.attachView({
      canvas,
      viewport,
      updateParameters: (next) => api.updateParameters(next),
      setTitle: (title) => api.setTitle(title),
      requestIframeSwap: () => {
        // The iframe renderer is single-frame: only the active tab survives.
        // Warn + require a typed confirm when other tabs would be closed.
        if (controller.snapshot().tabs.length >= 2) setPendingIframeSwap(true);
        else actionsRef.current.onSwapRenderMode(api.id, 'iframe');
      },
    });
    return () => handle.detach();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, api]);

  // Feed effective on-screen visibility (dockview active tab AND foreground
  // window) so the controller can park a hidden pane after the debounce.
  const visible = useSurfaceVisibility(api);
  useEffect(() => {
    controller.setVisible(visible);
  }, [controller, visible]);

  // Crossing to the single-frame iframe renderer closes all but the active tab;
  // when others are open the swap is gated behind a typed confirm (overlay below).
  const [pendingIframeSwap, setPendingIframeSwap] = useState(false);
  const swapConfirmRef = useRef<HTMLDivElement>(null);

  // --- input forwarding (stream-native input_* messages) ---

  const toDevice = useCallback((e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.width || !canvas.height) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    // Map into frame pixels (the canvas intrinsic grid), then apply ONE uniform
    // frame→CSS-pixel scale derived from the widths. The frame can be SHORTER
    // than the viewport (observed 1280×577 vs a 1280×720 device), so scaling y by
    // deviceHeight/rect.height stretches clicks downward — frame pixels map 1:1
    // onto viewport CSS pixels, top-aligned.
    const deviceWidth = controller.getDeviceSize().width;
    const frameToDevice = deviceWidth ? deviceWidth / canvas.width : 1;
    return {
      x: Math.round((e.clientX - rect.left) * (canvas.width / rect.width) * frameToDevice),
      y: Math.round((e.clientY - rect.top) * (canvas.height / rect.height) * frameToDevice),
    };
  }, [controller]);

  const buttonsHeldRef = useRef(0);
  const lastMoveRef = useRef(0);
  const lastClickRef = useRef({ t: 0, x: 0, y: 0, count: 0, button: -1 });

  const clickCountFor = (button: number, x: number, y: number): number => {
    const last = lastClickRef.current;
    const now = performance.now();
    const sameSpot = Math.abs(x - last.x) < 5 && Math.abs(y - last.y) < 5;
    if (now - last.t < 500 && sameSpot && button === last.button) {
      last.count = Math.min(3, last.count + 1);
    } else {
      lastClickRef.current = { t: now, x, y, count: 1, button };
    }
    lastClickRef.current.t = now;
    return lastClickRef.current.count;
  };

  const onCanvasMouseDown = (e: React.MouseEvent) => {
    if (!passthroughRef.current) return;
    // preventDefault stops the browser's focus-shift default action (a click on a
    // non-focusable canvas would otherwise blur to <body>), and the explicit
    // focus claims keystrokes for this pane.
    e.preventDefault();
    elRef.current?.focus({ preventScroll: true });
    const point = toDevice(e);
    if (!point) return;
    buttonsHeldRef.current |= MOUSE_BUTTON_MASKS[e.button] ?? 0;
    controller.send({
      type: 'input_mouse',
      eventType: 'mousePressed',
      x: point.x,
      y: point.y,
      button: MOUSE_BUTTONS[e.button] ?? 'left',
      buttons: buttonsHeldRef.current,
      clickCount: clickCountFor(e.button, point.x, point.y),
      modifiers: modifiers(e),
    });
  };

  const onCanvasMouseUp = (e: React.MouseEvent) => {
    // Pair with onCanvasMouseDown: gate on passthrough (not full `interactive`)
    // so the release of a first, pane-selecting click still completes the click.
    if (!passthroughRef.current) return;
    e.preventDefault();
    const point = toDevice(e);
    if (!point) return;
    buttonsHeldRef.current &= ~(MOUSE_BUTTON_MASKS[e.button] ?? 0);
    controller.send({
      type: 'input_mouse',
      eventType: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: MOUSE_BUTTONS[e.button] ?? 'left',
      buttons: buttonsHeldRef.current,
      clickCount: lastClickRef.current.count,
      modifiers: modifiers(e),
    });
  };

  const onCanvasMouseMove = (e: React.MouseEvent) => {
    if (!interactiveRef.current) return;
    const now = performance.now();
    if (now - lastMoveRef.current < 8) return;
    lastMoveRef.current = now;
    const point = toDevice(e);
    if (!point) return;
    const held = buttonsHeldRef.current;
    controller.send({
      type: 'input_mouse',
      eventType: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: held ? (held & 1 ? 'left' : held & 2 ? 'right' : 'middle') : 'none',
      buttons: held,
      modifiers: modifiers(e),
    });
  };

  // Wheel needs a non-passive listener to preventDefault, which JSX onWheel does
  // not guarantee.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      if (!interactiveRef.current) return;
      e.preventDefault();
      const point = toDevice(e);
      if (!point) return;
      controller.send({
        type: 'input_mouse',
        eventType: 'mouseWheel',
        x: point.x,
        y: point.y,
        button: 'none',
        clickCount: 0,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        modifiers: modifiers(e),
      });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [controller, toDevice]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!interactiveRef.current) return;
    e.preventDefault();
    controller.handleKeyDownLike(e);
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    if (!interactiveRef.current) return;
    e.preventDefault();
    controller.sendKeyUp(e);
  };

  // Hold DOM focus while interactive so keystrokes land here, mirroring how xterm
  // holds focus for terminal surfaces.
  useEffect(() => {
    if (interactive) elRef.current?.focus({ preventScroll: true });
  }, [interactive]);

  // Fallback: if focus fell through to <body> (dockview focus churn, clicks
  // racing the passthrough transition), forward keys from the window so the pane
  // never goes keyboard-dead while interactive. Events targeted inside the pane
  // are skipped — the React handlers above already cover those. The Wall's own
  // capture listener registered earlier, so its dual-tap leader still runs first.
  useEffect(() => {
    if (!interactive) return;
    const forward = (e: KeyboardEvent) => {
      if (!interactiveRef.current || e.defaultPrevented) return;
      const el = elRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      // A screen modal (or any dialog) renders outside the pane element, so the
      // contains() check above misses it; without this, typing into the modal's
      // Custom W/H/DPI fields would be swallowed and forwarded to the browser.
      if (e.target instanceof Element && e.target.closest('[role="dialog"]')) return;
      // Likewise never hijack keystrokes destined for an editable field that
      // lives outside the pane — notably the header's URL editor.
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      if (e.type === 'keydown') controller.handleKeyDownLike(e);
      else controller.sendKeyUp(e);
    };
    window.addEventListener('keydown', forward, true);
    window.addEventListener('keyup', forward, true);
    return () => {
      window.removeEventListener('keydown', forward, true);
      window.removeEventListener('keyup', forward, true);
    };
  }, [controller, interactive]);

  // Focus the swap-confirm overlay when it appears so it captures the typed
  // confirm/cancel keys (the pane's key-forwarder skips in-pane targets).
  useEffect(() => {
    if (pendingIframeSwap) swapConfirmRef.current?.focus();
  }, [pendingIframeSwap]);

  // --- placeholder state (derived from the snapshot) ---

  const placeholder = (() => {
    if (!streamPort) return `Waiting for browser session ${session ?? ''} — run dor ab open <url>`;
    if (connectionLost || status?.connected === false) {
      return `Browser session ${session ?? ''} ended — run dor ab open <url> to restart it, or close this surface.`;
    }
    if (!hasFrame) {
      return status && !status.screencasting
        ? 'No page is open — run dor ab open <url>'
        : `Connecting to ${session ?? 'browser session'}…`;
    }
    return null;
  })();

  return (
    <div
      ref={elRef}
      tabIndex={-1}
      className={`flex h-full w-full flex-col overflow-hidden bg-terminal-bg outline-none ${TERMINAL_BOTTOM_RADIUS_CLASS}`}
      onMouseDown={() => {
        actions.onClickPanel(api.id);
        // Deferred so it lands after dockview's own focus handling for this
        // mousedown (same trick as enterTerminalMode's focusSession).
        requestAnimationFrame(() => elRef.current?.focus({ preventScroll: true }));
      }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      {tabs.length >= 2 && (
        <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border bg-surface-raised px-1 py-0.5">
          {tabs.map((tab) => (
            <div
              key={tab.tabId}
              title={tab.url}
              className={clsx(
                'group flex min-w-0 max-w-48 cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-xs',
                tab.active ? 'bg-terminal-bg text-foreground' : 'text-muted hover:bg-terminal-bg/60',
              )}
              onClick={() => controller.selectTab(tab)}
            >
              <span className="truncate">{tabDisplayTitle(tab)}</span>
              <button
                type="button"
                aria-label="Close tab"
                className="shrink-0 rounded px-0.5 text-muted opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  controller.closeTab(tab);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div ref={viewportRef} className="relative flex min-h-0 flex-1 items-center justify-center">
        {/* Canvas stays mounted across pop-out (its listeners keep their element)
            — just hidden under the stub while a headed window renders instead. */}
        <canvas
          ref={canvasRef}
          className={clsx('block max-h-full max-w-full select-none', (!hasFrame || poppedOut) && 'hidden')}
          onMouseDown={onCanvasMouseDown}
          onMouseUp={onCanvasMouseUp}
          onMouseMove={onCanvasMouseMove}
          onContextMenu={(e) => {
            if (interactiveRef.current) e.preventDefault();
          }}
        />
        {poppedOut ? (
          // Popped out to a headed OS window — the pane is a clean stub.
          <div className="flex flex-col items-center gap-3 px-4 text-center text-sm text-muted">
            <div>This browser is running in a separate window.</div>
            <div className="flex gap-2 text-xs">
              {getPlatform().agentBrowserBringToFront && (
                <button
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    controller.bringToFront();
                  }}
                  className="rounded border border-border px-2.5 py-1 text-muted transition-colors hover:border-foreground hover:text-foreground"
                >
                  Bring to front
                </button>
              )}
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  controller.popIn();
                }}
                className="rounded border border-border px-2.5 py-1 text-muted transition-colors hover:border-foreground hover:text-foreground"
              >
                Pop back in
              </button>
            </div>
          </div>
        ) : placeholder ? (
          <div className="px-4 text-center text-sm text-muted">{placeholder}</div>
        ) : null}
        {pendingIframeSwap && (
          <div
            ref={swapConfirmRef}
            tabIndex={-1}
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-terminal-bg/95 px-6 text-center outline-none"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'c' || e.key === 'C') {
                setPendingIframeSwap(false);
                actions.onSwapRenderMode(api.id, 'iframe');
              } else if (e.key === 'Escape') {
                setPendingIframeSwap(false);
              }
            }}
          >
            <div className="max-w-sm text-sm text-foreground">
              Switching to the iframe renderer keeps only the active tab.{' '}
              <span className="font-semibold">{Math.max(0, tabs.length - 1)} other tab{tabs.length - 1 === 1 ? '' : 's'}</span> will be closed.
            </div>
            <div className="text-xs text-muted">
              Press <kbd className="rounded bg-app-bg px-1 py-0.5 font-mono">c</kbd> to continue · <kbd className="rounded bg-app-bg px-1 py-0.5 font-mono">Esc</kbd> to cancel
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
