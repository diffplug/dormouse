import type { AgentBrowserCommandResult } from '../../lib/platform/types';
import { type AgentBrowserTab, parseAgentBrowserTabs } from '../../lib/agent-browser-tab';

// Re-exported so existing importers keep resolving the tab type/parser from here.
export type { AgentBrowserTab };
export { parseAgentBrowserTabs };

// Stream messages above this size are frames (a base64 JPEG); status/tabs are
// small JSON control messages. Large frames parse only while the consumer asks
// for provisional low-latency hover feedback; the idle hot path stays hash+pulse.
const FRAME_PULSE_THRESHOLD = 16384;
const DEBUG_RING_LIMIT = 300;

// Fast non-cryptographic string hash (djb2) for cheap byte-identity checks on
// stream payloads. Used to detect redundant frames/tabs the daemon re-broadcasts.
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

export type AgentBrowserConnectionState = 'connecting' | 'open' | 'closed' | 'failed';

export interface AgentBrowserStreamStatus {
  connected: boolean;
  screencasting: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
}

/** A frame's device dims. Both are required: a partial or zero-sized report can
 *  neither size the surface nor key a resize, so it degrades to absent metadata
 *  rather than to a half-filled record (see `frameMetadata`). */
export interface AgentBrowserFramePulse {
  deviceWidth: number;
  deviceHeight: number;
}

/** Read device dims off a stream frame's envelope, in the one place both the
 *  large (>16KB) and small frame paths share. */
function frameMetadata(raw: { deviceWidth?: unknown; deviceHeight?: unknown } | undefined): AgentBrowserFramePulse | undefined {
  const w = raw?.deviceWidth;
  const h = raw?.deviceHeight;
  return typeof w === 'number' && w > 0 && typeof h === 'number' && h > 0
    ? { deviceWidth: w, deviceHeight: h }
    : undefined;
}

export interface AgentBrowserSnapshot {
  connection: AgentBrowserConnectionState;
  session: string;
  streamPort: number;
  tabs: AgentBrowserTab[];
  status: AgentBrowserStreamStatus | null;
  connectionLost: boolean;
  lastError?: string;
  livePortOpened: boolean;
}

export type AgentBrowserConnectionEvent =
  | { type: 'connection-open'; port: number }
  | { type: 'connection-close'; port: number; failures: number; code: number; reason: string; wasClean: boolean }
  | { type: 'connection-error'; port: number }
  | { type: 'status'; status: AgentBrowserStreamStatus }
  | { type: 'tabs'; tabs: AgentBrowserTab[]; previousTabs: AgentBrowserTab[] }
  | {
      type: 'frame-pulse';
      metadata?: AgentBrowserFramePulse;
      /** CSS-resolution stream JPEG, base64 encoded. Present only when the
       *  consumer requested a provisional paint. */
      data?: string;
    }
  | { type: 'debug'; event: AgentBrowserDebugEvent };

export interface AgentBrowserDebugEvent {
  ts: number;
  session: string;
  port: number;
  event: string;
  data?: unknown;
}

export interface AgentBrowserConnectionDeps {
  session: string;
  streamPort: number;
  binaryPath?: string;
  getStreamUrl?: (port: number) => Promise<string | undefined>;
  runCommand?: (session: string, args: string[], binaryPath?: string) => Promise<AgentBrowserCommandResult>;
  canSelectTabs?: () => boolean;
  /** Whether the current stream frame's JPEG bytes are useful to the consumer.
   *  False keeps the idle hot path at hash+pulse without parsing the large JSON. */
  wantFrameData?: () => boolean;
  log?: (message: string) => void;
}

export function createAgentBrowserConnection(deps: AgentBrowserConnectionDeps): AgentBrowserConnection {
  return new AgentBrowserConnection(deps);
}

export class AgentBrowserConnection {
  private readonly listeners = new Set<(event: AgentBrowserConnectionEvent) => void>();
  private readonly debugEvents: AgentBrowserDebugEvent[] = [];
  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private failures = 0;
  private knownTabIds = new Set<string>();
  private pendingNewTab: { tabId: string; initialUrl: string; seenAtMs: number } | null = null;
  private snap: AgentBrowserSnapshot;

  // The agent-browser daemon re-broadcasts the current frame and tab list on a
  // ~20Hz heartbeat even when nothing changes, so a *static* page would otherwise
  // drive ~20 device-resolution screenshots/sec (each a child-process spawn) plus
  // ~20 `setTabs` re-renders/sec. We drop byte-identical re-broadcasts here so an
  // unchanged page costs nothing downstream (the screenshot loop's own contract:
  // "a static page produces no pulses, so no shots and no cost"). `0`/`''` are
  // pre-first-message sentinels, and reset on reconnect so a fresh stream always
  // re-primes the canvas/tabs.
  private lastFrameKey = 0;
  private lastTabsSig = '';

  constructor(private readonly deps: AgentBrowserConnectionDeps) {
    this.snap = {
      connection: 'connecting',
      session: deps.session,
      streamPort: deps.streamPort,
      tabs: [],
      status: null,
      connectionLost: false,
      livePortOpened: false,
    };
    this.connect();
  }

