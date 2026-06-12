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
import { readTextFromClipboard } from '../../lib/clipboard';
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
  binaryPath?: string;
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

// `text` is what makes typing land; windowsVirtualKeyCode is what makes
// non-text keys and modifier chords act. Keyed by KeyboardEvent.key.
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
  Insert: { keyCode: 45 },
  Home: { keyCode: 36 },
  End: { keyCode: 35 },
  PageUp: { keyCode: 33 },
  PageDown: { keyCode: 34 },
  Shift: { keyCode: 16 },
  Control: { keyCode: 17 },
  Alt: { keyCode: 18 },
  Meta: { keyCode: 91 },
  CapsLock: { keyCode: 20 },
  ContextMenu: { keyCode: 93 },
};

// Windows virtual-key codes for printable keys, keyed by KeyboardEvent.code
// (the physical key, so shifted variants share an entry). Letters and digits
// are handled structurally in virtualKeyCode. Never derive a VK from
// `key.charCodeAt(0)`: '.' is 46, which is VK_DELETE — the daemon deletes
// instead of typing a period.
const OEM_VK_BY_CODE: Record<string, number> = {
  Space: 32,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  NumpadMultiply: 106,
  NumpadSubtract: 109,
  NumpadAdd: 107,
};

function virtualKeyCode(key: string, code: string): number {
  const special = SPECIAL_KEYS[key];
  if (special) return special.keyCode;
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^(Digit|Numpad)[0-9]$/.test(code)) return code.charCodeAt(code.length - 1) + (code.startsWith('Numpad') ? 48 : 0);
  if (/^F([1-9]|1[0-2])$/.test(code)) return 111 + Number(code.slice(1));
  return OEM_VK_BY_CODE[code] ?? 0;
}

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

  const binaryPath = params?.binaryPath;
  const runAgentBrowser = useCallback((args: string[]) => {
    if (!session) return;
    const command = getPlatform().agentBrowserCommand;
    if (!command) {
      console.warn('[agent-browser] this host cannot run agent-browser commands; tab actions are unavailable');
      return;
    }
    command(session, args, binaryPath).then((result) => {
      if (result.exitCode !== 0) {
        console.warn(`[agent-browser] ${args.join(' ')} failed:`, result.stderr || result.stdout || `exit ${result.exitCode}`);
      }
    }).catch((error) => {
      console.warn(`[agent-browser] ${args.join(' ')} failed:`, error);
    });
  }, [session, binaryPath]);

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
    if (!canvas || !canvas.width || !canvas.height) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    // Map into frame pixels (the canvas intrinsic grid), then apply ONE
    // uniform frame→CSS-pixel scale derived from the widths. The frame can be
    // SHORTER than the viewport (observed 1280×577 vs a 1280×720 device), so
    // scaling y by deviceHeight/rect.height stretches clicks downward —
    // frame pixels map 1:1 onto viewport CSS pixels, top-aligned.
    const frameToDevice = deviceRef.current.width ? deviceRef.current.width / canvas.width : 1;
    return {
      x: Math.round((e.clientX - rect.left) * (canvas.width / rect.width) * frameToDevice),
      y: Math.round((e.clientY - rect.top) * (canvas.height / rect.height) * frameToDevice),
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
    // preventDefault stops the browser's focus-shift default action (a click
    // on a non-focusable canvas would otherwise blur to <body>), and the
    // explicit focus claims keystrokes for this pane.
    e.preventDefault();
    elRef.current?.focus({ preventScroll: true });
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

  type KeyLike = { key: string; code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

  const sendKey = useCallback((e: KeyLike, eventType: 'keyDown' | 'keyUp') => {
    const info = SPECIAL_KEYS[e.key];
    // Under ctrl/cmd the key is a shortcut, not text — sending text would make
    // e.g. cmd-A insert an "a" instead of acting as a chord.
    const wantsText = eventType === 'keyDown' && !e.ctrlKey && !e.metaKey;
    send({
      type: 'input_keyboard',
      eventType,
      key: e.key,
      code: e.code,
      // The daemon (verified 0.27.0) silently DROPS any event whose text field
      // is absent — arrows, Escape, modifier keys, chords. An empty string
      // dispatches a proper non-text key event, so always send a string.
      text: wantsText ? info?.text ?? (e.key.length === 1 ? e.key : '') : '',
      windowsVirtualKeyCode: virtualKeyCode(e.key, e.code),
      modifiers: modifiers(e),
    });
  }, [send]);

  // cmd/ctrl-V types the LOCAL clipboard into the page. Plain key forwarding
  // would trigger paste of the embedded Chromium's own (empty) clipboard, so
  // bridge by replaying the text as per-character keyDown events.
  const insertText = useCallback((text: string) => {
    for (const ch of text) {
      if (ch === '\r') continue;
      if (ch === '\n') {
        send({ type: 'input_keyboard', eventType: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13, modifiers: 0 });
        send({ type: 'input_keyboard', eventType: 'keyUp', key: 'Enter', code: 'Enter', text: '', windowsVirtualKeyCode: 13, modifiers: 0 });
      } else {
        send({ type: 'input_keyboard', eventType: 'keyDown', key: ch, code: '', text: ch, windowsVirtualKeyCode: 0, modifiers: 0 });
        send({ type: 'input_keyboard', eventType: 'keyUp', key: ch, code: '', text: '', windowsVirtualKeyCode: 0, modifiers: 0 });
      }
    }
  }, [send]);

  const handleKeyDownLike = useCallback((e: KeyLike) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
      void readTextFromClipboard().then((text) => {
        if (text) insertText(text);
      });
      return;
    }
    sendKey(e, 'keyDown');
  }, [insertText, sendKey]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!interactiveRef.current) return;
    e.preventDefault();
    handleKeyDownLike(e);
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

  // Fallback: if focus fell through to <body> (dockview focus churn, clicks
  // racing the passthrough transition), forward keys from the window so the
  // pane never goes keyboard-dead while interactive. Events targeted inside
  // the pane are skipped — the React handlers above already cover those. The
  // Wall's own capture listener registered earlier, so its dual-tap leader
  // still runs first.
  useEffect(() => {
    if (!interactive) return;
    const forward = (e: KeyboardEvent) => {
      if (!interactiveRef.current || e.defaultPrevented) return;
      const el = elRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      e.preventDefault();
      if (e.type === 'keydown') handleKeyDownLike(e);
      else sendKey(e, 'keyUp');
    };
    window.addEventListener('keydown', forward, true);
    window.addEventListener('keyup', forward, true);
    return () => {
      window.removeEventListener('keydown', forward, true);
      window.removeEventListener('keyup', forward, true);
    };
  }, [interactive, handleKeyDownLike, sendKey]);

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
          className={clsx('block max-h-full max-w-full select-none', !hasFrame && 'hidden')}
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
