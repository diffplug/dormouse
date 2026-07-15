/**
 * Surface-scoped, module-level controller for an agent-browser pane (see
 * docs/specs/dor-browser.md → "Agent-Browser Connection"). Mirrors
 * `terminal-lifecycle.ts`: the live non-React machinery — stream connection,
 * screenshot loop, CDP observer, viewport-sync state machine, pop-out/pop-in
 * orchestration + auto-revert, canonical-URL tracking, input bridging, params
 * persistence, and the screen/chrome registration — lives OUTSIDE React in a
 * registry keyed by surface id. `AgentBrowserPanel` becomes a thin view that
 * mounts a canvas, feeds params/visibility, and subscribes to a snapshot.
 *
 * Lifetime (deliberately surface-scoped, not panel-scoped):
 *   - created on first panel mount (`acquire…`),
 *   - SURVIVES unmount (minimize, layout churn, React StrictMode) —
 *     minimize no longer synchronously disposes the connection; the
 *     detach-as-hidden park (1s debounce) tears it down, reaching the same
 *     zero-resource end state with less thrash,
 *   - disposed only by `dispose…` at kill / render-swap in Wall.tsx.
 *
 * Disposing releases CLIENT-side resources only; it never runs
 * `agent-browser close`. Tearing down the daemon/session is a policy decision
 * owned by `closeAgentBrowserSession` in Wall.tsx.
 */
import { getPlatform } from '../../lib/platform';
import { readTextFromClipboard } from '../../lib/clipboard';
import { isAbDebugLogsEnabled } from '../../lib/feature-flags';
import {
  registerAgentBrowserScreen,
  type ChromeActions,
  type ChromeSnapshot,
  type RenderMode,
  type ScreenActions,
  type ScreenRegistration,
  type ScreenSnapshot,
  type ScreenState,
  openAgentBrowserScreenModal,
} from './agent-browser-screen';
import { hostPathDisplay, tabDisplayTitle } from './browser-url';
import { clearAgentBrowserSessionClosed, isAgentBrowserSessionClosed } from './agent-browser-sessions';
import {
  EDIT_OPS,
  SPECIAL_KEYS,
  modifiers,
  virtualKeyCode,
} from './agent-browser-input';
import { createScreenshotLoop, type ScreenshotLoop } from './agent-browser-screenshot-loop';
import {
  createAgentBrowserConnection,
  type AgentBrowserConnection,
  type AgentBrowserStreamStatus as StreamStatus,
  type AgentBrowserTab as StreamTab,
} from './agent-browser-connection';

// A hidden-but-mounted (or detached) pane parks after this delay rather than
// immediately, so quick visibility flips — or a StrictMode unmount→remount —
// don't tear down and rebuild the stream connection.
export const HIDDEN_PARK_DELAY_MS = 1000;
/** Keep low-latency stream painting active briefly after pointer input. Continuous
 *  movement extends the window; idle animated pages stay on the cheaper crisp path. */
export const PROVISIONAL_INPUT_WINDOW_MS = 250;

// The high-rate `[ab-panel]` stream/screenshot diagnostics fire per frame
// (~20Hz), so the flag is read ONCE at module load and cached: toggling needs a
// reload, which is the right trade for a hot loop. The connection's always-on
// debug ring is unaffected. `localStorage.setItem('dormouse.flags.abDebugLogs',
// 'true')` + reload to enable.
let abDebugLogsEnabled: boolean | undefined;
function abDebugLog(message: string): void {
  if (abDebugLogsEnabled === undefined) abDebugLogsEnabled = isAbDebugLogsEnabled();
  if (abDebugLogsEnabled) console.log(message);
}

// SYNCED is "browser viewport CSS size == pane CSS size". The screencast is
// always delivered at CSS-pixel resolution — the frame never encodes the
// browser's DPR (verified 0.27.0: `set viewport 800 600 2` yields the same
// 800×600 JPEG as @1) — so DPR is unrecoverable from frames and plays no part
// in the match; we still *issue* displayDpr so the page renders at the right
// density. Dims can be a pixel off after rounding, so compare with a tolerance.
const DIM_TOLERANCE = 1;

function dimsMatch(a: { w: number; h: number }, b: { w: number; h: number }): boolean {
  return Math.abs(a.w - b.w) <= DIM_TOLERANCE && Math.abs(a.h - b.h) <= DIM_TOLERANCE;
}

// A pop-out/pop-in relaunch restores a single URL. A transient about:blank — a
// stray tab the close+reopen can momentarily surface, or a freshly-relaunched
// blank page — must never be treated as the page to restore, or the real URL is
// lost on the way back in. Mirrors the host's usableRelaunchUrl.
function isRestorableUrl(url: string | null | undefined): url is string {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  return trimmed !== '' && trimmed !== 'about:blank';
}

function parseCdpUrl(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { data?: { result?: unknown }; result?: unknown; url?: unknown };
    const value = parsed.data?.result ?? parsed.result ?? parsed.url;
    if (typeof value === 'string' && value.startsWith('ws://')) return value;
  } catch {
    // Plain text is the common CLI output.
  }
  return trimmed.match(/ws:\/\/\S+/)?.[0] ?? null;
}

/** Best-effort screen rect for positioning a popped-out window over the pane.
 *  VS Code webviews can't read true screen coords (the host then centers); on
 *  standalone, window.screenX/Y offset the pane's viewport rect into screen
 *  space. */