  subscribe(listener: (event: AgentBrowserConnectionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): AgentBrowserSnapshot {
    return this.snap;
  }

  debugSnapshot(): AgentBrowserDebugEvent[] {
    return [...this.debugEvents];
  }

  send(payload: Record<string, unknown>): void {
    const ws = this.socket;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const ws = this.socket;
    this.socket = null;
    ws?.close();
  }

  private emit(event: AgentBrowserConnectionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private debug(event: string, data?: unknown): void {
    const item: AgentBrowserDebugEvent = {
      ts: Date.now(),
      session: this.deps.session,
      port: this.deps.streamPort,
      event,
      ...(data !== undefined ? { data } : {}),
    };
    this.debugEvents.push(item);
    if (this.debugEvents.length > DEBUG_RING_LIMIT) this.debugEvents.splice(0, this.debugEvents.length - DEBUG_RING_LIMIT);
    this.emit({ type: 'debug', event: item });
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  private patch(next: Partial<AgentBrowserSnapshot>): void {
    this.snap = { ...this.snap, ...next };
  }

  private async connect(): Promise<void> {
    let url: string | undefined;
    try {
      url = await this.deps.getStreamUrl?.(this.deps.streamPort);
    } catch (err) {
      this.debug('stream-url-error', { error: err instanceof Error ? err.message : String(err) });
    }
    if (this.disposed) return;
    const wsUrl = url ?? `ws://127.0.0.1:${this.deps.streamPort}`;
    this.log(`[ab-panel] connecting stream ${JSON.stringify({ wsPort: this.deps.streamPort, url: wsUrl })}`);
    this.debug('connect', { url: wsUrl });
    this.socket = new WebSocket(wsUrl);
    this.socket.onopen = () => {
      this.failures = 0;
      this.patch({ connection: 'open', connectionLost: false, livePortOpened: true });
      this.log(`[ab-panel] stream open ${JSON.stringify({ wsPort: this.deps.streamPort })}`);
      this.debug('open');
      this.emit({ type: 'connection-open', port: this.deps.streamPort });
    };
    this.socket.onmessage = (ev) => this.handleMessage(ev.data);
    this.socket.onerror = () => {
      this.patch({ lastError: 'stream socket error' });
      this.log(`[ab-panel] stream error ${JSON.stringify({ wsPort: this.deps.streamPort })}`);
      this.debug('error');
      this.emit({ type: 'connection-error', port: this.deps.streamPort });
    };
    this.socket.onclose = (ev) => {
      this.socket = null;
      // A reconnected stream re-sends the current frame/tabs; clear the dedupe
      // sentinels so that first post-reconnect snapshot always re-primes the
      // canvas and tab list rather than being dropped as a "duplicate".
      this.lastFrameKey = 0;
      this.lastTabsSig = '';
      if (this.disposed) return;
      this.failures += 1;
      if (this.failures >= 3) this.patch({ connection: 'failed', connectionLost: true });
      else this.patch({ connection: 'closed' });
      const data = { wsPort: this.deps.streamPort, failures: this.failures, code: ev.code, reason: ev.reason, wasClean: ev.wasClean };
      this.log(`[ab-panel] stream close ${JSON.stringify(data)}`);
      this.debug('close', data);
      this.emit({ type: 'connection-close', port: this.deps.streamPort, failures: this.failures, code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
      this.retryTimer = setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.failures, 10000));
    };
  }

  // Drop a frame whose pixels (and device dims) match the previous one — the
  // daemon's heartbeat re-broadcasts an unchanged page, and redrawing it is pure
  // cost. Returns true when the frame is a duplicate the caller should ignore.
  // The dims are mixed into the hash rather than into the payload string: a frame
  // is ~100KB of base64 at ~20Hz, so a `${data}@WxH` key would copy all of it just
  // to hash it and throw it away.
  private isDuplicateFrame(payload: string, metadata?: AgentBrowserFramePulse): boolean {
    let key = djb2(payload) ^ (payload.length | 0);
    if (metadata) key = (key ^ Math.imul(metadata.deviceWidth, 31) ^ metadata.deviceHeight) | 0;
    if (key === this.lastFrameKey) return true;
    this.lastFrameKey = key;
    return false;
  }

  /** The single frame-emission point. `withData` carries the base64 body to the
   *  consumer for a provisional paint; without it the event is a bare pulse that
   *  only paces the crisp screenshot loop. */
  private emitFrame(data: string, metadata: AgentBrowserFramePulse | undefined, withData: boolean): void {
    if (this.isDuplicateFrame(data, metadata)) return;
    this.emit({ type: 'frame-pulse', metadata, ...(withData ? { data } : {}) });
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    if (raw.length > FRAME_PULSE_THRESHOLD) {
      // `wantFrameData` gates only the parse itself: on the large path it is the
      // difference between JSON.parsing ~100KB and hashing it, which is the whole
      // point of the threshold. Emission policy lives in emitFrame. Asked here (and
      // below) rather than once up top so `status`/`tabs` never pay for it.
      if (this.deps.wantFrameData?.()) {
        try {
          const msg = JSON.parse(raw) as { type?: unknown; data?: unknown; metadata?: { deviceWidth?: unknown; deviceHeight?: unknown } };
          if (msg.type === 'frame' && typeof msg.data === 'string') {
            this.emitFrame(msg.data, frameMetadata(msg.metadata), true);
            return;
          }
        } catch {
          // Older/raw daemons may send the JPEG body without a JSON envelope. It
          // still drives the crisp capture, just without a provisional paint.
        }
      }
      if (this.isDuplicateFrame(raw)) return;
      this.emit({ type: 'frame-pulse' });
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'frame' && typeof msg.data === 'string') {
      this.emitFrame(msg.data, frameMetadata(msg.metadata), this.deps.wantFrameData?.() ?? false);
    } else if (msg.type === 'status') {
      const status: AgentBrowserStreamStatus = {
        connected: msg.connected === true,
        screencasting: msg.screencasting === true,
        ...(typeof msg.viewportWidth === 'number' ? { viewportWidth: msg.viewportWidth } : {}),
        ...(typeof msg.viewportHeight === 'number' ? { viewportHeight: msg.viewportHeight } : {}),
      };
      this.patch({ status, connectionLost: msg.connected === false });
      this.emit({ type: 'status', status });
    } else if (msg.type === 'tabs' && Array.isArray(msg.tabs)) {
      this.handleTabs(parseAgentBrowserTabs(msg.tabs));
    }
  }

  private handleTabs(next: AgentBrowserTab[]): void {
    const previousTabs = this.snap.tabs;
    if (next.length === 0 && previousTabs.length > 0) {
      this.log(`[ab-panel] empty tabs snapshot ignored ${JSON.stringify({ w: this.deps.streamPort, previous: previousTabs.length })}`);
      this.debug('tabs-empty-ignored', { previous: previousTabs.length });
      return;
    }

    // Drop an identical tab-snapshot re-broadcast (same ids, active flags, urls,
    // titles): it would otherwise re-run tab-selection and force a `setTabs`
    // re-render every heartbeat. A real change (new/closed tab, navigation,
    // focus, title) alters the signature and falls through.
    const fullSig = JSON.stringify(next.map((t) => `${t.tabId}:${t.active ? 'A' : '-'}:${t.url}:${t.title ?? ''}`));
    if (fullSig === this.lastTabsSig) return;
    this.lastTabsSig = fullSig;

    this.maybeSelectNewTab(next, previousTabs);
    this.knownTabIds = new Set(next.map((t) => t.tabId));
    const sig = JSON.stringify({ w: this.deps.streamPort, t: next.map((t) => `${t.tabId}:${t.active ? 'A' : '-'}:${t.url}`) });
    this.log(`[ab-panel] tabs msg ${sig}`);
    this.debug('tabs', { tabs: next });
    this.patch({ tabs: next });
    this.emit({ type: 'tabs', tabs: next, previousTabs });
  }

  private maybeSelectNewTab(next: AgentBrowserTab[], previousTabs: AgentBrowserTab[]): void {
    const canSelect = this.deps.canSelectTabs?.() ?? true;
    const maybeSelectTab = (tab: AgentBrowserTab, reason: string) => {
      if (!canSelect) return;
      this.log(`[ab-panel] selecting tab ${JSON.stringify({ tabId: tab.tabId, url: tab.url, reason })}`);
      this.debug('select-tab', { tabId: tab.tabId, url: tab.url, reason });
      this.deps.runCommand?.(this.deps.session, ['tab', tab.tabId], this.deps.binaryPath).then((result) => {
        if (result.exitCode !== 0) {
          this.log(`[agent-browser] tab ${tab.tabId} failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
        }
      }).catch((err) => this.log(`[agent-browser] tab ${tab.tabId} failed: ${err instanceof Error ? err.message : String(err)}`));
    };

    const pending = this.pendingNewTab;
    if (pending) {
      const tab = next.find((t) => t.tabId === pending.tabId);
      if (!tab) {
        this.pendingNewTab = null;
      } else if (tab.url !== pending.initialUrl) {
        if (!tab.active) maybeSelectTab(tab, 'new-tab-destination');
        else this.log(`[ab-panel] new tab destination observed ${JSON.stringify({ tabId: tab.tabId, url: tab.url, elapsedMs: Math.round(performance.now() - pending.seenAtMs) })}`);
        this.pendingNewTab = null;
      }
    }

    if (this.knownTabIds.size === 0) return;
    const fresh = next.filter((t) => !this.knownTabIds.has(t.tabId));
    const newest = fresh[fresh.length - 1];
    if (!newest) return;
    const duplicateUrl = !!newest.url && previousTabs.some((tab) => tab.url === newest.url);
    if (!newest.active) maybeSelectTab(newest, 'new-tab-inactive');
    else if (duplicateUrl) {
      this.pendingNewTab = { tabId: newest.tabId, initialUrl: newest.url, seenAtMs: performance.now() };
      this.log(`[ab-panel] new tab provisional ${JSON.stringify({ tabId: newest.tabId, url: newest.url })}`);
      this.debug('new-tab-provisional', { tabId: newest.tabId, url: newest.url });
    }
  }
}
