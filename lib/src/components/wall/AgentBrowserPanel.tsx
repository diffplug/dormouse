/** React view for the surface-scoped lifecycle in
 * `agent-browser-surface-controller.ts`; see docs/specs/dor-browser.md. */
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { clsx } from 'clsx';
import { TERMINAL_BOTTOM_RADIUS_CLASS } from '../design';
import { isEditableTarget } from '../../lib/dom';
import type { RenderMode } from './agent-browser-screen';
import { tabDisplayTitle } from './browser-url';
import { resolveRenderMode } from './browser-surface';
import { BROWSER_PROVIDER_GUI, surfaceProvider } from './browser-automation';
import { MOUSE_BUTTONS, MOUSE_BUTTON_MASKS, modifiers } from './agent-browser-input';
import {
  acquireAgentBrowserSurfaceController,
  type AgentBrowserSurfaceParams,
} from './agent-browser-surface-controller';
// Re-exported so existing importers (notably the panel test) keep resolving the
// park delay from here even though it now lives on the controller.
export { HIDDEN_PARK_DELAY_MS } from './agent-browser-surface-controller';
import type { PaneProps } from './pane-props';
import { usePaneChrome } from './use-pane-chrome';
import { useSurfaceVisibility } from './use-surface-visibility';
import {
  ModeContext,
  PaneWriteContext,
  SelectedIdContext,
  WallActionsContext,
  WorkspaceActiveContext,
} from './wall-context';

type AgentBrowserPanelParams = AgentBrowserSurfaceParams;

