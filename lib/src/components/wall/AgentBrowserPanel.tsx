/**
 * Live agent-browser session viewer (see docs/specs/dor-agent-browser.md).
 *
 * One WebSocket — the session's stream socket — carries everything: JPEG
 * frames out, `input_mouse`/`input_keyboard` in, plus pushed `status` and
 * `tabs` messages. Tab actions (switch/close) go through the host's
 * `agentBrowserCommand` because a webview cannot spawn the agent-browser CLI.
 */
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { clsx } from 'clsx';
import { TERMINAL_BOTTOM_RADIUS_CLASS } from '../design';
import { getPlatform } from '../../lib/platform';
import {
  FreshlySpawnedContext,
  ModeContext,
  PaneElementsContext,
  SelectedIdContext,
  WallActionsContext,
} from './wall-context';

type AgentBrowserPanelParams = {
  surfaceType?: string;
  session?: string;
  key?: string;
  wsPort?: number;
};

type StreamTab = {
  tabId: string;
  title: string | null;
  url: string;
  active: boolean;
};

type StreamStatus = {
  connected: boolean;
  screencasting: boolean;
};

// Mirrors agent-browser's own viewer: `text` is what makes typing land, and
// the keyCode map covers the editing/navigation keys CDP wants spelled out.
const SPECIAL_KEYS: Record<string, { text?: string; keyCode: number }> = {
  Enter: { text: '\r', keyCode: 13 },
  Tab: { text: '\t', keyCode: 9 },
  Backspace: { text: '\b', keyCode: 8 },
  Escape: { keyCode: 27 },
  ArrowLeft: { keyCode: 37 },
  ArrowUp: { keyCode: 38 },
  ArrowRight: { keyCode: 39 },
  ArrowDown: { keyCode: 40 },
  Delete: { keyCode: 46 },
  Home: { keyCode: 36 },
  End: { keyCode: 35 },
  PageUp: { keyCode: 33 },
  PageDown: { keyCode: 34 },
};

const MOUSE_BUTTONS: Record<number, string> = { 0: 'left', 1: 'middle', 2: 'right' };
const MOUSE_BUTTON_MASKS: Record<number, number> = { 0: 1, 1: 4, 2: 2 };

function modifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

