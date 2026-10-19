import { decodeViewerFrame, type BrowserResult, type ViewerFrame, type ViewerState } from '../../lib/platform/browser-automation';
import { type AgentBrowserTab, parseAgentBrowserTabs } from '../../lib/agent-browser-tab';

// Re-exported so existing importers keep resolving the tab type/parser from here.
export type { AgentBrowserTab };
export { parseAgentBrowserTabs };

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

/** Where the socket stands: none (a retry is waiting, or the connection is
 *  disposed), asking the host for a URL, dialing it, or open. */
export type AgentBrowserSocketStage = 'none' | 'requesting-url' | 'connecting' | 'open';

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
  /** Re-select the active tab whenever another one is reported active, which
   *  rebinds a screencast that stayed on the page before
   *  (`BROWSER_PROVIDER_GUI` → `reselectsActiveTab`). */
  reselectActiveTab?: boolean;
  /** The active tab the last connection to this same stream saw, against which
   *  the first report counts as a change: a new viewer does not rebind the
   *  daemon's screencast either. */
  lastActiveTabId?: string;
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
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAt: number | undefined;
  /** When the stage the socket is in began (`Date.now()`). */
  private stage: { stage: AgentBrowserSocketStage; since: number } = { stage: 'none', since: Date.now() };
  /** When the reported active tab last changed, past the baseline. */
  private activeTabChangedAt: number | undefined;
  private disposed = false;
  private failures = 0;
  private knownTabIds = new Set<string>();
  /** The active tab of the last report, or the one `lastActiveTabId` seeded. */
  private activeTabId: string | undefined;
  /** A select this connection issued, or was told of, that the daemon has yet
   *  to report active: the active-tab change it causes is not re-selected. */
  private selectIssued: string | undefined;
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
    this.activeTabId = deps.lastActiveTabId;
    void this.connect();
  }

  subscribe(listener: (event: AgentBrowserConnectionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): AgentBrowserSnapshot {
    return this.snap;
  }

  /** The socket's stage and how long it has been in it: what the
   *  controller's watchdog judges a stuck connection by. */
  socketStage(): { stage: AgentBrowserSocketStage; sinceMs: number; retryScheduled: boolean } {
    return { stage: this.stage.stage, sinceMs: Date.now() - this.stage.since, retryScheduled: this.retryTimer !== undefined };
  }

  /** When the reported active tab last changed, past a socket's baseline. */
  lastActiveTabChange(): number | undefined {
    return this.activeTabChangedAt;
  }

  /** The connection as it stands, for `dor`'s diagnostics. */
  diagnostics(): Record<string, unknown> {
    const now = Date.now();
    return {
      stream: this.deps.stream,
      state: this.snap.connection,
      socket: this.stage.stage,
      socketStageMs: now - this.stage.since,
      retryInMs: this.retryAt === undefined ? null : Math.max(0, this.retryAt - now),
      failures: this.failures,
      lastError: this.snap.lastError ?? null,
      activeTabId: this.activeTabId ?? null,
      activeTabChangedMsAgo: this.activeTabChangedAt === undefined ? null : now - this.activeTabChangedAt,
      selectIssued: this.selectIssued ?? null,
    };
  }

  send(payload: Record<string, unknown>): void {
    const ws = this.socket;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryAt = undefined;
    this.setStage('none');
    const ws = this.socket;
    this.socket = null;
    ws?.close();
  }

  private setStage(stage: AgentBrowserSocketStage): void {
    this.stage = { stage, since: Date.now() };
  }

  private emit(event: AgentBrowserConnectionEvent): void {
    for (const listener of this.listeners) listener(event);
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

  private async connect(): Promise<void> {
    this.retryTimer = undefined;
    this.retryAt = undefined;
    this.setStage('requesting-url');
    this.debug('view-url-request');
    const asked = Date.now();
    let url: string;
    try {
      url = await this.deps.viewUrl();
    } catch (err) {
      if (this.disposed) return;
      const reason = err instanceof Error ? err.message : String(err);
      this.debug('view-url-error', { error: reason, ms: Date.now() - asked });
      this.closed({ code: 0, reason, wasClean: false });
      return;
    }
    if (this.disposed) return;
    this.log(`[ab-panel] connecting viewer ${JSON.stringify({ stream: this.deps.stream })}`);
    this.debug('connect', { ms: Date.now() - asked });
    this.setStage('connecting');
    const socket = this.socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      this.failures = 0;
      this.setStage('open');
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
      this.setStage('none');
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
    const delayMs = Math.min(1000 * 2 ** this.failures, 10000);
    this.setStage('none');
    this.retryAt = Date.now() + delayMs;
    this.debug('retry', { delayMs });
    this.retryTimer = setTimeout(() => void this.connect(), delayMs);
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

    // A tab selected for being new is where the pane is going: the active
    // tab this report names is not selected over it.
    const selectedNew = this.maybeSelectNewTab(next, previousTabs);
    this.maybeReselectActiveTab(next, !selectedNew);
    this.knownTabIds = new Set(next.map((t) => t.tabId));
    const sig = JSON.stringify({ stream: this.deps.stream, t: next.map((t) => `${t.tabId}:${t.active ? 'A' : '-'}:${t.url}`) });
    this.log(`[ab-panel] tabs msg ${sig}`);
    this.debug('tabs', { tabs: next });
    this.patch({ tabs: next });
    this.emit({ type: 'tabs', tabs: next, previousTabs });
  }

  /** A select of `tabId` made elsewhere (the pane's tab strip): the active-tab
   *  change it causes is not selected again. */
  noteSelected(tabId: string): void {
    this.selectIssued = tabId;
  }

  /** Select the active tab again, rebinding the daemon's screencast to it;
   *  false when there is none to select or selecting is not this pane's. */
  reselectActiveTab(reason: string): boolean {
    const active = this.snap.tabs.find((t) => t.active);
    if (!active || !this.canSelect()) return false;
    this.select(active, reason);
    return true;
  }

  private canSelect(): boolean {
    return this.deps.canSelectTabs?.() ?? true;
  }

  private select(tab: AgentBrowserTab, reason: string): void {
    if (!this.canSelect()) return;
    this.selectIssued = tab.tabId;
    this.log(`[ab-panel] selecting tab ${JSON.stringify({ tabId: tab.tabId, url: tab.url, reason })}`);
    this.debug('select-tab', { tabId: tab.tabId, url: tab.url, reason });
    this.deps.selectTab?.(tab.tabId).then((result) => {
      if (!result.ok) this.log(`[agent-browser] tab ${tab.tabId} failed: ${result.error ?? 'no reason given'}`);
    }).catch((err) => this.log(`[agent-browser] tab ${tab.tabId} failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /**
   * agent-browser's daemon moves its screencast only on its own tab switch:
   * an active tab it changed by itself — a popup it reports active, a closed
   * active tab another replaced — leaves the stream on the old page, sending
   * nothing. Selecting the new active tab rebinds it. A change this connection
   * selected, or was told of, is not selected again, and a select of the tab
   * already active changes nothing, so no report answers with another.
   */
  private maybeReselectActiveTab(next: AgentBrowserTab[], allowed: boolean): void {
    const active = next.find((t) => t.active);
    const before = this.activeTabId;
    if (!active) return;
    this.activeTabId = active.tabId;
    const changed = before !== undefined && before !== active.tabId;
    if (changed) this.activeTabChangedAt = Date.now();
    if (this.selectIssued === active.tabId) {
      this.selectIssued = undefined;
      return;
    }
    if (!changed || !allowed || !this.deps.reselectActiveTab) return;
    this.debug('active-tab-changed', { from: before, to: active.tabId });
    this.select(active, 'active-tab-changed');
  }

  /** Whether it selected a tab. */
  private maybeSelectNewTab(next: AgentBrowserTab[], previousTabs: AgentBrowserTab[]): boolean {
    let selected = false;
    const select = (tab: AgentBrowserTab, reason: string) => {
      this.select(tab, reason);
      selected = true;
    };
    const pending = this.pendingNewTab;
    if (pending) {
      const tab = next.find((t) => t.tabId === pending.tabId);
      if (!tab) {
        this.pendingNewTab = null;
      } else if (tab.url !== pending.initialUrl) {
        if (!tab.active) select(tab, 'new-tab-destination');
        else this.log(`[ab-panel] new tab destination observed ${JSON.stringify({ tabId: tab.tabId, url: tab.url, elapsedMs: Math.round(performance.now() - pending.seenAtMs) })}`);
        this.pendingNewTab = null;
      }
    }

    if (this.knownTabIds.size === 0) return selected;
    const fresh = next.filter((t) => !this.knownTabIds.has(t.tabId));
    const newest = fresh[fresh.length - 1];
    if (!newest) return selected;
    const duplicateUrl = !!newest.url && previousTabs.some((tab) => tab.url === newest.url);
    if (!newest.active) select(newest, 'new-tab-inactive');
    else if (duplicateUrl) {
      this.pendingNewTab = { tabId: newest.tabId, initialUrl: newest.url, seenAtMs: performance.now() };
      this.log(`[ab-panel] new tab provisional ${JSON.stringify({ tabId: newest.tabId, url: newest.url })}`);
      this.debug('new-tab-provisional', { tabId: newest.tabId, url: newest.url });
    }
    return selected;
  }
}
