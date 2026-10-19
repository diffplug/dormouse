import { decodeViewerFrame, type BrowserResult, type ViewerFrame, type ViewerState } from '../../lib/platform/browser-automation';
import { type AgentBrowserTab, parseAgentBrowserTabs } from '../../lib/agent-browser-tab';
import { messageOf } from '../../lib/errors';

// Re-exported so existing importers keep resolving the tab type/parser from here.
export type { AgentBrowserTab };
export { parseAgentBrowserTabs };

/** How long the host may take to grant a viewer URL, and the socket to open
 *  on it, before the attempt counts as a close and is retried. */
export const VIEW_URL_TIMEOUT_MS = 15_000;
export const DIAL_TIMEOUT_MS = 10_000;

export type AgentBrowserConnectionState = 'connecting' | 'open' | 'closed' | 'failed';

export interface AgentBrowserStreamStatus {
  connected: boolean;
  screencasting: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
  /** A popped-out window's, as its page reports it. */
  devicePixelRatio?: number;
}

export interface AgentBrowserSnapshot {
  connection: AgentBrowserConnectionState;
  session: string;
  stream: number;
  tabs: AgentBrowserTab[];
  status: AgentBrowserStreamStatus | null;
  lastError?: string;
}

export type AgentBrowserConnectionEvent =
  | { type: 'connection-open'; stream: number }
  | { type: 'connection-close'; stream: number; failures: number; code: number; reason: string; wasClean: boolean }
  | { type: 'connection-error'; stream: number }
  | { type: 'status'; status: AgentBrowserStreamStatus }
  | { type: 'tabs'; tabs: AgentBrowserTab[]; previousTabs: AgentBrowserTab[] }
  /** The active tab committed a navigation. Fires at commit; the `tabs`
   *  snapshot may lag a commit: agent-browser refreshes it when the driving
   *  command completes, while Playwright polls. See docs/specs/dor-browser.md
   *  → "Viewer Socket". */
  | { type: 'url'; url: string }
  /** A popped-out window's page, as its browser reports it. */
  | { type: 'page'; url: string; title: string | null }
  /** Where the host's sync-to-pane stands for `engagement`. */
  | Extract<ViewerState, { type: 'sync' }>
  /** A frame to paint: provisional (CSS resolution) or crisp. */
  | ({ type: 'frame' } & ViewerFrame);

/** Where the socket stands: asking the host for a URL, dialing it, open, or
 *  waiting to retry. Every stage but `open` carries its own deadline, so the
 *  connection is never left with nothing in flight. */
export type AgentBrowserSocketStage = 'requesting-url' | 'connecting' | 'open' | 'retrying';

export interface AgentBrowserConnectionDeps {
  session: string;
  /** The live browser's stream, as the host's launch or attach named it. */
  stream: number;
  /** A fresh single-use URL for the host's viewer socket on it. */
  viewUrl: () => Promise<string>;
  /** Make `tabId` the active tab. */
  selectTab?: (tabId: string) => Promise<BrowserResult>;
  /** Whether a newly observed inactive tab is selected for the pane: only a
   *  headless view, never a popped-out window the user drives. */
  canSelectTabs?: () => boolean;
  log?: (message: string) => void;
  /** Record a lifecycle event in the Surface's always-on debug ring. */
  debug?: (event: string, data?: Record<string, unknown>) => void;
}

export function createAgentBrowserConnection(deps: AgentBrowserConnectionDeps): AgentBrowserConnection {
  return new AgentBrowserConnection(deps);
}

/**
 * The webview's end of one viewer socket (docs/specs/dor-browser.md → "Viewer
 * Socket"): frames arrive binary, state as JSON, both already deduplicated by
 * the host; input goes back as JSON. A socket that closes is dialed again with
 * a fresh URL, backing off, and the consumer counts the failures.
 */
export class AgentBrowserConnection {
  private readonly listeners = new Set<(event: AgentBrowserConnectionEvent) => void>();
  private socket: WebSocket | null = null;
  /** The one timer the stage runs: a retry's delay, or a URL or dial
   *  deadline. */
  private stageTimer: ReturnType<typeof setTimeout> | undefined;
  private stage: { stage: AgentBrowserSocketStage; since: number } = { stage: 'requesting-url', since: Date.now() };
  /** Bumped by each dial: a late answer or event of an older one is dropped. */
  private attempt = 0;
  private disposed = false;
  /** Closes since a socket last proved healthy — its first message, not its
   *  open, so a socket that opens and closes at once still counts. */
  private failures = 0;
  private healthy = false;
  private readonly warnedThrows = new Set<string>();
  private knownTabIds = new Set<string>();
  private pendingNewTab: { tabId: string; initialUrl: string; seenAtMs: number } | null = null;
  private snap: AgentBrowserSnapshot;

