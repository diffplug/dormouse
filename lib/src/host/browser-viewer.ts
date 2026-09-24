/**
 * The viewer socket (docs/specs/dor-browser.md → "Viewer Socket"): the one
 * WebSocket per Surface over which the host relays a provider's browser to the
 * webview — frames as binary messages, state as JSON text — and the webview's
 * input back. The webview never reaches a daemon or CDP itself.
 *
 * One loopback listener serves every socket, guarded like every loopback
 * listener (`./loopback-guard.ts`: its own `Host`) and by a single-use grant
 * per socket. Each socket's `BrowserView` runs the two-stage paint's host
 * half: which stream frames to send as provisional, and the crisp-capture
 * loop that replaces them.
 */
import { createServer, type Server } from 'node:http';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import {
  VIEWER_TEXT_INPUT_MAX,
  encodeViewerFrame,
  type ViewerFrameKind,
  type ViewerInput,
  type ViewerState,
} from '../lib/platform/browser-automation';
import { BrowserStreamGrants } from './browser-stream-guard';
import { isLoopbackHost } from './loopback-guard';

/** What a provider pushes to one viewer of a live browser. */
export interface ViewerSink {
  /** A screencast frame that differs from the last one: its JPEG, and the
   *  viewport's CSS size when the provider knows it. */
  frame(jpeg: Uint8Array, size?: { width: number; height: number }): void;
  /** A state change. */
  state(message: ViewerState): void;
  /** The browser went away on its own — its window closed, its daemon or
   *  connection died — never because the host closed it. */
  gone(): void;
}

/** A provider's subscription behind one viewer socket. */
export interface Upstream {
  /** Whether the host can capture this browser: false for one it can only
   *  watch, an agent-browser daemon in a socket directory it does not share. */
  readonly capturable: boolean;
  /** Forward one validated input message; false when the provider's input
   *  backlog is full. */
  input(message: Exclude<ViewerInput, { type: 'repaint' }>): boolean;
  close(): void;
}

// --- the listener ---

export interface ViewerServer {
  /** A single-use URL, good for 60 s, whose socket `open` takes. */
  grant(open: (socket: WebSocket) => void): Promise<string>;
  /** Shutdown: end every socket and stop listening. */
  close(): Promise<void>;
}

const VIEW_PATH = /^\/view\/([a-f0-9]{64})$/;
// Only input travels webview → host; its largest message is an `input_text`
// of VIEWER_TEXT_INPUT_MAX characters, six bytes each when JSON-escaped.
const MAX_INBOUND_BYTES = 65536;

export function createViewerServer(): ViewerServer {
  const grants = new BrowserStreamGrants<(socket: WebSocket) => void>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_BYTES });
  let listening: Promise<{ server: Server; port: number }> | null = null;
  let closed = false;

  function listen(): Promise<{ server: Server; port: number }> {
    listening ??= new Promise<{ server: Server; port: number }>((resolve, reject) => {
      const server = createServer((_req, res) => { res.writeHead(403); res.end(); });
      let port = 0;
      server.on('upgrade', (req, socket, head) => {
        const token = VIEW_PATH.exec(req.url ?? '')?.[1];
        const open = token && isLoopbackHost(req.headers.host, port) ? grants.consume(token) : undefined;
        if (!open) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          return;
        }
        wss.handleUpgrade(req, socket, head, open);
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        server.unref();
        port = (server.address() as { port: number }).port;
        resolve({ server, port });
      });
    }).catch((error: unknown) => {
      // Retried by the next grant, never memoized.
      listening = null;
      throw error;
    });
    return listening;
  }

  return {
    async grant(open) {
      if (closed) throw new Error('the browser host is shutting down');
      const { port } = await listen();
      return `ws://127.0.0.1:${port}/view/${grants.issue(open)}`;
    },
    async close() {
      closed = true;
      for (const socket of wss.clients) socket.terminate();
      const bound = await listening?.catch(() => null);
      // Every connection too, so a client holding one open cannot hold
      // shutdown.
      bound?.server.closeAllConnections();
      await new Promise<void>((resolve) => (bound ? bound.server.close(() => resolve()) : resolve()));
    },
  };
}