function paneScreenRect(el: HTMLElement | null | undefined): { x: number; y: number; width: number; height: number } | undefined {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  const sx = typeof window.screenX === 'number' ? window.screenX : 0;
  const sy = typeof window.screenY === 'number' ? window.screenY : 0;
  return { x: Math.round(sx + r.left), y: Math.round(sy + r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

/** The DOM-free key shape the controller's keyboard bridge consumes. A
 *  React.KeyboardEvent / DOM KeyboardEvent satisfies this structurally, so the
 *  view forwards its events without the controller depending on the DOM. */
export type KeyLike = {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

/** Canonical persisted params for a browser surface, as the view reads them. */
export interface AgentBrowserSurfaceParams {
  surfaceType?: string;
  renderMode?: RenderMode;
  session?: string;
  key?: string;
  wsPort?: number;
  binaryPath?: string;
  url?: string;
  syncEngaged?: boolean;
  poppedOut?: boolean;
}

/** The live DOM bindings a mounted view lends the controller. `attachView`
 *  wires these; `detach()` returns them. */
export interface AgentBrowserViewSink {
  /** Draw target for device-resolution screenshots. */
  canvas: HTMLCanvasElement;
  /** The content area — observed for resize and read for pane rect / pop-out
   *  positioning. */
  viewport: HTMLElement;
  /** Persist a param write into the surface's engine metadata. */
  updateParameters(params: Record<string, unknown>): void;
  /** Set the persisted panel title (door labels / session save). */
  setTitle(title: string): void;
  /** Ask the view to swap this surface to the iframe renderer. The ≥2-tab
   *  typed-confirm gate and the Wall's `onSwapRenderMode` are view concerns; the
   *  view reads tabs from the snapshot and decides. */
  requestIframeSwap(): void;
}

/** The single view-facing snapshot, consumed via `useSyncExternalStore`. Only
 *  fields the view actually renders live here — parked state is read by tests via
 *  `isParked()`, and session comes straight from params, so neither belongs in
 *  the snapshot (keeping `parked` out also avoids a wasted re-render per park). */
export interface AgentBrowserViewSnapshot {
  tabs: StreamTab[];
  status: StreamStatus | null;
  connectionLost: boolean;
  hasFrame: boolean;
  poppedOut: boolean;
  streamPort: number | undefined;
}

const EMPTY_TABS: StreamTab[] = [];

export class AgentBrowserSurfaceController {
  readonly id: string;

  // --- params (mirrors of the persisted blob) ---
  private session: string | undefined;
  private binaryPath: string | undefined;
  private wsPort: number | undefined;
  private paramsUrl: string | undefined;
  private paramsKey: string | null;
  private paramsSyncEngaged: boolean | undefined;

  // --- stream connection ---
  // The `streamPort` the connection targets: seeded from params.wsPort, then
  // driven by recovery / relaunch. Distinct from `wsPort` (the param mirror).
  private streamPort: number | undefined;
  private recoverySeq = 0;
  private connection: AgentBrowserConnection | null = null;
  private screenshotLoop: ScreenshotLoop | null = null;
  private connectionUnsub: (() => void) | null = null;
  private connectionKey: string | null = null;
  // The `session:streamPort` the connection last (re)connected to. An unpark
  // reconnects to the same identity, so the last good frame is still valid and
  // must not be blanked to the placeholder; only a real identity change resets
  // hasFrame.
  private lastConnectedIdentity: string | null = null;
  private liveStreamPort: number | null = null;

  // --- view state (the snapshot) ---
  private status: StreamStatus | null = null;
  private hasFrame = false;
  private connectionLost = false;
  private tabs: StreamTab[] = EMPTY_TABS;
  private poppedOut: boolean;
  private parked = false;

  // --- relaunch orchestration ---
  // Gate auto-revert: only treat a dropped stream as "window closed" once the
  // headed stream has actually connected (avoids reverting mid-relaunch).
  private headedConnected = false;
  // True while a headed↔headless relaunch is in flight. The relaunch closes the
  // current stream before reopening on a new port, so that expected drop must
  // not be read as "the headed window closed" (it would auto-revert mid-pop-out)
  // nor trigger stale-port recovery (which could spawn a competing daemon).
  private relaunching = false;

  // --- visibility / parking ---
  private visible = true;
  private parkTimer: ReturnType<typeof setTimeout> | undefined;

  // --- sync-to-pane ---
  private syncEngaged: boolean;
  private device = { width: 1280, height: 720 };
  // The pane size we last issued `set viewport` for; null while not driving the
  // viewport (device/custom, or never issued). Used both to skip redundant
  // re-issues and to detect an external `set …` taking over.
  private lastIssued: { w: number; h: number; dpr: number } | null = null;
  // True once a frame has confirmed `lastIssued` actually landed. Until then,
  // frames still at the browser's pre-resize size are our own `set` not having
  // taken effect yet — not an external override.
  private syncConfirmed = false;
  private lastPublishedScreen: ScreenSnapshot | null = null;
  // Debounce for pushing a pane resize back to the browser as a `set viewport`
  // (armed by the pane-size observer below, only while sync is engaged).
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;

  // --- cached pane size (avoid per-frame forced layout) ---
  // computeScreenSnapshot() and maybeDisengageSync() run on EVERY non-duplicate
  // stream frame (~20Hz); a getBoundingClientRect() there forces layout each
  // time. A ResizeObserver active for the whole attach duration keeps the pane's
  // content-box size cached (the viewport div has no border/padding, so
  // contentRect matches the gBCR those hot paths used to read). null ⇒ no attached
  // view — treat as 0×0 / skip, matching the old no-element behavior. The
  // correctness-critical reads in issueSyncToPane / paneScreenRect stay live gBCR.
  // The same observer also drives viewport-sync (debounced), so there is one
  // observer on the pane, not two.
  private paneSize: { w: number; h: number } | null = null;
  private paneSizeObserver: ResizeObserver | null = null;

  // --- canonical URL tracking ---
  // The newest non-blank active-tab URL observed from the live stream. Kept
  // separate from paramsUrl: engine param writes can lag a tab message, but
  // pop-in/auto-revert must carry the page the user just navigated to.
  private latestRestorableUrl: string | undefined;

  // --- screen / chrome registration ---
  private registration: ScreenRegistration | null = null;
  private chrome: ChromeSnapshot;
  private lastChromePushed: ChromeSnapshot | null = null;
  private lastTitle: string | null = null;
  private readonly screenActions: ScreenActions;
  private readonly chromeActions: ChromeActions;

  // --- CDP observer (while popped out) ---
  private cdpKey: string | null = null;
  private cdpTeardown: (() => void) | null = null;

  // --- stale-port recovery ---
  // Bumped on every recovery attempt so a superseded in-flight `stream status`
  // query is dropped (mirrors the old effect's cleanup `cancelled` flag).
  private recoveryGen = 0;

  // --- view binding ---
  private sink: AgentBrowserViewSink | null = null;
  private attachToken: object | null = null;
  // "The canvas changed without the crisp loop drawing it." Bumped on attachView
  // (a fresh view mounts blank) and on every provisional paint (CSS-resolution
  // pixels land behind the loop's back). The screenshot loop folds this into its
  // byte-dedup key so an identical capture still repaints — otherwise it would
  // skip the redundant bytes and leave the canvas blank, or blurry, until the
  // page happens to change.
  private drawGeneration = 0;
  // Latest-wins generation shared by provisional stream decodes and crisp host
  // screenshots. A late low-resolution decode must never overwrite a newer crisp
  // frame (or a provisional frame from a later pointer move).
  private frameDrawSeq = 0;
  private provisionalUntil = 0;
  private provisionalPaintGeneration = 0;
  // Param writes buffered while detached (a minimized popped-out pane can still
  // observe URL changes); flushed on the next attach.
  private pendingParams = new Map<string, unknown>();
  private pendingTitle: string | null = null;

  private started = false;
  private disposed = false;

  private readonly viewListeners = new Set<() => void>();
  private viewSnapshot: AgentBrowserViewSnapshot;

  constructor(id: string, params: AgentBrowserSurfaceParams) {
    this.id = id;
    this.session = params.session;
    this.binaryPath = params.binaryPath;
    this.wsPort = params.wsPort;
    this.streamPort = params.wsPort;
    this.paramsUrl = params.url;
    this.paramsKey = params.key ?? null;
    this.paramsSyncEngaged = params.syncEngaged;
    this.latestRestorableUrl = isRestorableUrl(params.url) ? params.url : undefined;
    // poppedOut is derived from the canonical renderMode; an unset mode (a direct
    // mount in tests) is not popped out.
    this.poppedOut = params.renderMode === 'ab-popout';
    // A fresh surface auto-engages sync (no persisted flag); a re-attached one
    // restores whatever was persisted into the layout blob.
    this.syncEngaged = params.syncEngaged ?? true;
    this.chrome = { url: '', displayUrl: '', title: null, key: this.paramsKey };

    // Stable across the controller's life (reads `this`), so the registered
    // screen controller never goes stale.
    this.screenActions = {
      engageSync: () => {
        // Clear lastIssued so the issue below isn't skipped, and issue now rather
        // than relying on a syncEngaged effect — re-selecting Sync while already
        // engaged must still reclaim the viewport (e.g. from an external `set`).
        this.lastIssued = null;
        this.setSyncEngaged(true);
        this.issueSyncToPane();
      },
      applyDevice: (name) => {
        this.lastIssued = null;
        this.setSyncEngaged(false);
        this.runAgentBrowser(['set', 'device', name]);
      },
      applyViewport: (w, h, dpr) => {
        this.lastIssued = null;
        this.setSyncEngaged(false);
        this.runAgentBrowser(['set', 'viewport', String(w), String(h), String(dpr)]);
      },
      openModal: () => openAgentBrowserScreenModal(this.id),
      setRenderMode: (mode) => {
        // agent-browser → iframe is a render swap handled by the Wall (the view
        // owns the ≥2-tab confirm gate + onSwapRenderMode);
        // ab-screencast ↔ ab-popout relaunches this same session, in-controller.
        if (mode === 'iframe') this.sink?.requestIframeSwap();
        else if (mode === 'ab-popout') this.popOut();
        else if (this.poppedOut) this.popIn(); // ab-popout → ab-screencast
      },
    };

    // Native history nav — issued like tab actions (allowlisted in
    // agentBrowserCommand).
    this.chromeActions = {
      navigate: (url) => { if (url) this.runAgentBrowser(['open', url]); },
      back: () => this.runAgentBrowser(['back']),
      forward: () => this.runAgentBrowser(['forward']),
      reload: () => this.runAgentBrowser(['reload']),
    };

    this.viewSnapshot = this.buildViewSnapshot();
  }

  // --- view store (useSyncExternalStore) ---

  subscribe = (listener: () => void): (() => void) => {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  };

  snapshot = (): AgentBrowserViewSnapshot => this.viewSnapshot;

  private buildViewSnapshot(): AgentBrowserViewSnapshot {
    return {
      tabs: this.tabs,
      status: this.status,
      connectionLost: this.connectionLost,
      hasFrame: this.hasFrame,
      poppedOut: this.poppedOut,
      streamPort: this.streamPort,
    };
  }

  // Rebuild the view snapshot only when a field actually changed, so
  // useSyncExternalStore keeps a stable reference and doesn't spin re-renders.
  private emitView(): void {
    const prev = this.viewSnapshot;
    if (
      prev.tabs === this.tabs &&
      prev.status === this.status &&
      prev.connectionLost === this.connectionLost &&
      prev.hasFrame === this.hasFrame &&
      prev.poppedOut === this.poppedOut &&
      prev.streamPort === this.streamPort
    ) return;
    this.viewSnapshot = this.buildViewSnapshot();
    for (const listener of this.viewListeners) listener();
  }

  getDeviceSize(): { width: number; height: number } {
    return this.device;
  }

  // --- one-time start (from the first attach; keeps side effects out of render) ---

  private ensureStarted(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    // This surface owns its session again — clear any teardown mark a prior
    // surface (re-using the same managed name) left behind, so auto-revert works.
    if (this.session) clearAgentBrowserSessionClosed(this.session);
    // Display-scale (DPR) changes don't resize the pane, so ResizeObserver misses
    // them; a window resize is the available signal.
    window.addEventListener('resize', this.onWindowResize);
    this.registration = registerAgentBrowserScreen(this.id, {
      snapshot: this.computeScreenSnapshot(),
      actions: this.screenActions,
      chrome: this.chrome,
      chromeActions: this.chromeActions,
      hostCapable: !!getPlatform().agentBrowserCommand,
      canPopOut: !!getPlatform().agentBrowserPopOut,
    });
    this.lastPublishedScreen = null;
    this.publishScreen();
    this.reconcile();
    this.maybeRecoverStalePort();
  }

  private onWindowResize = (): void => {
    // A display-scale (DPR) change doesn't resize the pane, so ResizeObserver
    // misses it; refresh the cache off the window-resize signal too.
    this.refreshPaneSize();
    if (this.syncEngaged) this.issueSyncToPane();
    this.publishScreen();
  };

  // --- cached pane size ---

  private refreshPaneSize(): void {
    const el = this.sink?.viewport;
    if (!el) { this.paneSize = null; return; }
    const rect = el.getBoundingClientRect();
    this.paneSize = { w: Math.round(rect.width), h: Math.round(rect.height) };
  }

  private setupPaneSizeObserver(): void {
    this.teardownPaneSizeObserver();
    const el = this.sink?.viewport;
    if (!el) { this.paneSize = null; return; }
    // Seed synchronously (ResizeObserver's first callback is async, and the test
    // stub never fires) so the first frame reads a real size, not 0×0.
    this.refreshPaneSize();
    const observer = new ResizeObserver((entries) => {
      const cr = entries[entries.length - 1]?.contentRect;
      if (cr) this.paneSize = { w: Math.round(cr.width), h: Math.round(cr.height) };
      // While syncing, push the new pane size to the browser (debounced). The
      // inner re-check drops a resize whose sync was disengaged mid-debounce.
      if (!this.syncEngaged) return;
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.resizeTimer = undefined;
        if (!this.syncEngaged) return;
        this.issueSyncToPane();
        this.publishScreen();
      }, 200);
    });
    observer.observe(el);
    this.paneSizeObserver = observer;
  }

  private teardownPaneSizeObserver(): void {
    this.paneSizeObserver?.disconnect();
    this.paneSizeObserver = null;
    if (this.resizeTimer) { clearTimeout(this.resizeTimer); this.resizeTimer = undefined; }
  }

  // --- view attachment ---

  attachView(sink: AgentBrowserViewSink): { detach: () => void } {
    const token = {};
    this.attachToken = token;
    this.sink = sink;
    // A fresh canvas mounts blank; bump the draw generation so the screenshot
    // loop repaints it even if the next capture's bytes match the last frame.
    this.drawGeneration += 1;
    this.frameDrawSeq += 1;
    // Seed + observe the pane size cache before ensureStarted so the first
    // computeScreenSnapshot reads a real size.
    this.setupPaneSizeObserver();
    this.ensureStarted();
    // Flush param writes / title buffered while detached.
    if (this.pendingParams.size > 0) {
      sink.updateParameters(Object.fromEntries(this.pendingParams));
      this.pendingParams.clear();
    }
    if (this.pendingTitle !== null) {
      sink.setTitle(this.pendingTitle);
      this.pendingTitle = null;
    }
    // The pane-size observer fires on observe and (when syncing) debounces a
    // `set viewport`; issue once explicitly too so re-engaging at an unchanged
    // size still reclaims the viewport. issueSyncToPane no-ops when not capable.
    if (this.syncEngaged) this.issueSyncToPane();
    this.updateParkState();
    this.reconcile();
    this.publishScreen();
    // After a (re)attach, if a live in-pane connection exists, force one capture
    // so a view remounted within the park debounce repaints instead of sitting
    // blank — the connection's own frame dedup swallows the heartbeat rebroadcast,
    // and the bumped generation defeats the screenshot loop's byte dedup.
    if (!this.parked && !this.relaunching && !this.poppedOut && this.connection) {
      this.screenshotLoop?.pulse();
    }
    return {
      // Guard by identity: a stale handle's detach must no-op if a newer view
      // has already attached (StrictMode attach A → detach A → attach B can
      // interleave), and dispose already released everything.
      detach: () => {
        if (this.disposed || this.attachToken !== token) return;
        // A provisional decode aimed at the old canvas needs no cancelling here:
        // drawProvisionalFrame captures its sink and drops the bitmap when
        // `this.sink` has moved on, which clearing it below guarantees.
        this.sink = null;
        this.attachToken = null;
        // The observed viewport died with the unmount; drop the cache (and the
        // pending sync debounce) so the hot paths fall back to no-element behavior.
        this.teardownPaneSizeObserver();
        this.paneSize = null;
        // The canvas DOM died with the unmount; on reattach a fresh canvas
        // mounts blank, so drop hasFrame to match the minimize/reattach
        // placeholder → first-screenshot sequence.
        this.setHasFrame(false);
        this.updateParkState();
      },
    };
  }

  // --- params ---

  updateParams(params: AgentBrowserSurfaceParams): void {
    if (this.disposed) return;
    if (params.session !== this.session) {
      this.session = params.session;
      if (params.session) clearAgentBrowserSessionClosed(params.session);
      this.reconcile();
      this.emitView();
      this.maybeRecoverStalePort();
    }
    if (params.binaryPath !== this.binaryPath) {
      this.binaryPath = params.binaryPath;
      this.maybeRecoverStalePort();
    }
    if (params.wsPort !== this.wsPort) {
      // Mirrors the old useEffect(() => setStreamPort(wsPort), [wsPort]): a
      // `dor ab` re-run refreshing wsPort reconnects to the new port.
      this.wsPort = params.wsPort;
      this.setStreamPort(params.wsPort);
    }
    if (params.url !== this.paramsUrl) {
      this.paramsUrl = params.url;
      if (isRestorableUrl(params.url)) this.latestRestorableUrl = params.url;
    }
    if ((params.key ?? null) !== this.paramsKey) {
      this.paramsKey = params.key ?? null;
      this.recomputeChrome();
    }
    if (params.syncEngaged !== undefined) this.paramsSyncEngaged = params.syncEngaged;
    // renderMode is deliberately NOT reacted to: the controller owns poppedOut
    // (seeded once at construction, then driven only by popOut/popIn). The
    // param is a persistence echo of the controller's own writes.
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.updateParkState();
  }

  // Buffer a param write while detached so a minimized (view-less) controller
  // can still record URL changes; flush on the next attach.
  private writeParams(params: Record<string, unknown>): void {
    if (this.sink) this.sink.updateParameters(params);
    else for (const [k, v] of Object.entries(params)) this.pendingParams.set(k, v);
  }

  // --- parking ---

  private updateParkState(): void {
    if (this.parkTimer) { clearTimeout(this.parkTimer); this.parkTimer = undefined; }
    // Detached ⇒ hidden. Popped out is exempt: its stream/CDP observer detects a
    // headed window close and drives auto-revert, so parking it would break that.
    const shouldPark = !this.poppedOut && (!this.visible || !this.sink);
    if (!shouldPark) { this.setParked(false); return; }
    this.parkTimer = setTimeout(() => {
      this.parkTimer = undefined;
      this.setParked(true);
    }, HIDDEN_PARK_DELAY_MS);
  }

  /** Whether the pane is parked (hidden/detached long enough to shed its stream).
   *  Not in the view snapshot — exposed for tests. */
  isParked(): boolean {
    return this.parked;
  }

  private setParked(parked: boolean): void {
    if (this.parked === parked) return;
    this.parked = parked;
    // A parked pane holds no stream/screenshot loop; the daemon/session stays
    // alive and re-broadcasts on reconnect. Treat unpark like a fresh mount for
    // stale-port recovery: the daemon may have moved while no client was alive.
    if (parked) this.liveStreamPort = null;
    this.reconcile();
    this.maybeRecoverStalePort();
    // issueSyncToPane no-ops while parked, so a resize that happened behind a
    // hidden tab was never pushed; reconcile it on unpark (lastIssued makes this
    // a no-op when the pane size didn't actually change).
    if (!parked && this.syncEngaged) this.issueSyncToPane();
  }

  // --- reconcile: connection + CDP observer (idempotent, keyed) ---

  private reconcile(): void {
    if (this.disposed) return;
    this.reconcileConnection();
    this.reconcileCdp();
  }

  private reconcileConnection(): void {
    const desired = !this.disposed && !!this.streamPort && !!this.session && !this.parked;
    // recoverySeq forces a reconnect at the same session/port (a same-port
    // `dor ab` refresh); it is part of the identity key so a bump re-creates.
    const key = desired ? `${this.session}:${this.streamPort}:${this.recoverySeq}` : null;
    if (key === this.connectionKey) return;

    if (this.connection) {
      this.connectionUnsub?.();
      this.connectionUnsub = null;
      this.connection.dispose();
      this.connection = null;
      this.screenshotLoop?.dispose();
      this.screenshotLoop = null;
    }
    this.connectionKey = key;
    if (!desired) return;

    const session = this.session!;
    const streamPort = this.streamPort!;

    // Per-connection pairing: the screenshot loop and the connection are created
    // and disposed together. The loop lives here (not in a separate effect) so a
    // reconnect always re-creates it — a disposed loop would silently drop every
    // frame pulse.
    const screenshotLoop = createScreenshotLoop({
      getSession: () => this.session,
      getBinaryPath: () => this.binaryPath,
      isCapable: () => !!getPlatform().agentBrowserScreenshot && !!this.session,
      draw: this.drawBitmap,
      // A re-attach bumps drawGeneration so a fresh (blank) canvas repaints even
      // when the capture bytes are identical to the last displayed frame.
      getDrawGeneration: () => this.drawGeneration,
      getProvisionalGeneration: () => this.provisionalPaintGeneration,
      getProvisionalDeadline: () => this.provisionalUntil,
      log: abDebugLog,
    });
    const connection = createAgentBrowserConnection({
      session,
      streamPort,
      binaryPath: this.binaryPath,
      getStreamUrl: async (port) => (await getPlatform().getAgentBrowserStreamUrl?.(port)) ?? undefined,
      runCommand: (targetSession, args, targetBinaryPath) => getPlatform().agentBrowserCommand?.(targetSession, args, targetBinaryPath)
        ?? Promise.resolve({ exitCode: 1, stdout: '', stderr: 'agent-browser commands unavailable' }),
      canSelectTabs: () => !this.poppedOut && !this.relaunching,
      wantFrameData: () => this.wantsProvisionalFrame(),
      log: abDebugLog,
    });
    this.connection = connection;
    this.screenshotLoop = screenshotLoop;
    this.connectionUnsub = connection.subscribe((event) => {
      if (event.type === 'connection-open') {
        this.liveStreamPort = event.port;
        this.setConnectionLost(false);
      } else if (event.type === 'connection-close') {
        if (event.failures >= 3) this.setConnectionLost(true);
      } else if (event.type === 'status') {
        this.setStatus(event.status);
        this.setConnectionLost(event.status.connected === false);
        if (typeof event.status.viewportWidth === 'number' && typeof event.status.viewportHeight === 'number') {
          this.device = { width: event.status.viewportWidth, height: event.status.viewportHeight };
          this.maybeDisengageSync();
          this.publishScreen();
        }
      } else if (event.type === 'tabs') {
        const prevActiveId = event.previousTabs.find((t) => t.active)?.tabId;
        const nextActiveId = event.tabs.find((t) => t.active)?.tabId;
        this.setTabs(event.tabs);
        // Switching the active tab doesn't make the daemon emit a screencast
        // frame, and the dedup'd stream is otherwise silent on a static page, so
        // force one capture so the surface follows the tab the user just selected.
        if (nextActiveId && nextActiveId !== prevActiveId && !this.poppedOut && !this.relaunching) {
          screenshotLoop.pulse();
        }
      } else if (event.type === 'frame-pulse') {
        if (event.metadata) {
          this.device = { width: event.metadata.deviceWidth, height: event.metadata.deviceHeight };
        }
        // The native stream frame is CSS-resolution but arrives immediately after
        // hover/animation changes. Paint it as a provisional response, then let the
        // host screenshot loop replace it with the crisp device-resolution frame.
        // The body rides along only when we asked for it (via `wantFrameData`), so
        // its presence is the request — re-testing `wantsProvisionalFrame` here would
        // only race its own `provisionalUntil` deadline and drop a frame we wanted.
        if (event.data) this.drawProvisionalFrame(event.data);
        this.maybeDisengageSync();
        this.publishScreen();
        if (!this.poppedOut && !this.relaunching) screenshotLoop.pulse();
      }
    });
    // Unparking reconnects to the same session/port; the last good frame is still
    // valid, so only blank to the placeholder when the identity actually changed.
    const identity = `${session}:${streamPort}`;
    if (this.lastConnectedIdentity !== identity) {
      this.lastConnectedIdentity = identity;
      this.setHasFrame(false);
    }
    this.setConnectionLost(false);
  }

  private paintBitmap(bitmap: ImageBitmap): void {
    const canvas = this.sink?.canvas;
    if (!canvas) {
      bitmap.close();
      return;
    }
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    bitmap.close();
    this.setHasFrame(true);
  }

  private drawBitmap = (bitmap: ImageBitmap): void => {
    // A crisp host screenshot supersedes every provisional decode already in
    // flight, even when that decode resolves later.
    this.frameDrawSeq += 1;
    this.paintBitmap(bitmap);
  };

  private drawProvisionalFrame(data: string): void {
    const sink = this.sink;
    if (!sink || typeof createImageBitmap !== 'function') return;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      const binary = atob(data);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    } catch {
      return;
    }
    const mySeq = ++this.frameDrawSeq;
    createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })).then((bitmap) => {
      if (this.disposed || mySeq !== this.frameDrawSeq || this.sink !== sink) {
        bitmap.close();
        return;
      }
      this.provisionalPaintGeneration += 1;
      // This paint puts CSS-resolution pixels on the canvas behind the crisp
      // loop's back, so its byte-dedup (`lastDrawnKey`) no longer describes what
      // is on screen: a resting page whose crisp bytes match the last crisp draw
      // would dedup to a no-op and strand the pane on the blur. Bump the draw
      // generation for the same reason a re-attach does — the canvas changed
      // underneath the loop, so the next crisp capture must repaint regardless
      // of its bytes.
      this.drawGeneration += 1;
      this.paintBitmap(bitmap);
    }).catch(() => {
      // The crisp screenshot path remains authoritative; a malformed/unsupported
      // provisional frame is only a missed latency optimization.
    });
  }

  private wantsProvisionalFrame(): boolean {
    return !this.hasFrame || !getPlatform().agentBrowserScreenshot || performance.now() <= this.provisionalUntil;
  }

  // agent-browser's stream publishes the initial headed tab list but not every
  // same-tab manual navigation. While popped out, subscribe directly to Chrome
  // DevTools Protocol target/page events so the Dormouse URL/header tracks the
  // headed window without polling.
  private reconcileCdp(): void {
    const platform = getPlatform();
    const desired = !this.disposed && this.poppedOut && !!this.session && !!platform.agentBrowserCommand;
    const key = desired ? `${this.session}:${this.streamPort}` : null;
    if (key === this.cdpKey) return;
    this.cdpTeardown?.();
    this.cdpTeardown = null;
    this.cdpKey = key;
    if (!desired) return;
    this.cdpTeardown = this.startCdpObserver(this.session!, platform.agentBrowserCommand!);
  }

  private startCdpObserver(
    session: string,
    runCommand: NonNullable<ReturnType<typeof getPlatform>['agentBrowserCommand']>,
  ): () => void {
    let disposed = false;
    let ws: WebSocket | null = null;
    let nextId = 1;

    const send = (method: string, params?: Record<string, unknown>) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: nextId++, method, ...(params ? { params } : {}) }));
    };
    const handleTargetInfo = (targetInfo: unknown) => {
      if (!targetInfo || typeof targetInfo !== 'object') return;
      const info = targetInfo as { type?: unknown; url?: unknown; title?: unknown };
      if (info.type !== 'page') return;
      this.applyObservedNavigation(
        typeof info.url === 'string' ? info.url : null,
        typeof info.title === 'string' ? info.title : null,
      );
    };
    const handleCdpMessage = (raw: unknown) => {
      if (typeof raw !== 'string') return;
      let msg: any;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
        handleTargetInfo(msg.params?.targetInfo);
      } else if (msg.method === 'Target.targetDestroyed') {
        abDebugLog(`[ab-panel] cdp target destroyed ${JSON.stringify({ targetId: msg.params?.targetId })}`);
      } else if (msg.method === 'Page.frameNavigated') {
        const frame = msg.params?.frame;
        if (!frame?.parentId) {
          this.applyObservedNavigation(
            typeof frame?.url === 'string' ? frame.url : null,
            typeof frame?.name === 'string' ? frame.name : null,
          );
        }
      } else if (Array.isArray(msg.result?.targetInfos)) {
        for (const targetInfo of msg.result.targetInfos) handleTargetInfo(targetInfo);
      }
    };

    const connect = async () => {
      let cdpUrl: string | null = null;
      try {
        const result = await runCommand(session, ['get', 'cdp-url'], this.binaryPath);
        if (result.exitCode === 0) cdpUrl = parseCdpUrl(result.stdout);
        else abDebugLog(`[ab-panel] cdp-url failed ${JSON.stringify({ stderr: result.stderr, stdout: result.stdout })}`);
      } catch (err) {
        abDebugLog(`[ab-panel] cdp-url error ${String(err)}`);
      }
      if (disposed || !cdpUrl) return;
      abDebugLog(`[ab-panel] connecting cdp ${JSON.stringify({ cdpUrl })}`);
      ws = new WebSocket(cdpUrl);
      ws.onopen = () => {
        abDebugLog('[ab-panel] cdp open');
        send('Target.setDiscoverTargets', { discover: true });
        send('Target.getTargets');
        // If get cdp-url ever returns a page websocket instead of the browser
        // websocket, these page-level events are the navigation source.
        send('Page.enable');
      };
      ws.onmessage = (ev) => handleCdpMessage(ev.data);
      ws.onclose = () => { if (!disposed) abDebugLog('[ab-panel] cdp close'); };
      ws.onerror = () => abDebugLog('[ab-panel] cdp error');
    };

    void connect();
    return () => {
      disposed = true;
      ws?.close();
    };
  }

  // A persisted panel may restore with a stale wsPort: the session is alive but
  // the stream server restarted on a new port while VS Code/webview state kept
  // the old one. Once the old socket is proven dead (or no port was persisted),
  // ask the host for the current port and rewrite params so the WS reconnects.
  private maybeRecoverStalePort(): void {
    // Bump first so any change to the recovery inputs invalidates an in-flight
    // query (mirrors the old effect's cleanup running on every dep change).
    const gen = ++this.recoveryGen;
    const session = this.session;
    if (!session) return;
    // A parked pane must never query the daemon: a `stream status` at the wrong
    // moment can spawn a competing daemon, and it's a pointless CLI spawn per
    // hidden pane. Recovery resumes when the pane unparks.
    if (this.parked) return;
    // Critical: do NOT query the daemon mid-relaunch. A pop-out/pop-in close+kills
    // the daemon before reopening; querying `stream status` in that window spawns
    // a fresh COMPETING headless daemon on a different port and pins the panel to
    // it — so the panel ends up streaming an about:blank ghost instead of the
    // headed window. The host hands back the authoritative port when it's done.
    if (this.relaunching) return;
    // Once this exact port has opened, a later disconnect is a live stream
    // failure, not a stale persisted port. Do not ask `stream status` here: the
    // CLI can spawn a fresh daemon and reset the session, hiding the real failure
    // and reverting the URL.
    if (this.streamPort && this.liveStreamPort === this.streamPort) {
      if (this.connectionLost || this.status?.connected === false) {
        abDebugLog(`[ab-panel] stream recovery skipped for live port ${JSON.stringify({ session, wsPort: this.streamPort, connectionLost: this.connectionLost, connected: this.status?.connected })}`);
      }
      return;
    }
    if (this.streamPort && !this.connectionLost && this.status?.connected !== false) return;
    const platform = getPlatform();
    if (!platform.agentBrowserStreamStatus) return;
    platform.agentBrowserStreamStatus(session, this.binaryPath).then((res) => {
      if (gen !== this.recoveryGen || this.disposed) return;
      if (!res.ok || !res.wsPort) return;
      this.setConnectionLost(false);
      this.setStatus(null);
      if (res.wsPort !== this.streamPort) {
        this.setStreamPort(res.wsPort);
        this.writeParams({ wsPort: res.wsPort });
      } else {
        this.bumpRecovery();
      }
    }).catch(() => {});
  }

  // The deliberate direct-port reconnect used by pop-out/pop-in (not the passive
  // persisted-stale-port path above). Resolves true if the stream came/stayed live.
  private reconcileStreamPort(directPort?: number): Promise<boolean> {
    if (this.closeIfSessionMarkedClosed()) return Promise.resolve(false);
    this.setConnectionLost(false);
    this.setStatus(null);
    this.setHasFrame(false);

    if (directPort && directPort > 0) {
      if (directPort !== this.streamPort) {
        this.setStreamPort(directPort);
        abDebugLog(`[ab-panel] subscribing to returned stream port ${JSON.stringify({ session: this.session, wsPort: directPort, previousWsPort: this.wsPort })}`);
      }
      if (directPort !== this.wsPort) this.writeParams({ wsPort: directPort });
      else this.bumpRecovery();
      return Promise.resolve(true);
    }

    const currentSession = this.session;
    const platform = getPlatform();
    if (!currentSession || !platform.agentBrowserStreamStatus) {
      this.bumpRecovery();
      return Promise.resolve(false);
    }

    return platform.agentBrowserStreamStatus(currentSession, this.binaryPath).then((res) => {
      if (this.closeIfSessionMarkedClosed(currentSession)) return false;
      if (!res.ok || !res.wsPort) return false;
      if (res.wsPort !== this.streamPort) {
        this.setStreamPort(res.wsPort);
        this.writeParams({ wsPort: res.wsPort });
      } else {
        this.bumpRecovery();
      }
      return true;
    }).catch(() => false);
  }

  private setStreamPort(port: number | undefined): void {
    if (port === this.streamPort) return;
    this.streamPort = port;
    // A new/restarted session comes up at agent-browser's native viewport; if
    // sync is engaged, reclaim the pane size. Clearing lastIssued is essential —
    // it otherwise still holds the previous session's pane size and
    // issueSyncToPane would no-op, leaving the fresh browser unsynced (SCALED).
    if (port && this.syncEngaged) {
      this.lastIssued = null;
      this.issueSyncToPane();
    }
    this.reconcile();
    this.emitView();
    this.maybeRecoverStalePort();
  }

  private bumpRecovery(): void {
    this.recoverySeq += 1;
    this.reconcileConnection();
  }

  // --- view-snapshot field setters (notify on real change) ---

  private setStatus(status: StreamStatus | null): void {
    const prevConnected = this.status?.connected;
    this.status = status;
    this.emitView();
    if (status?.connected !== prevConnected) {
      this.maybeRecoverStalePort();
      this.maybeAutoRevert();
    }
  }

  private setConnectionLost(connectionLost: boolean): void {
    if (this.connectionLost === connectionLost) return;
    this.connectionLost = connectionLost;
    this.emitView();
    this.maybeRecoverStalePort();
    this.maybeAutoRevert();
  }

  private setHasFrame(hasFrame: boolean): void {
    if (this.hasFrame === hasFrame) return;
    this.hasFrame = hasFrame;
    this.emitView();
  }

  private setTabs(next: StreamTab[]): void {
    this.tabs = next;
    this.rememberActiveTabUrl(next);
    this.recomputeChrome();
    this.updateTitle();
    this.emitView();
  }

  private setPoppedOut(poppedOut: boolean): void {
    if (this.poppedOut === poppedOut) return;
    this.poppedOut = poppedOut;
    this.emitView();
    // Push the render-mode flip (screencast ↔ popout) to the header/modal.
    this.publishScreen();
    this.reconcile();
    this.updateParkState();
    this.maybeAutoRevert();
  }

  private setSyncEngaged(syncEngaged: boolean): void {
    if (this.syncEngaged === syncEngaged) return;
    this.syncEngaged = syncEngaged;
    // Persist so it round-trips through the persisted layout; skip no-ops.
    if (this.paramsSyncEngaged !== syncEngaged) {
      this.paramsSyncEngaged = syncEngaged;
      this.writeParams({ syncEngaged });
    }
    // Reflect the flip in the indicator immediately.
    this.publishScreen();
    // The always-on pane-size observer reads syncEngaged at fire time, so there
    // is nothing to (re)wire here. Engaging issues a sync via engageSync; a
    // pending debounce that outlives a disengage is dropped by its own re-check.
  }

  // --- canonical URL tracking ---

  private rememberRestorableUrl(url: string | null | undefined): boolean {
    if (!isRestorableUrl(url)) return false;
    this.latestRestorableUrl = url;
    // Track the active tab faithfully so params.url is always the page the user
    // is on. Two guards: freeze while a relaunch is in flight (the active tab is
    // momentarily a blank/booting page that must not overwrite the real target),
    // and never record a transient about:blank (isRestorableUrl above).
    if (!this.relaunching && url !== this.paramsUrl) {
      this.paramsUrl = url;
      this.writeParams({ url });
    }
    return true;
  }

  private rememberActiveTabUrl(next: StreamTab[]): void {
    const active = next.find((t) => t.active) ?? next[0] ?? null;
    this.rememberRestorableUrl(active?.url);
  }

  private applyObservedNavigation(url: string | null | undefined, title?: string | null): void {
    if (!isRestorableUrl(url)) return;
    this.rememberRestorableUrl(url);
    const prev = this.tabs;
    if (prev.length === 0) {
      this.setTabs([{ tabId: 'cdp-active', title: title ?? null, url, active: true }]);
      return;
    }
    const activeIndex = Math.max(0, prev.findIndex((tab) => tab.active));
    const current = prev[activeIndex];
    if (!current || (current.url === url && (title == null || current.title === title))) return;
    this.setTabs(prev.map((tab, index) => index === activeIndex
      ? { ...tab, url, title: title ?? tab.title }
      : tab));
  }

  private currentRelaunchUrl(): string | undefined {
    return [
      this.latestRestorableUrl,
      this.chrome.url,
      this.paramsUrl,
    ].find(isRestorableUrl);
  }

  // --- header: title + browser-chrome ---

  private activeTab(): StreamTab | null {
    return this.tabs.find((tab) => tab.active) ?? this.tabs[0] ?? null;
  }

  private updateTitle(): void {
    const active = this.activeTab();
    if (!active) return;
    const title = tabDisplayTitle(active);
    if (title === this.lastTitle) return;
    this.lastTitle = title;
    if (this.sink) this.sink.setTitle(title);
    else this.pendingTitle = title;
  }

  private recomputeChrome(): void {
    const active = this.activeTab();
    const chrome: ChromeSnapshot = {
      url: active?.url ?? '',
      displayUrl: active ? hostPathDisplay(active.url) : '',
      title: active?.title ?? null,
      key: this.paramsKey,
    };
    this.chrome = chrome;
    // Push to the header only on a real url/title/key change (never per frame);
    // displayUrl is a pure function of url so url covers it.
    const prev = this.lastChromePushed;
    if (!prev || prev.url !== chrome.url || prev.title !== chrome.title || prev.key !== chrome.key) {
      this.lastChromePushed = chrome;
      this.registration?.updateChrome(chrome);
    }
  }

  // --- screen indicator (SYNCED/SCALED) + sync-to-pane ---

  private computeScreenSnapshot(): ScreenSnapshot {
    // Read the cached pane size (updated by the ResizeObserver / window resize)
    // rather than forcing layout on every frame. null ⇒ no attached view ⇒ 0×0.
    const pane = this.paneSize;
    const displayDpr = window.devicePixelRatio || 1;
    const device = this.device;
    const paneCss = { w: pane?.w ?? 0, h: pane?.h ?? 0 };
    // DPR can't be read back from frames, so report the density we'd sync to.
    const viewport = { w: device.width, h: device.height, dpr: displayDpr };
    const state: ScreenState = dimsMatch(viewport, paneCss) ? 'SYNCED' : 'SCALED';
    const renderMode: RenderMode = this.poppedOut ? 'ab-popout' : 'ab-screencast';
    return { state, viewport, paneCss, displayDpr, syncEngaged: this.syncEngaged, renderMode };
  }

  // Publish to the registry only when something the header/modal cares about
  // changed — never per frame (the frame loop calls this every paint).
  private publishScreen(): void {
    const next = this.computeScreenSnapshot();
    const prev = this.lastPublishedScreen;
    const changed =
      !prev ||
      prev.state !== next.state ||
      prev.viewport.w !== next.viewport.w ||
      prev.viewport.h !== next.viewport.h ||
      prev.viewport.dpr !== next.viewport.dpr ||
      prev.displayDpr !== next.displayDpr ||
      prev.syncEngaged !== next.syncEngaged ||
      prev.renderMode !== next.renderMode ||
      !dimsMatch(prev.paneCss, next.paneCss);
    if (changed) {
      this.lastPublishedScreen = next;
      this.registration?.update(next);
    }
  }

  // Push the current pane size to the browser as a native `set viewport`.
  private issueSyncToPane(): void {
    // A parked (hidden) pane must not drive the browser viewport: its rect can be
    // degenerate while hidden. The unpark path reconciles any resize that happened
    // while parked.
    if (this.parked) return;
    // A popped-out surface is a real headed OS window the user drives directly;
    // never force its viewport to the (now-stub) pane size. Sync resumes when it
    // pops back in — the streamPort-change reclaim re-issues against the fresh session.
    if (this.poppedOut) return;
    // Hosts without agentBrowserCommand (Tauri today) can't drive the viewport;
    // stay silent rather than warn on every resize. The surface just reads SCALED.
    if (!getPlatform().agentBrowserCommand) return;
    const el = this.sink?.viewport;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const prev = this.lastIssued;
    if (prev && prev.w === w && prev.h === h && Math.abs(prev.dpr - dpr) <= 0.001) return;
    this.lastIssued = { w, h, dpr };
    this.syncConfirmed = false;
    this.runAgentBrowser(['set', 'viewport', String(w), String(h), String(dpr)]);
  }

  // Last-writer-wins: drop sync when an external `dor ab set …` takes the
  // viewport away from what we issued. The trap is that right after we issue a
  // new size, the browser keeps streaming the OLD size for a few frames — those
  // must NOT count as external. So we only disengage once a frame has first
  // *confirmed* our issued size landed, and a later frame then deviates.
  private maybeDisengageSync(): void {
    if (!this.syncEngaged) return;
    const issued = this.lastIssued;
    // Cached pane size (this runs per frame — no forced layout). null ⇒ detached,
    // same skip as the old no-element guard.
    const pane = this.paneSize;
    if (!issued || !pane) return;
    // Mid-resize: we haven't issued for the pane's current size yet.
    if (!dimsMatch(issued, pane)) return;
    const device = { w: this.device.width, h: this.device.height };
    if (dimsMatch(device, issued)) {
      this.syncConfirmed = true; // our `set` landed
      return;
    }
    // Frame differs from what we issued: a pre-landing stale frame until
    // confirmed; an external override once confirmed.
    if (this.syncConfirmed) this.setSyncEngaged(false);
  }

  // --- relaunch: pop-out / pop-in / bring-to-front + auto-revert ---

  private closeIfSessionMarkedClosed(targetSession: string | null | undefined = this.session): boolean {
    if (!targetSession || !isAgentBrowserSessionClosed(targetSession)) return false;
    getPlatform().agentBrowserCommand?.(targetSession, ['close'], this.binaryPath).catch(() => {});
    return true;
  }

  // Headed Pop-Out: relaunch this session's browser as a native OS window. The
  // pane becomes a stub; the stream stays connected to observe tabs/status and
  // to auto-revert when the window closes. The new Chrome process gets a fresh
  // stream port, which we write into params so the WS reconnects.
  private popOut(): void {
    const platform = getPlatform();
    const session = this.session;
    if (!session || !platform.agentBrowserPopOut) return;
    if (this.closeIfSessionMarkedClosed(session)) return;
    this.headedConnected = false;
    this.relaunching = true;
    this.setPoppedOut(true);
    this.writeParams({ renderMode: 'ab-popout' });
    // Pop-out failed: revert to in-pane unless the stream came back live anyway.
    const revertUnlessLive = () => this.reconcileStreamPort().then((live) => {
      this.relaunching = false;
      if (live) return;
      this.setPoppedOut(false);
      this.writeParams({ renderMode: 'ab-screencast' });
    });
    // Don't reconcile to the current (headless) port first — it's about to close.
    // Connect to the headed window's fresh port once the relaunch returns it.
    const url = this.currentRelaunchUrl();
    abDebugLog(`[ab-panel] popOut -> ${JSON.stringify({ session, url })}`);
    platform.agentBrowserPopOut(session, { rect: paneScreenRect(this.sink?.viewport), url }, this.binaryPath).then((res) => {
      abDebugLog(`[ab-panel] popOut result ${JSON.stringify(res)}`);
      if (this.closeIfSessionMarkedClosed(session)) return;
      if (!res.ok) {
        void revertUnlessLive();
        return;
      }
      void this.reconcileStreamPort(res.wsPort);
      this.relaunching = false;
    }).catch((err) => {
      abDebugLog(`[ab-panel] popOut error ${String(err)}`);
      if (this.closeIfSessionMarkedClosed(session)) return;
      void revertUnlessLive();
    });
  }

  popIn(): void {
    const session = this.session;
    if (this.closeIfSessionMarkedClosed(session)) return;
    // Same expected mid-relaunch stream drop as pop-out: suppress screenshot
    // pulses so none relaunches the just-closed browser at about:blank.
    this.relaunching = true;
    this.setPoppedOut(false);
    this.writeParams({ renderMode: 'ab-screencast' });
    const platform = getPlatform();
    if (!session || !platform.agentBrowserPopIn) { this.relaunching = false; return; }
    // Don't reconcile to the current (headed) port first — the host is about to
    // kill that daemon. Querying now would spawn a competing daemon. Connect to
    // the fresh port the host returns.
    const url = this.currentRelaunchUrl();
    abDebugLog(`[ab-panel] popIn -> ${JSON.stringify({ session, url })}`);
    platform.agentBrowserPopIn(session, { url }, this.binaryPath).then((res) => {
      abDebugLog(`[ab-panel] popIn result ${JSON.stringify(res)}`);
      if (this.closeIfSessionMarkedClosed(session)) { this.relaunching = false; return; }
      if (res.ok) void this.reconcileStreamPort(res.wsPort);
      else void this.reconcileStreamPort();
      this.relaunching = false;
    }).catch(() => {
      if (this.closeIfSessionMarkedClosed(session)) { this.relaunching = false; return; }
      void this.reconcileStreamPort();
      this.relaunching = false;
    });
  }

  bringToFront(): void {
    const session = this.session;
    if (!session) return;
    getPlatform().agentBrowserBringToFront?.(session, this.binaryPath)?.catch(() => {});
  }

  // Auto-revert: once the headed stream has connected, a later disconnect means
  // the window closed → relaunch headless and resume streaming. But a disconnect
  // also happens when Dormouse itself closes the session (pane kill, or a
  // render-swap away from popout); the closed-session mark tells those apart so
  // we don't resurrect a session that's being torn down.
  private maybeAutoRevert(): void {
    if (!this.poppedOut) { this.headedConnected = false; return; }
    // The expected mid-relaunch drop isn't the window closing — ignore it.
    if (this.relaunching) return;
    if (this.status?.connected === true) this.headedConnected = true;
    else if (this.headedConnected && (this.status?.connected === false || this.connectionLost)) {
      if (this.session && isAgentBrowserSessionClosed(this.session)) return;
      this.popIn();
    }
  }

  // --- input bridging ---

  private runAgentBrowser(args: string[]): void {
    const session = this.session;
    if (!session) return;
    // Call through the adapter instance — pulling the method into a bare variable
    // would detach `this` and break its internal `requestResponse`.
    const platform = getPlatform();
    if (!platform.agentBrowserCommand) {
      console.warn('[agent-browser] this host cannot run agent-browser commands; tab actions are unavailable');
      return;
    }
    platform.agentBrowserCommand(session, args, this.binaryPath).then((result) => {
      if (result.exitCode !== 0) {
        console.warn(`[agent-browser] ${args.join(' ')} failed:`, result.stderr || result.stdout || `exit ${result.exitCode}`);
      }
    }).catch((error) => {
      console.warn(`[agent-browser] ${args.join(' ')} failed:`, error);
    });
  }

  send(payload: Record<string, unknown>): void {
    if (payload.type === 'input_mouse') {
      this.provisionalUntil = performance.now() + PROVISIONAL_INPUT_WINDOW_MS;
    }
    this.connection?.send(payload);
  }

  selectTab(tab: StreamTab): void {
    if (!tab.active) this.runAgentBrowser(['tab', tab.tabId]);
  }

  closeTab(tab: StreamTab): void {
    this.runAgentBrowser(['tab', 'close', tab.tabId]);
  }

  private sendKey(e: KeyLike, eventType: 'keyDown' | 'keyUp'): void {
    const info = SPECIAL_KEYS[e.key];
    // Under ctrl/cmd the key is a shortcut, not text — sending text would make
    // e.g. cmd-A insert an "a" instead of acting as a chord.
    const wantsText = eventType === 'keyDown' && !e.ctrlKey && !e.metaKey;
    this.send({
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
  }

  sendKeyUp(e: KeyLike): void {
    this.sendKey(e, 'keyUp');
  }

  // cmd/ctrl-V types the LOCAL clipboard into the page. Plain key forwarding
  // would trigger paste of the embedded Chromium's own (empty) clipboard, so
  // bridge by replaying the text as per-character keyDown events.
  private insertText(text: string): void {
    for (const ch of text) {
      if (ch === '\r') continue;
      if (ch === '\n') {
        this.send({ type: 'input_keyboard', eventType: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13, modifiers: 0 });
        this.send({ type: 'input_keyboard', eventType: 'keyUp', key: 'Enter', code: 'Enter', text: '', windowsVirtualKeyCode: 13, modifiers: 0 });
      } else {
        this.send({ type: 'input_keyboard', eventType: 'keyDown', key: ch, code: '', text: ch, windowsVirtualKeyCode: 0, modifiers: 0 });
        this.send({ type: 'input_keyboard', eventType: 'keyUp', key: ch, code: '', text: '', windowsVirtualKeyCode: 0, modifiers: 0 });
      }
    }
  }

  handleKeyDownLike(e: KeyLike): void {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'v') {
      void readTextFromClipboard().then((text) => {
        if (text) this.insertText(text);
      });
      return;
    }
    // macOS native editing chords (select-all/copy/cut) don't fire over the
    // stream input path (CDP commands field is dropped). Route the intent
    // through the host's purpose-built edit channel instead. If the host lacks
    // it (e.g. standalone), fall through so the page still gets the chord for
    // its own JS shortcuts.
    if (mod && !e.altKey && !e.shiftKey) {
      const op = EDIT_OPS[e.key.toLowerCase() as keyof typeof EDIT_OPS];
      // Call through the adapter instance — detaching the method drops `this`.
      const platform = getPlatform();
      const session = this.session;
      if (op && platform.agentBrowserEdit && session) {
        platform.agentBrowserEdit(session, op, this.binaryPath).then((r) => {
          if (!r.ok && r.error) console.warn(`[agent-browser] ${op} failed:`, r.error);
        }).catch((err) => console.warn(`[agent-browser] ${op} failed:`, err));
        return;
      }
    }
    this.sendKey(e, 'keyDown');
  }

  // --- teardown ---

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.parkTimer) { clearTimeout(this.parkTimer); this.parkTimer = undefined; }
    this.teardownPaneSizeObserver();
    this.paneSize = null;
    if (this.connection) {
      this.connectionUnsub?.();
      this.connectionUnsub = null;
      this.connection.dispose();
      this.connection = null;
    }
    this.screenshotLoop?.dispose();
    this.screenshotLoop = null;
    this.connectionKey = null;
    this.cdpTeardown?.();
    this.cdpTeardown = null;
    this.cdpKey = null;
    if (this.started) window.removeEventListener('resize', this.onWindowResize);
    this.registration?.dispose();
    this.registration = null;
    this.sink = null;
    this.attachToken = null;
    this.viewListeners.clear();
  }
}

