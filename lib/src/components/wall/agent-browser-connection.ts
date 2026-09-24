import { decodeViewerFrame, type BrowserResult, type ViewerFrame, type ViewerState } from '../../lib/platform/browser-automation';
import { type AgentBrowserTab, parseAgentBrowserTabs } from '../../lib/agent-browser-tab';

// Re-exported so existing importers keep resolving the tab type/parser from here.
export type { AgentBrowserTab };
export { parseAgentBrowserTabs };

const DEBUG_RING_LIMIT = 300;

export type AgentBrowserConnectionState = 'connecting' | 'open' | 'closed' | 'failed';

export interface AgentBrowserStreamStatus {
  connected: boolean;
  screencasting: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
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
   *  snapshot refreshes only when the driving command completes, which for a
   *  slow page is the whole load (docs/specs/dor-browser.md → "Viewer
   *  Socket"). */
  | { type: 'url'; url: string }
  /** A popped-out window's page, as its browser reports it. */
  | { type: 'page'; url: string; title: string | null }
  /** A frame to paint: provisional (CSS resolution) or crisp. */
  | ({ type: 'frame' } & ViewerFrame)
  | { type: 'debug'; event: AgentBrowserDebugEvent };

export interface AgentBrowserDebugEvent {
  ts: number;
  session: string;
  stream: number;
  event: string;
  data?: unknown;
}

export interface AgentBrowserConnectionDeps {
  session: string;
  /** The live browser's stream, as the host's launch or attach named it. */
  stream: number;
  /** A fresh single-use URL for the host's viewer socket on it. */
  viewUrl: () => Promise<string>;
  /** Make `tabId` the active tab. */
  selectTab?: (tabId: string) => Promise<BrowserResult>;
  canSelectTabs?: () => boolean;
  log?: (message: string) => void;
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
  private readonly debugEvents: AgentBrowserDebugEvent[] = [];
  private socket: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private failures = 0;
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
      stream: this.deps.stream,
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
    let url: string;
    try {
      url = await this.deps.viewUrl();
    } catch (err) {
      if (this.disposed) return;
      const reason = err instanceof Error ? err.message : String(err);
      this.debug('view-url-error', { error: reason });
      this.closed({ code: 0, reason, wasClean: false });
      return;
    }
    if (this.disposed) return;
    this.log(`[ab-panel] connecting viewer ${JSON.stringify({ stream: this.deps.stream })}`);
    this.debug('connect');
    const socket = this.socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      this.failures = 0;
      this.patch({ connection: 'open' });
      this.log(`[ab-panel] viewer open ${JSON.stringify({ stream: this.deps.stream })}`);
      this.debug('open');
      this.emit({ type: 'connection-open', stream: this.deps.stream });
    };
    socket.onmessage = (ev) => this.handleMessage(ev.data);
    socket.onerror = () => {
      this.patch({ lastError: 'viewer socket error' });
      this.log(`[ab-panel] viewer error ${JSON.stringify({ stream: this.deps.stream })}`);
      this.debug('error');
      this.emit({ type: 'connection-error', stream: this.deps.stream });
    };
    socket.onclose = (ev) => {
      this.socket = null;
      if (this.disposed) return;
      this.closed({ code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
    };
  }

  /** The socket closed, or could not be asked for: count it, and dial again. */
  private closed({ code, reason, wasClean }: { code: number; reason: string; wasClean: boolean }): void {
    this.failures += 1;
    this.patch({ connection: this.failures >= 3 ? 'failed' : 'closed' });
    const data = { stream: this.deps.stream, failures: this.failures, code, reason, wasClean };
    this.log(`[ab-panel] viewer close ${JSON.stringify(data)}`);
    this.debug('close', data);
    this.emit({ type: 'connection-close', ...data });
    if (this.disposed) return;
    this.retryTimer = setTimeout(() => void this.connect(), Math.min(1000 * 2 ** this.failures, 10000));
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
    }
  }

  private handleTabs(next: AgentBrowserTab[]): void {
    const previousTabs = this.snap.tabs;
    if (next.length === 0 && previousTabs.length > 0) {
      this.log(`[ab-panel] empty tabs snapshot ignored ${JSON.stringify({ stream: this.deps.stream, previous: previousTabs.length })}`);
      this.debug('tabs-empty-ignored', { previous: previousTabs.length });
      return;
    }

    this.maybeSelectNewTab(next, previousTabs);
    this.knownTabIds = new Set(next.map((t) => t.tabId));
    const sig = JSON.stringify({ stream: this.deps.stream, t: next.map((t) => `${t.tabId}:${t.active ? 'A' : '-'}:${t.url}`) });
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
      this.deps.selectTab?.(tab.tabId).then((result) => {
        if (!result.ok) this.log(`[agent-browser] tab ${tab.tabId} failed: ${result.error ?? 'no reason given'}`);
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