// --- one socket ---

/** Continued input keeps the stream painting this long after the last. */
export const PROVISIONAL_INPUT_WINDOW_MS = 250;
const OVERDUE_FLOOR_MS = 400;
// A capture this slow is flagged `stalled` in its debug log.
const STALL_WARNING_MS = 8000;
// A provisional frame is superseded by the next, so a socket backed up past
// this skips it.
const FRAME_BACKLOG_BYTES = 2_000_000;
const STATS_INTERVAL_MS = 5000;

export interface BrowserViewDeps {
  /** The Surface shows its browser as its own window: no frame is sent. */
  headed: boolean;
  /** One device-resolution JPEG of the browser, or undefined when none can
   *  be taken now. */
  capture(): Promise<Uint8Array | undefined>;
  /** Called once the socket has closed, however it closed. */
  onClose(): void;
  /** Set to log this socket's rates every few seconds. */
  log?(message: string): void;
}

/**
 * One viewer socket: the provider's sink on one side, the webview's socket on
 * the other. A stream frame is sent as a provisional paint when it is the
 * first, inside the input window, or while a capture is overdue; any changed
 * frame pulses the crisp loop, whose capture replaces it. At most one capture
 * is in flight; one starts no sooner than 1.5× the average capture after the
 * last began, never inside the input window; one out past twice the average
 * (at least 400 ms) is overdue and never re-issued; one a provisional paint
 * superseded while it ran is dropped and owed again.
 */