  constructor(private readonly deps: AgentBrowserConnectionDeps) {
    this.snap = {
      connection: 'connecting',
      session: deps.session,
      stream: deps.stream,
      tabs: [],
      status: null,
    };
    void this.connect();
  }

  subscribe(listener: (event: AgentBrowserConnectionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): AgentBrowserSnapshot {
    return this.snap;
  }

  /** The connection as it stands, for `dor`'s diagnostics. */
  diagnostics(): Record<string, unknown> {
    return {
      stream: this.deps.stream,
      state: this.snap.connection,
      socket: this.stage.stage,
      socketStageMs: Date.now() - this.stage.since,
      failures: this.failures,
      lastError: this.snap.lastError ?? null,
    };
  }

  send(payload: Record<string, unknown>): void {
    const ws = this.socket;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.stageTimer);
    this.stageTimer = undefined;
    const ws = this.socket;
    this.socket = null;
    ws?.close();
  }

  /** Enter `stage`, its one timer (`after`) replacing the last. */
  private setStage(stage: AgentBrowserSocketStage, after?: { ms: number; run: () => void }): void {
    clearTimeout(this.stageTimer);
    this.stageTimer = after && !this.disposed ? setTimeout(after.run, after.ms) : undefined;
    this.stage = { stage, since: Date.now() };
  }