// --- module-level registry (mirrors terminal-lifecycle) ---

const registry = new Map<string, AgentBrowserSurfaceController>();

export function acquireAgentBrowserSurfaceController(
  id: string,
  params: AgentBrowserSurfaceParams,
): AgentBrowserSurfaceController {
  const existing = registry.get(id);
  if (existing) return existing;
  const controller = new AgentBrowserSurfaceController(id, params);
  registry.set(id, controller);
  return controller;
}

export function getAgentBrowserSurfaceController(id: string): AgentBrowserSurfaceController | null {
  return registry.get(id) ?? null;
}

/** Release all CLIENT-side resources for a surface (connection, screenshot loop,
 *  CDP observer, timers, screen registration). Does NOT run `agent-browser
 *  close` — daemon/session teardown stays `closeAgentBrowserSession`'s job in
 *  Wall.tsx. A safe no-op for a surface with no controller (iframe/terminal). */
export function disposeAgentBrowserSurfaceController(id: string): void {
  const controller = registry.get(id);
  if (!controller) return;
  registry.delete(id);
  controller.dispose();
}

/** For tests: controllers now outlive panel unmount, so a suite reusing a
 *  surface id must release them between cases. */
export function disposeAllAgentBrowserSurfaceControllers(): void {
  for (const id of [...registry.keys()]) disposeAgentBrowserSurfaceController(id);
}