export class BrowserView implements ViewerSink {
  private upstream: Upstream | null = null;
  private capturable = false;
  private closed = false;
  // What the socket last carried, which is what the webview's canvas shows.
  private last: { kind: ViewerFrameKind; jpeg: Uint8Array; message: Uint8Array } | null = null;
  private size: { width: number; height: number } | undefined;
  private provisionalUntil = -Infinity;
  private activeTab: string | undefined;
  // Counts the provisional paints that supersede a capture in flight — not
  // those made only because one is overdue, which it is newer than.
  private provisionalGeneration = 0;
  // --- the crisp loop ---
  private inFlight = false;
  private dirty = false;
  private lastStart = -Infinity;
  private avgMs = 120;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly stats = { framesIn: 0, provisional: 0, crisp: 0, captures: 0, captureMs: 0, bytesOut: 0 };
  private statsTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly socket: WebSocket, private readonly deps: BrowserViewDeps) {
    socket.on('message', (raw, isBinary) => this.receive(raw, isBinary));
    socket.on('close', () => this.dispose());
    socket.on('error', () => {});
    if (deps.log) {
      startLagMonitor();
      this.statsTimer = setInterval(() => this.logStats(), STATS_INTERVAL_MS);
      this.statsTimer.unref();
    }
  }

  /** The provider's subscription, once it is live. */
  attach(upstream: Upstream): void {
    if (this.closed) {
      upstream.close();
      return;
    }
    this.upstream = upstream;
    this.capturable = upstream.capturable;
    // A frame that beat the subscription was painted as it came; sharpen it.
    if (this.last) this.pulse();
  }

  /** End the socket: the host relaunched or closed its browser, or the
   *  provider could not subscribe. The view ends at once — no capture starts
   *  while the webview has yet to answer the close. */
  close(code: number, reason: string): void {
    this.dispose();
    this.socket.close(code, reason.slice(0, 120));
  }

  /** Paint the stream for a while: input reached the page another way (a
   *  host editing op). */
  openProvisionalWindow(): void {
    this.provisionalUntil = performance.now() + PROVISIONAL_INPUT_WINDOW_MS;
  }

  // --- the provider's sink ---

  frame(jpeg: Uint8Array, size?: { width: number; height: number }): void {
    if (this.closed || this.deps.headed) return;
    this.stats.framesIn += 1;
    if (size) this.size = size;
    const now = performance.now();
    const forInput = !this.last || !this.capturable || now <= this.provisionalUntil;
    if (forInput || this.captureOverdue(now)) {
      this.send('provisional', jpeg);
      if (forInput) this.provisionalGeneration += 1;
    }
    if (this.capturable) this.pulse();
  }

  state(message: ViewerState): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
    if (message.type !== 'tabs') return;
    // Selecting another tab sends no screencast frame, and the stream is
    // otherwise quiet on a static page: capture the tab now shown.
    const active = message.tabs.find((tab) => tab.active)?.tabId;
    if (active !== undefined && this.activeTab !== undefined && active !== this.activeTab && this.last) this.pulse();
    if (active !== undefined) this.activeTab = active;
  }

  gone(): void {
    this.state({ type: 'status', connected: false, screencasting: false });
    this.close(1000, 'the browser went away');
  }

  // --- the webview's socket ---

  private receive(raw: { toString(): string }, isBinary: boolean): void {
    if (this.closed || isBinary) return;
    const message = parseViewerInput(raw.toString());
    if (!message) return;
    if (message.type === 'repaint') {
      // A canvas that mounted blank: what it would have shown.
      if (this.last) this.transmit(this.last.message);
      return;
    }
    this.openProvisionalWindow();
    if (this.upstream && !this.upstream.input(message)) this.close(1008, 'Input backlog exceeded');
  }

  private send(kind: ViewerFrameKind, jpeg: Uint8Array): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    if (kind === 'provisional' && this.socket.bufferedAmount > FRAME_BACKLOG_BYTES) return;
    const message = encodeViewerFrame({ kind, jpeg, ...(this.size ? { size: this.size } : {}) });
    this.last = { kind, jpeg, message };
    this.stats[kind] += 1;
    this.transmit(message);
  }

  private transmit(message: Uint8Array): void {
    this.stats.bytesOut += message.byteLength;
    this.socket.send(message);
  }

  // --- the crisp loop ---

  private overdueAfterMs(): number {
    return Math.max(2 * this.avgMs, OVERDUE_FLOOR_MS);
  }

  private captureOverdue(now: number): boolean {
    return this.inFlight && now - this.lastStart > this.overdueAfterMs();
  }

  /** A "page changed" signal: a fresh capture is owed, coalesced and paced. */
  private pulse(): void {
    if (this.closed || !this.capturable) return;
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.inFlight) return;
    const now = performance.now();
    // Pacing: ~1.5× the measured capture since the last start, so a slow
    // capture self-throttles; the 50 ms floor stops a fast failure spinning.
    const paceWait = this.lastStart + Math.max(50, this.avgMs * 1.5) - now;
    // Inside the input window every capture is superseded before it lands.
    const provisionalWait = this.provisionalUntil - now;
    const wait = Math.max(paceWait, provisionalWait);
    if (wait > 0) {
      this.timer ??= setTimeout(() => {
        this.timer = undefined;
        // Re-enter `schedule`: continued input moves the window's end.
        if (this.dirty) this.schedule();
      }, wait);
      return;
    }
    this.take();
  }

  private take(): void {
    this.inFlight = true;
    this.dirty = false;
    const generation = this.provisionalGeneration;
    const started = this.lastStart = performance.now();
    this.stats.captures += 1;
    void this.deps.capture().catch(() => undefined).then((jpeg) => {
      const elapsedMs = performance.now() - started;
      this.stats.captureMs += elapsedMs;
      if (elapsedMs > STALL_WARNING_MS) this.deps.log?.(`[browser-viewer] capture stalled ${Math.round(elapsedMs)}ms`);
      // An overdue capture timed a page load, not a capture: clamp it.
      this.avgMs = this.avgMs * 0.6 + Math.min(elapsedMs, this.overdueAfterMs()) * 0.4;
      this.inFlight = false;
      if (this.closed) return;
      if (jpeg) {
        // A provisional paint landed meanwhile and is newer: keep the
        // sharpening capture owed rather than paint over it.
        if (this.provisionalGeneration !== generation) this.dirty = true;
        else if (!(this.last?.kind === 'crisp' && sameBytes(this.last.jpeg, jpeg))) this.send('crisp', jpeg);
      }
      if (this.dirty) this.schedule();
    });
  }

  private logStats(): void {
    const { stats } = this;
    const lag = lagMonitor;
    this.deps.log?.(`[browser-viewer] ${JSON.stringify({
      perSecond: {
        framesIn: stats.framesIn / (STATS_INTERVAL_MS / 1000),
        provisional: stats.provisional / (STATS_INTERVAL_MS / 1000),
        crisp: stats.crisp / (STATS_INTERVAL_MS / 1000),
        captures: stats.captures / (STATS_INTERVAL_MS / 1000),
        kbOut: Math.round(stats.bytesOut / 1024 / (STATS_INTERVAL_MS / 1000)),
      },
      captureAvgMs: stats.captures ? Math.round(stats.captureMs / stats.captures) : null,
      eventLoopDelayMs: lag ? { p99: Math.round(lag.percentile(99) / 1e6), max: Math.round(lag.max / 1e6) } : null,
    })}`);
    for (const key of Object.keys(stats) as (keyof typeof stats)[]) stats[key] = 0;
    lag?.reset();
  }

  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.upstream?.close();
    this.deps.onClose();
  }
}