function tabDisplayTitle(tab: StreamTab): string {
  const title = tab.title?.trim();
  if (title) return title;
  try {
    const parsed = new URL(tab.url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.host}${path}` || tab.url;
  } catch {
    return tab.url || 'untitled';
  }
}

export function AgentBrowserPanel({ api, params }: IDockviewPanelProps<AgentBrowserPanelParams>) {
  const actions = useContext(WallActionsContext);
  const { elements: paneElements, bumpVersion } = useContext(PaneElementsContext);
  const freshlySpawned = useContext(FreshlySpawnedContext);
  const mode = useContext(ModeContext);
  const selectedId = useContext(SelectedIdContext);
  const elRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const session = params?.session;
  const wsPort = params?.wsPort;
  const interactive = mode === 'passthrough' && selectedId === api.id;
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;

  const wsRef = useRef<WebSocket | null>(null);
  const frameSeqRef = useRef(0);
  const deviceRef = useRef({ width: 1280, height: 720 });
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [tabs, setTabs] = useState<StreamTab[]>([]);
  const knownTabIdsRef = useRef<Set<string>>(new Set());

  const runAgentBrowser = useCallback((args: string[]) => {
    if (!session) return;
    getPlatform().agentBrowserCommand?.(session, args).catch(() => {});
  }, [session]);

  // --- pane registration + spawn animation (shared surface boilerplate) ---

  useEffect(() => {
    if (!elRef.current) return;
    paneElements.set(api.id, elRef.current);
    bumpVersion();
    return () => {
      paneElements.delete(api.id);
      bumpVersion();
    };
  }, [api.id, paneElements, bumpVersion]);

  useLayoutEffect(() => {
    const direction = freshlySpawned.get(api.id);
    if (!direction) return;
    freshlySpawned.delete(api.id);
    const groupEl = api.group?.element;
    if (!groupEl) return;
    const className = `pane-spawning-from-${direction}`;
    const animationName = `pane-spawn-from-${direction}`;
    groupEl.classList.add(className);
    const onEnd = (ev: AnimationEvent) => {
      if (ev.animationName !== animationName) return;
      groupEl.classList.remove(className);
      groupEl.removeEventListener('animationend', onEnd);
    };
    groupEl.addEventListener('animationend', onEnd);
    return () => {
      groupEl.removeEventListener('animationend', onEnd);
      groupEl.classList.remove(className);
    };
  }, [api, freshlySpawned]);

  // --- stream connection ---

  useEffect(() => {
    if (!wsPort) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const drawFrame = (data: string, metadata?: { deviceWidth?: number; deviceHeight?: number }) => {
      if (metadata?.deviceWidth && metadata?.deviceHeight) {
        deviceRef.current = { width: metadata.deviceWidth, height: metadata.deviceHeight };
      }
      const seq = ++frameSeqRef.current;
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })).then((bitmap) => {
        // JPEG decodes are async; drop frames that finished out of order.
        if (disposed || seq !== frameSeqRef.current) {
          bitmap.close();
          return;
        }
        const canvas = canvasRef.current;
        if (!canvas) {
          bitmap.close();
          return;
        }
        if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
        if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        bitmap.close();
        setHasFrame(true);
      }).catch(() => {});
    };

    const handleMessage = (raw: unknown) => {
      if (typeof raw !== 'string') return;
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === 'frame' && typeof msg.data === 'string') {
        drawFrame(msg.data, msg.metadata);
      } else if (msg.type === 'status') {
        setStatus({ connected: msg.connected === true, screencasting: msg.screencasting === true });
        if (msg.connected === false) setConnectionLost(true);
        else setConnectionLost(false);
        if (typeof msg.viewportWidth === 'number' && typeof msg.viewportHeight === 'number') {
          deviceRef.current = { width: msg.viewportWidth, height: msg.viewportHeight };
        }
      } else if (msg.type === 'tabs' && Array.isArray(msg.tabs)) {
        const next: StreamTab[] = msg.tabs
          .filter((t: any) => typeof t?.tabId === 'string')
          .map((t: any) => ({
            tabId: t.tabId,
            title: typeof t.title === 'string' ? t.title : null,
            url: typeof t.url === 'string' ? t.url : '',
            active: t.active === true,
          }));
        // Web-opened tabs (popups, target=_blank) are focused, matching
        // browser foregrounding. Skip the first message — that's catch-up,
        // not a popup.
        const known = knownTabIdsRef.current;
        if (known.size > 0) {
          const fresh = next.filter((t) => !known.has(t.tabId));
          const newest = fresh[fresh.length - 1];
          if (newest && !newest.active) runAgentBrowser(['tab', newest.tabId]);
        }
        knownTabIdsRef.current = new Set(next.map((t) => t.tabId));
        setTabs(next);
      }
    };

    const connect = async () => {
      let url: string | null = null;
      try {
        url = (await getPlatform().getAgentBrowserStreamUrl?.(wsPort)) ?? null;
      } catch {
        url = null;
      }
      if (disposed) return;
      ws = new WebSocket(url ?? `ws://127.0.0.1:${wsPort}`);
      wsRef.current = ws;
      ws.onopen = () => {
        failures = 0;
        setConnectionLost(false);
      };
      ws.onmessage = (ev) => handleMessage(ev.data);
      ws.onclose = () => {
        wsRef.current = null;
        if (disposed) return;
        failures += 1;
        // The port dies with the session, so repeated refusals mean the
        // browser is gone; keep a slow retry alive in case it comes back on
        // the same port, but a new `dor ab` updating wsPort is the real path.
        if (failures >= 3) setConnectionLost(true);
        retryTimer = setTimeout(connect, Math.min(1000 * 2 ** failures, 10000));
      };
      ws.onerror = () => {};
    };

    setHasFrame(false);
    setConnectionLost(false);
    void connect();
    return () => {
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      wsRef.current = null;
      ws?.close();
    };
  }, [wsPort, runAgentBrowser]);

  // --- header title follows the active tab ---

  useEffect(() => {
    const active = tabs.find((tab) => tab.active) ?? tabs[0];
    if (active) api.setTitle(tabDisplayTitle(active));
  }, [tabs, api]);

  // --- input forwarding (stream-native input_* messages) ---

  const send = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }, []);

  const toDevice = useCallback((e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const device = deviceRef.current;
    return {
      x: Math.round((e.clientX - rect.left) * (device.width / rect.width)),
      y: Math.round((e.clientY - rect.top) * (device.height / rect.height)),
    };
  }, []);

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
    if (!interactiveRef.current) return;
    e.preventDefault();
    const point = toDevice(e);
    if (!point) return;
    buttonsHeldRef.current |= MOUSE_BUTTON_MASKS[e.button] ?? 0;
    send({
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
    if (!interactiveRef.current) return;
    e.preventDefault();
    const point = toDevice(e);
    if (!point) return;
    buttonsHeldRef.current &= ~(MOUSE_BUTTON_MASKS[e.button] ?? 0);
    send({
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
    send({
      type: 'input_mouse',
      eventType: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: held ? (held & 1 ? 'left' : held & 2 ? 'right' : 'middle') : 'none',
      buttons: held,
      modifiers: modifiers(e),
    });
  };

  // Wheel needs a non-passive listener to preventDefault, which JSX onWheel
  // does not guarantee.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      if (!interactiveRef.current) return;
      e.preventDefault();
      const point = toDevice(e);
      if (!point) return;
      send({
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
  }, [send, toDevice]);

  const sendKey = (e: React.KeyboardEvent, eventType: 'keyDown' | 'keyUp') => {
    const info = SPECIAL_KEYS[e.key];
    send({
      type: 'input_keyboard',
      eventType,
      key: e.key,
      code: e.code,
      text: eventType === 'keyDown' ? info?.text ?? (e.key.length === 1 ? e.key : undefined) : undefined,
      windowsVirtualKeyCode: info?.keyCode ?? (e.key.length === 1 ? e.key.charCodeAt(0) : 0),
      modifiers: modifiers(e),
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!interactiveRef.current) return;
    e.preventDefault();
    sendKey(e, 'keyDown');
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    if (!interactiveRef.current) return;
    e.preventDefault();
    sendKey(e, 'keyUp');
  };

  // Hold DOM focus while interactive so keystrokes land here, mirroring how
  // xterm holds focus for terminal surfaces.
  useEffect(() => {
    if (interactive) elRef.current?.focus({ preventScroll: true });
  }, [interactive]);

  // --- tab strip actions ---

  const selectTab = (tab: StreamTab) => {
    if (!tab.active) runAgentBrowser(['tab', tab.tabId]);
  };

  const closeTab = (tab: StreamTab) => {
    runAgentBrowser(['tab', 'close', tab.tabId]);
  };

  // --- placeholder state ---

  const placeholder = (() => {
    if (!wsPort) return `Waiting for browser session ${session ?? ''} — run dor ab open <url>`;
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
      onMouseDown={() => actions.onClickPanel(api.id)}
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
              onClick={() => selectTab(tab)}
            >
              <span className="truncate">{tabDisplayTitle(tab)}</span>
              <button
                type="button"
                aria-label="Close tab"
                className="shrink-0 rounded px-0.5 text-muted opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <canvas
          ref={canvasRef}
          className={clsx('max-h-full max-w-full select-none', !hasFrame && 'hidden')}
          onMouseDown={onCanvasMouseDown}
          onMouseUp={onCanvasMouseUp}
          onMouseMove={onCanvasMouseMove}
          onContextMenu={(e) => {
            if (interactiveRef.current) e.preventDefault();
          }}
        />
        {placeholder && (
          <div className="px-4 text-center text-sm text-muted">{placeholder}</div>
        )}
      </div>
    </div>
  );
}