export function AgentBrowserPanel({ id, params: rawParams, parked, renderMode: renderModeProp }: PaneProps & { renderMode?: RenderMode }) {
  // The engine-tracked `title` prop is unused here: the live title is derived
  // from the stream (controller → paneWrite.setTitle), never read back.
  const params = rawParams as AgentBrowserPanelParams | undefined;
  const actions = useContext(WallActionsContext);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const paneWrite = useContext(PaneWriteContext);
  const mode = useContext(ModeContext);
  const selectedId = useContext(SelectedIdContext);
  const elRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  usePaneChrome(id, elRef);

  const session = params?.session;
  const launchSession = params?.launchSession;
  const binaryPath = params?.binaryPath;
  const url = params?.url;
  const key = params?.key;
  const syncEngaged = params?.syncEngaged;
  const cwd = params?.cwd;
  // poppedOut is derived from the canonical renderMode the shell passes; fall
  // back to resolving it from params for a direct mount (tests) / legacy blob.
  const seededMode = renderModeProp ?? resolveRenderMode(params);
  const provider = surfaceProvider(seededMode);
  const cli = BROWSER_PROVIDER_GUI[provider].cli;

  // The surface-scoped controller: get-or-create, keyed by surface id. Survives
  // this component's unmount (minimize, layout churn, StrictMode). Keyed by
  // provider too: a minimized pane keeps this view mounted while its Wall
  // restores a failed cross-provider swap in place, and the restored provider
  // needs its own. One released under this view is replaced when params next
  // change (`generation`), never on the release itself: a kill releases it as
  // the pane starts to fade, where re-acquiring would leave a live controller
  // behind for a dead Surface.
  const [generation, setGeneration] = useState(0);
  const controller = useMemo(
    () => acquireAgentBrowserSurfaceController(id, { ...params, renderMode: seededMode }),
    // Later param changes flow through updateParams below (acquire is
    // get-or-create and ignores params when the controller already exists).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, provider, generation],
  );

  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const { tabs, status, hasFrame, poppedOut, phase, error } = snapshot;

  // Gated on the same Workspace-aware visibility the streaming body reads, so a
  // Workspace left in passthrough on a browser pane stops forwarding (and
  // preventDefault-ing) window keystrokes the moment it is hidden. `parked` is
  // deliberately not part of it: a parked leaf is never the selected pane.
  const workspaceActive = useContext(WorkspaceActiveContext);
  const interactive = workspaceActive && mode === 'passthrough' && selectedId === id;
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

  // Feed later param changes into the controller (diffed internally). The
  // renderMode it gets back is mostly its own popOut/popIn write; it follows
  // one the host reported for a native launch (`followParamsHeadedness`).
  useEffect(() => {
    if (controller.released) setGeneration((current) => current + 1);
    else controller.updateParams({ session, launchSession, binaryPath, url, syncEngaged, key, cwd, renderMode: seededMode });
  }, [controller, session, launchSession, binaryPath, url, syncEngaged, key, cwd, seededMode]);

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
      updateParameters: (next) => paneWrite.updateParams(id, next),
      setTitle: (nextTitle) => paneWrite.setTitle(id, nextTitle),
      requestRenderSwap: (mode = 'iframe', viewport) => {
        // The iframe renderer is single-frame: only the active tab survives.
        // Warn + require a typed confirm when other tabs would be closed.
        if (controller.snapshot().tabs.length >= 2) setPendingRenderSwap(mode);
        else if (viewport) actionsRef.current.onSwapRenderMode(id, mode, viewport);
        else actionsRef.current.onSwapRenderMode(id, mode);
      },
      launchFailed: (error) => actionsRef.current.onBrowserLaunchFailed?.(id, error),
    });
    return () => handle.detach();
    // The sink closes over `paneWrite` + `id`, both stable for a mounted pane
    // (Wall memoizes paneWrite; id never changes), so this still binds once per
    // controller — preserving the sink's identity stability.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, paneWrite, id]);

  // Feed effective on-screen visibility (foreground window, and not a parked leaf)
  // so the controller can park a hidden pane after the debounce. A minimized
  // screencast stays mounted and connected but stops pulling frames.
  const visible = useSurfaceVisibility(parked);
  useEffect(() => {
    controller.setVisible(visible);
  }, [controller, visible]);

  // Crossing to the single-frame iframe renderer closes all but the active tab;
  // when others are open the swap is gated behind a typed confirm (overlay below).
  const [pendingRenderSwap, setPendingRenderSwap] = useState<RenderMode | null>(null);
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
  }, [controller, id, toDevice]);

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

  // Fallback: if focus fell through to <body> (focus churn, clicks racing the
  // passthrough transition), forward keys from the window so the pane never goes
  // keyboard-dead while interactive. Events targeted inside the pane
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
      if (e.target instanceof Element && e.target.closest('[role="dialog"], [data-terminal-context]')) return;
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
  }, [controller, id, interactive]);

  // Focus the swap-confirm overlay when it appears so it captures the typed
  // confirm/cancel keys (the pane's key-forwarder skips in-pane targets).
  useEffect(() => {
    if (pendingRenderSwap) swapConfirmRef.current?.focus();
  }, [pendingRenderSwap]);

  // --- placeholder state (derived from the snapshot) ---

  // The browser is on its way — a launch, an attach, or a relaunch whose new
  // stream is not yet known — not a session that ended.
  const opening = phase === 'idle' || phase === 'launching' || phase === 'attaching' || phase === 'relaunching';
  const placeholder = (() => {
    // Mid-launch: the pane is on screen before its browser is up. It is
    // mid-boot, not idle — telling the user to run `dor agent-browser open` here would ask
    // them to redo the click they just made.
    if (phase === 'launching') return 'Opening the browser…';
    // Mid pop-in: the headed browser is closed by design and the headless one
    // is booting — not a session that ended.
    if (phase === 'relaunching') return 'Relaunching browser…';
    // Addressed to this pane: a bare `dor agent-browser open` drives the caller's default
    // key, which for a keyed or GUI-launched pane is some other browser.
    const command = `${cli} --surface ${actions.resolveSurfaceRef(id)} open <url>`;
    // A pane whose launch never named a session has no browser to drive yet.
    if (phase === 'ended' && error) {
      return session
        ? `The browser could not be opened (${error}) — run ${command} to retry, or close this surface.`
        : `The browser could not be opened (${error}).`;
    }
    if (phase === 'ended') {
      return `The browser session ended — run ${command} to restart it, or close this surface.`;
    }
    if (!hasFrame) {
      return status && !status.screencasting
        ? `No page is open — run ${command}`
        : 'Connecting to the browser…';
    }
    return null;
  })();

  return (
    <div
      ref={elRef}
      tabIndex={-1}
      className={`flex h-full w-full flex-col overflow-hidden bg-terminal-bg outline-none ${TERMINAL_BOTTOM_RADIUS_CLASS}`}
      onMouseDown={() => {
        actions.onClickPanel(id);
        // Deferred so it lands after the browser's own focus handling for this
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
        {poppedOut && phase !== 'ended' ? (
          // Popped out to a headed OS window — the pane is a clean stub. While
          // the window is still being opened (a launch, attach or relaunch in
          // flight) there is nothing to pop back in, so the affordance waits
          // with it.
          <div className="flex flex-col items-center gap-3 px-4 text-center text-sm text-muted">
            <div>{opening ? 'Opening the browser window…' : 'This browser is running in a separate window.'}</div>
            {!opening && <div className="flex gap-2 text-xs">
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
            </div>}
          </div>
        ) : placeholder ? (
          <div className="px-4 text-center text-sm text-muted">{placeholder}</div>
        ) : null}
        {pendingRenderSwap && (
          <div
            ref={swapConfirmRef}
            tabIndex={-1}
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-terminal-bg/95 px-6 text-center outline-none"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'c' || e.key === 'C') {
                setPendingRenderSwap(null);
                actions.onSwapRenderMode(id, pendingRenderSwap!);
              } else if (e.key === 'Escape') {
                setPendingRenderSwap(null);
              }
            }}
          >
            <div className="max-w-sm text-sm text-foreground">
              Switching browser providers keeps only the active tab.{' '}
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