let lagMonitor: IntervalHistogram | null = null;
/** The host's event-loop delay, sampled once any viewer logs its rates. */
function startLagMonitor(): void {
  if (lagMonitor) return;
  lagMonitor = monitorEventLoopDelay({ resolution: 10 });
  lagMonitor.enable();
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && Buffer.compare(a, b) === 0;
}

const MOUSE_EVENTS = new Set(['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel']);
const MOUSE_BUTTONS = new Set(['left', 'right', 'middle', 'none']);
const finiteCoordinate = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6;
const integer = (n: unknown): number => (Number.isInteger(n) ? n as number : 0);

/**
 * One message from the webview, rebuilt field by field from what it sent:
 * each provider forwards only these shapes, bounded, to its browser. Null for
 * anything else.
 */
export function parseViewerInput(raw: string): ViewerInput | null {
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (data.type) {
    case 'input_mouse': {
      if (typeof data.eventType !== 'string' || !MOUSE_EVENTS.has(data.eventType)) return null;
      if (!finiteCoordinate(data.x) || !finiteCoordinate(data.y)) return null;
      const eventType = data.eventType as Extract<ViewerInput, { type: 'input_mouse' }>['eventType'];
      return {
        type: 'input_mouse',
        eventType,
        x: data.x,
        y: data.y,
        button: typeof data.button === 'string' && MOUSE_BUTTONS.has(data.button) ? data.button as 'left' : 'none',
        buttons: integer(data.buttons) & 31,
        clickCount: Math.min(3, Math.max(0, integer(data.clickCount))),
        modifiers: integer(data.modifiers) & 15,
        ...(eventType === 'mouseWheel' ? { deltaX: Number(data.deltaX) || 0, deltaY: Number(data.deltaY) || 0 } : {}),
      };
    }
    case 'input_keyboard':
      if ((data.eventType !== 'keyDown' && data.eventType !== 'keyUp') || typeof data.key !== 'string' || data.key.length > 100) return null;
      return {
        type: 'input_keyboard',
        eventType: data.eventType,
        key: data.key,
        code: typeof data.code === 'string' ? data.code.slice(0, 100) : '',
        text: typeof data.text === 'string' ? data.text.slice(0, 1000) : '',
        windowsVirtualKeyCode: integer(data.windowsVirtualKeyCode),
        modifiers: integer(data.modifiers) & 15,
      };
    case 'input_text':
      return typeof data.text === 'string' && data.text.length <= VIEWER_TEXT_INPUT_MAX ? { type: 'input_text', text: data.text } : null;
    case 'repaint':
      return { type: 'repaint' };
    default:
      return null;
  }
}