  /**
   * Each listener alone: one that throws must not keep the next from hearing
   * the event, nor the connection from the work after it — a throw out of a
   * close's listeners once could leave a pane with no socket and no retry.
   */
  private emit(event: AgentBrowserConnectionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.debug('listener-threw', { event: event.type, message: messageOf(error), stack: error instanceof Error ? error.stack : undefined });
        if (!this.warnedThrows.has(event.type)) {
          this.warnedThrows.add(event.type);
          console.warn(`[ab-panel] a '${event.type}' listener threw:`, error);
        }
      }
    }
  }

  private debug(event: string, data?: Record<string, unknown>): void {
    this.deps.debug?.(event, { stream: this.deps.stream, ...data });
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  private patch(next: Partial<AgentBrowserSnapshot>): void {
    this.snap = { ...this.snap, ...next };
  }

  /** Ask the host for a URL and dial it, each bounded: a deadline that
   *  passes, like anything that throws on the way, is a close, retried. */
  private async connect(): Promise<void> {
    if (this.disposed) return;
    const attempt = ++this.attempt;
    const current = () => !this.disposed && this.attempt === attempt;
    const asked = Date.now();
    this.setStage('requesting-url', { ms: VIEW_URL_TIMEOUT_MS, run: () => this.abandon(attempt, 'the host granted no viewer URL in time') });
    this.debug('view-url-request');
    let url: string;
    try {
      url = await this.deps.viewUrl();
    } catch (err) {
      if (!current()) return;
      const reason = messageOf(err);
      this.debug('view-url-error', { error: reason, ms: Date.now() - asked });
      this.closed({ code: 0, reason, wasClean: false });
      return;
    }
    if (!current()) return;
    try {
      this.dial(url, attempt);
      this.debug('connect', { ms: Date.now() - asked });
    } catch (err) {
      this.abandon(attempt, `could not dial the viewer: ${messageOf(err)}`);
    }
  }

  /** Give up on attempt `attempt`: its socket, if any, is closed unheard —
   *  each handler ignores a socket that is no longer `this.socket`. */
  private abandon(attempt: number, reason: string): void {
    if (this.disposed || this.attempt !== attempt) return;
    this.attempt += 1;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.closed({ code: 0, reason, wasClean: false });
  }

  private dial(url: string, attempt: number): void {
    this.log(`[ab-panel] connecting viewer ${JSON.stringify({ stream: this.deps.stream })}`);
    this.setStage('connecting', { ms: DIAL_TIMEOUT_MS, run: () => this.abandon(attempt, 'the viewer socket did not open in time') });
    this.healthy = false;
    const socket = this.socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.setStage('open');
      this.patch({ connection: 'open' });
      this.log(`[ab-panel] viewer open ${JSON.stringify({ stream: this.deps.stream })}`);
      this.debug('open');
      this.emit({ type: 'connection-open', stream: this.deps.stream });
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      if (!this.healthy) {
        this.healthy = true;
        this.failures = 0;
      }
      this.handleMessage(ev.data);
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.patch({ lastError: 'viewer socket error' });
      this.log(`[ab-panel] viewer error ${JSON.stringify({ stream: this.deps.stream })}`);
      this.debug('error');
      this.emit({ type: 'connection-error', stream: this.deps.stream });
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.disposed) return;
      this.closed({ code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
    };
  }

  /** The socket closed, or could not be asked for: count it, and dial again
   *  — scheduled before anyone hears of the close, so nothing a listener does
   *  can leave the connection with no retry. */
  private closed({ code, reason, wasClean }: { code: number; reason: string; wasClean: boolean }): void {
    this.failures += 1;
    this.patch({ connection: this.failures >= 3 ? 'failed' : 'closed' });
    const delayMs = Math.min(1000 * 2 ** this.failures, 10000);
    this.setStage('retrying', { ms: delayMs, run: () => void this.connect() });
    const data = { stream: this.deps.stream, failures: this.failures, code, reason, wasClean };
    this.log(`[ab-panel] viewer close ${JSON.stringify(data)}`);
    this.debug('close', { ...data, retryInMs: delayMs });
    this.emit({ type: 'connection-close', ...data });
  }

  private handleMessage(raw: unknown): void {
    if (raw instanceof ArrayBuffer) {
      const frame = decodeViewerFrame(raw);
      if (frame) this.emit({ type: 'frame', ...frame });
      return;
    }
    if (typeof raw !== 'string') return;
    let msg: ViewerState;
    try {
      msg = JSON.parse(raw) as ViewerState;
    } catch {
      return;
    }
    if (msg.type === 'status') {
      const status: AgentBrowserStreamStatus = {
        connected: msg.connected === true,
        screencasting: msg.screencasting === true,
        ...(typeof msg.viewportWidth === 'number' ? { viewportWidth: msg.viewportWidth } : {}),
        ...(typeof msg.viewportHeight === 'number' ? { viewportHeight: msg.viewportHeight } : {}),
        ...(typeof msg.devicePixelRatio === 'number' ? { devicePixelRatio: msg.devicePixelRatio } : {}),
      };
      this.patch({ status });
      this.emit({ type: 'status', status });
    } else if (msg.type === 'tabs' && Array.isArray(msg.tabs)) {
      this.handleTabs(parseAgentBrowserTabs(msg.tabs));
    } else if (msg.type === 'url' && typeof msg.url === 'string') {
      this.debug('url', { url: msg.url });
      this.emit({ type: 'url', url: msg.url });
    } else if (msg.type === 'page' && typeof msg.url === 'string') {
      this.debug('page', { url: msg.url });
      this.emit({ type: 'page', url: msg.url, title: typeof msg.title === 'string' ? msg.title : null });
    } else if (msg.type === 'sync' && (msg.state === 'applying' || msg.state === 'synced' || msg.state === 'off') && typeof msg.engagement === 'string') {
      this.debug('sync', { state: msg.state });
      this.emit({ type: 'sync', state: msg.state, engagement: msg.engagement });
    }
  }

  private handleTabs(next: AgentBrowserTab[]): void {
    const previousTabs = this.snap.tabs;
    // A transient empty report keeps the last nonempty list; the first list is
    // the baseline no tab in it counts as new against.
    if (next.length === 0 && previousTabs.length > 0) {
      this.log(`[ab-panel] empty tabs snapshot ignored ${JSON.stringify({ stream: this.deps.stream, previous: previousTabs.length })}`);
      this.debug('tabs-empty-ignored', { previous: previousTabs.length });
      return;
    }

    this.maybeSelectNewTab(next, previousTabs);
    this.knownTabIds = new Set(next.map((t) => t.tabId));
    const sig = JSON.stringify({ stream: this.deps.stream, t: next.map((t) => `${t.tabId}:${t.active ? 'A' : '-'}:${t.url}`) });
    this.log(`[ab-panel] tabs msg ${sig}`);
    const active = next.find((t) => t.active);
    this.debug('tabs', { count: next.length, active: active?.tabId ?? null, url: active?.url ?? null });
    this.patch({ tabs: next });
    this.emit({ type: 'tabs', tabs: next, previousTabs });
  }

  private maybeSelectNewTab(next: AgentBrowserTab[], previousTabs: AgentBrowserTab[]): void {
    const canSelect = this.deps.canSelectTabs?.() ?? true;
    const maybeSelectTab = (tab: AgentBrowserTab, reason: string) => {
      if (!canSelect) return;
      this.log(`[ab-panel] selecting tab ${JSON.stringify({ tabId: tab.tabId, url: tab.url, reason })}`);
      this.debug('select-tab', { tabId: tab.tabId, url: tab.url, reason });
      this.deps.selectTab?.(tab.tabId).then((result) => {
        if (!result.ok) this.log(`[agent-browser] tab ${tab.tabId} failed: ${result.error ?? 'no reason given'}`);
      }).catch((err) => this.log(`[agent-browser] tab ${tab.tabId} failed: ${messageOf(err)}`));
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
