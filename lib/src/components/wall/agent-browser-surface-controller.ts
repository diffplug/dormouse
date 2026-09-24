/**
 * Surface-scoped browser lifecycle; see docs/specs/dor-browser.md →
 * "Browser Connection". The registry survives panel unmount and is
 * released by Wall on kill/render swap: `closeBrowserSurface` closes the
 * session too, `disposeAgentBrowserSurfaceController` only the client side.
 */
import {
  BROWSER_CLOSE_MAX_CANCELS,
  isBlankUrl,
  isBrowsableUrl,
  viewerTextInputs,
  type BrowserAutomationProvider,
  type BrowserResult,
  type ViewerFrame,
  type ViewerSyncIntent,
  type ViewerSyncState,
} from '../../lib/platform/browser-automation';
import { isAllowedBinaryFor } from '../../lib/agent-browser-binary';
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
import { parseRenderMode } from 'dor-lib-common/browser-providers';
import {
  BROWSER_PROVIDER_GUI,
  browserHandle,
  headedRenderMode,
  hostSupportsBrowser,
  isHeadedMode,
  offeredRenderModes,
  launchBinaryPath,
  providerUnavailable,
  rememberLaunchBinaryPath,
  surfaceProvider,
  type BrowserHandle,
} from './browser-automation';
import { agentBrowserSessionFromParams, isToolParams } from './browser-surface';
import {
  EDIT_OPS,
  SPECIAL_KEYS,
  modifiers,
  virtualKeyCode,
} from './agent-browser-input';
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

// The high-rate `[ab-panel]` diagnostics fire per stream event, so the flag is
// read ONCE — lazily, on the first log — and memoized: toggling needs a
// reload, which is the right trade for a hot loop. The same flag has the host
// log each viewer socket's rates. The connection's always-on debug ring is
// unaffected.
// `localStorage.setItem('dormouse.flags.abDebugLogs', 'true')` + reload to enable.
let abDebugLogsEnabled: boolean | undefined;
function abDebugLogsOn(): boolean {
  return abDebugLogsEnabled ??= isAbDebugLogsEnabled();
}
function abDebugLog(message: string): void {
  if (abDebugLogsOn()) console.log(message);
}

/** A viewport the screencast is fixed at: CSS size and device pixel ratio. */
type FixedViewport = { width: number; height: number; dpr: number };

/** The pane's CSS size as laid out — never `getBoundingClientRect()`, which a
 *  Workspace presentation scaling the Wall's subtree shrinks while it moves
 *  (docs/specs/dor-browser.md → "Display Modal And Render Swaps"). */
function laidOutSize(el: HTMLElement): { w: number; h: number } {
  return { w: el.clientWidth, h: el.clientHeight };
}


// A stray about:blank the close+reopen of a relaunch can surface is never the
// page the pane shows.
function isShownUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && !isBlankUrl(url);
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

/** Canonical params for a browser surface, as the view reads them. Pop-out is
 *  deliberately absent: it is derived from `renderMode`, never stored; nor is
 *  the stream, which `dor` hands straight to the controller
 *  (docs/specs/dor-browser.md → "Canonical Params"). */
export interface AgentBrowserSurfaceParams {
  surfaceType?: string;
  renderMode?: RenderMode;
  cwd?: string;
  session?: string;
  /** With no `session`, the one the launch opens `url` in; absent, the host
   *  mints one. */
  launchSession?: string;
  key?: string;
  binaryPath?: string;
  url?: string;
  syncEngaged?: boolean;
}

/**
 * `binaryPath` names a program the *host* will spawn, and these params come off
 * the persisted session blob — a plain record with no schema
 * (`lib/src/lib/session-types.ts`). Editing that file must not be a way to have
 * the sidecar exec something on the next launch, so the value is checked here,
 * before it is ever sent, as well as at the spawn itself
 * (`lib/src/host/agent-browser-host.ts`). A refused path simply falls back to
 * the host's own resolution.
 */
function allowedBinaryPath(candidate: unknown, provider: BrowserAutomationProvider): string | undefined {
  return isAllowedBinaryFor(provider, candidate) ? candidate : undefined;
}

/**
 * Where the Surface's browser is in its life (docs/specs/dor-browser.md →
 * "Browser Connection" has the transition table). The stream connection
 * exists exactly in `live`, and so does every daemon command (`driver`).
 */
type Phase =
  /** Constructed; no view has started it yet. */
  | { k: 'idle' }
  /** No session yet: opening `url` in a browser whose session binds on
   *  success — `named` when the launch names one, which a close of the
   *  Surface meanwhile closes too, through the launch's own binding. */
  | { k: 'launching'; named?: { session: string; browser: BrowserHandle } }
  /** The session's stream is being asked of the host (`attach`). */
  | { k: 'attaching' }
  /** Viewing `stream` over the host's viewer socket. `seen`: the stream has
   *  reported its browser connected, so a later drop means it went away — a
   *  headed window closed. `resumed`: an unpark reconnecting to the stream it
   *  parked at, not yet proven there — its catch-up waits until the socket
   *  opens, and one that fails asks the host where it moved. */
  | { k: 'live'; stream: number; seen: boolean; resumed: boolean }
  /** Hidden long enough to shed the socket; the browser stays up at `stream`. */
  | { k: 'parked'; stream: number }
  /** A headed↔headless relaunch is in flight: the host closes the browser and
   *  kills its daemon before reopening on a new stream. */
  | { k: 'relaunching' }
  /** Nothing to show: the browser went away, or `error` kept it from opening. */
  | { k: 'ended'; error?: string }
  /** Released: nothing here runs again. */
  | { k: 'disposed' };

export type BrowserSurfacePhase = Phase['k'];

/** The live DOM bindings a mounted view lends the controller. `attachView`
 *  wires these; `detach()` returns them. */
export interface AgentBrowserViewSink {
  /** Draw target for the viewer socket's frames. */
  canvas: HTMLCanvasElement;
  /** The content area — observed for resize and read for pane rect / pop-out
   *  positioning. */
  viewport: HTMLElement;
  /** Persist a param write into the surface's engine metadata. */
  updateParameters(params: Record<string, unknown>): void;
  /** Set the persisted panel title (door labels / session save). */
  setTitle(title: string): void;
  /** Ask the view to swap to iframe or the other automation provider. The ≥2-tab
   *  typed-confirm gate and the Wall's `onSwapRenderMode` are view concerns; the
   *  view reads tabs from the snapshot and decides. */
  requestRenderSwap(mode?: RenderMode): void;
  /** The first launch failed: the Wall applies the Surface's `launchFallback`. */
  launchFailed(error: string): void;
}

/** The single view-facing snapshot, consumed via `useSyncExternalStore`. Only
 *  what the view renders lives here — session comes straight from params — and
 *  `phase` is the view's projection: a headless pane that parks or re-attaches
 *  still shows its last frame, so it reads `live` then, rather than re-rendering
 *  on every hide and show (`isParked()` answers tests). */
export interface AgentBrowserViewSnapshot {
  tabs: StreamTab[];
  status: StreamStatus | null;
  hasFrame: boolean;
  /** Headed: the browser is (or is being opened as) a separate OS window. */
  poppedOut: boolean;
  phase: BrowserSurfacePhase;
  /** Why the browser could not be opened, while `phase` is `ended`. */
  error: string | undefined;
}

const EMPTY_TABS: StreamTab[] = [];

export class AgentBrowserSurfaceController {
  readonly id: string;
  readonly provider: BrowserAutomationProvider;
  private cwd?: string;
  /** Whether this host can drive the Surface's provider at all. */
  private get hosted(): boolean {
    return hostSupportsBrowser(this.provider);
  }
  /** Gates the render modes offered; see `ensureStarted`. */
  private readonly isTool: boolean;
  /** What `setRenderMode` accepts, fixed on first use with the host's
   *  capabilities. Never a popout or another provider for a tool, whose
   *  `render` is `iframe` or `ab-screencast`: the swap would tear the browser
   *  down and re-derive the same screencast, so asking for a native window would
   *  get a reload (`docs/specs/dor-tool.md` -> Declaring tools). */
  private renderModesCache: readonly RenderMode[] | null = null;
  private get renderModes(): readonly RenderMode[] {
    return this.renderModesCache ??= offeredRenderModes(this.isTool, this.provider);
  }

  private phase: Phase = { k: 'idle' };
  private handleCache: { session?: string; cwd?: string; binaryPath?: string; handle: BrowserHandle | null } | null = null;
  /** The presentation this Surface shows: a separate OS window, or in the pane.
   *  Seeded from `renderMode`; changed by a relaunch (optimistically, reverted
   *  if it fails) or, for Playwright, by a native relaunch the host reports. */
  private headed: boolean;

  // --- params (mirrors of the persisted blob) ---
  private session: string | undefined;
  private launchSession: string | undefined;
  private binaryPath: string | undefined;
  /** A stream handed over before the first start, which then views it. */
  private initialStream: number | undefined;
  private paramsUrl: string | undefined;
  private paramsKey: string | null;
  private paramsSyncEngaged: boolean | undefined;

  // --- viewer socket (exists only while live) ---
  private connection: AgentBrowserConnection | null = null;
  private connectionUnsub: (() => void) | null = null;
  private connectionKey: string | null = null;
  // The `session:stream` the connection last (re)connected to. An unpark
  // reconnects to the same identity, so the last good frame is still valid and
  // must not be blanked to the placeholder; only a real identity change resets
  // hasFrame.
  private lastConnectedIdentity: string | null = null;
  /** The stream of the last live/parked phase: the browser `fixedDpr` describes. */
  private boundStream: number | undefined;

  // --- view state (the snapshot) ---
  private status: StreamStatus | null = null;
  private hasFrame = false;
  private tabs: StreamTab[] = EMPTY_TABS;

  // --- visibility / parking ---
  private visible = true;
  /** Hidden (or detached) for the park delay: a live pane parks. */
  private parkRequested = false;
  private parkTimer: ReturnType<typeof setTimeout> | undefined;

  /** The latest presentation, page and fixed viewport asked for while nothing
   *  could be driven, applied once the Surface is live: a launch, attach or
   *  relaunch must not lose them. A launch or relaunch opens the page itself
   *  (`launchUrl`), and a host that opened it settles it (`openedByHost`). */
  private pendingIntent: { url?: string; headed?: boolean; viewport?: FixedViewport } = {};

  /** The popped-out window's viewport as its page last reported it, which a
   *  pop-in fixes the screencast at. */
  private windowViewport: FixedViewport | undefined;

  /** Requests this Surface sent that can bring its browser up — a launch, a
   *  relaunch, an attach naming a page — which the host has not answered: a
   *  close cancels them, however late the transport delivers them (`close`). */
  private bringingUp = new Set<string>();

  // --- sync-to-pane (the host owns it; docs/specs/dor-browser.md → "Display
  // Modal And Render Swaps") ---
  private syncEngaged: boolean;
  // This pane's current choice of Resize with pane, as the host knows it: a
  // new one reclaims the viewport, and the host's word on an older one is
  // stale.
  private syncEngagement: string = crypto.randomUUID();
  // Whether the host last reported that engagement `synced`.
  private hostSynced = false;
  // The viewport as the stream reports it: the Display modal's dims, and the
  // scale pointer input maps through.
  private device = { width: 1280, height: 720 };
  // The DPR of the fixed viewport last issued to this browser, which frames
  // cannot tell; undefined once anything else may have set it.
  private fixedDpr: number | undefined;
  private lastPublishedScreen: ScreenSnapshot | null = null;
  // Debounce for sending the host a settled pane size (armed by the pane-size
  // observer below).
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;

  // --- cached pane size (avoid per-frame forced layout) ---
  // computeScreenSnapshot() runs on EVERY non-duplicate stream frame (~20Hz);
  // reading the pane's size there forces layout each time. A ResizeObserver
  // active for the whole attach duration keeps the pane's content-box size
  // cached. null ⇒ no attached view — treat as 0×0. The size syncToPane sends
  // stays a live read.
  // The same observer also drives sync-to-pane (debounced), so there is one
  // observer on the pane, not two.
  private paneSize: { w: number; h: number } | null = null;
  private paneSizeObserver: ResizeObserver | null = null;
  private dprQuery: MediaQueryList | null = null;

  // --- canonical URL tracking ---
  // The newest active-tab URL observed from the live stream that a relaunch
  // can restore — http(s) only, as the host relaunches nowhere else, so a
  // transient about:blank or a `file:`/`data:` page leaves the last one. Kept
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

  // --- view binding ---
  private sink: AgentBrowserViewSink | null = null;
  private attachToken: object | null = null;
  // Latest-only decoding: one frame decoding, and at most one waiting behind
  // it, which a newer arrival replaces. Frames paint in the order they came.
  private decoding = false;
  private pendingFrame: ViewerFrame | null = null;
  // Param writes buffered while detached (a minimized popped-out pane can still
  // observe URL changes); flushed on the next attach.
  private pendingParams = new Map<string, unknown>();
  private pendingTitle: string | null = null;
  private pendingLaunchFailure: string | null = null;
  // The value this controller last wrote to each field it also takes from
  // params, until params show it back. Params predating the write — buffered
  // while detached, then fed by a remounted view before the flush, or a render
  // (StrictMode's second effect pass) that ran before the store caught up —
  // would otherwise undo it: flip the mode back, or read the session a launch
  // bound as taken away and launch again.
  private readonly unechoed = new Map<'renderMode' | 'session', unknown>();

  private readonly viewListeners = new Set<() => void>();
  private viewSnapshot: AgentBrowserViewSnapshot;

  constructor(id: string, params: AgentBrowserSurfaceParams) {
    this.id = id;
    this.provider = surfaceProvider(params.renderMode);
    this.cwd = params.cwd;
    // A Surface's kind never changes over its life (a tool's capabilities come
    // and go, its identity does not), so this is safe to seed once.
    this.isTool = isToolParams(params);
    this.session = params.session;
    this.launchSession = params.launchSession;
    this.binaryPath = allowedBinaryPath(params.binaryPath, this.provider);
    this.paramsUrl = params.url;
    this.paramsKey = params.key ?? null;
    this.paramsSyncEngaged = params.syncEngaged;
    this.latestRestorableUrl = isBrowsableUrl(params.url) ? params.url : undefined;
    // Headedness is derived from the canonical renderMode; an unset mode (a
    // direct mount in tests) is not popped out.
    this.headed = isHeadedMode(params.renderMode);
    // A fresh surface auto-engages sync (no persisted flag); a re-attached one
    // restores whatever was persisted into the layout blob.
    this.syncEngaged = params.syncEngaged ?? true;
    this.chrome = { url: '', displayUrl: '', title: null, key: this.paramsKey };

    // Stable across the controller's life (reads `this`), so the registered
    // screen controller never goes stale.
    this.screenActions = {
      engageSync: () => {
        // A new engagement, even while engaged: the host reclaims the
        // viewport at the size it last wrote too (an agent's `set` may have
        // taken it), and re-engages a sync it stopped.
        this.syncEngagement = crypto.randomUUID();
        this.hostSynced = false;
        this.forgetFixedViewport();
        this.setSyncEngaged(true);
        this.syncToPane();
      },
      applyDevice: (name) => {
        this.forgetFixedViewport();
        this.setSyncEngaged(false);
        this.drive(`set device ${name}`, (browser) => browser.device(name));
      },
      applyViewport: (width, height, dpr) => this.fixViewport({ width, height, dpr }),
      openModal: () => openAgentBrowserScreenModal(this.id),
      setRenderMode: (mode, opts) => this.setRenderMode(mode, opts),
    };

    // Native history nav — issued like tab actions, through the daemon gate.
    this.chromeActions = {
      navigate: (url) => this.navigate(url),
      back: () => this.drive('back', (browser) => browser.history('back')),
      forward: () => this.drive('forward', (browser) => browser.history('forward')),
      reload: () => this.drive('reload', (browser) => browser.history('reload')),
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
    const phase = this.phase;
    const shown = !this.headed && (phase.k === 'parked' || phase.k === 'attaching') ? 'live' : phase.k;
    return {
      tabs: this.tabs,
      status: this.status,
      hasFrame: this.hasFrame,
      poppedOut: this.headed,
      phase: shown,
      error: phase.k === 'ended' ? phase.error : undefined,
    };
  }

  // Rebuild the view snapshot only when a field actually changed, so
  // useSyncExternalStore keeps a stable reference and doesn't spin re-renders.
  private emitView(): void {
    const prev = this.viewSnapshot;
    const next = this.buildViewSnapshot();
    if (
      prev.tabs === next.tabs &&
      prev.status === next.status &&
      prev.hasFrame === next.hasFrame &&
      prev.poppedOut === next.poppedOut &&
      prev.phase === next.phase &&
      prev.error === next.error
    ) return;
    this.viewSnapshot = next;
    for (const listener of this.viewListeners) listener();
  }

  /**
   * Swap this Surface's render mode, going to `url` too (docs/specs/dor-browser.md
   * → "Display Modal And Render Swaps"). Only what the modal could offer: the
   * popout below never reaches the Wall's own tool guard. A swap to iframe or
   * the other provider is a render swap handled by the Wall (the view owns the
   * ≥2-tab confirm gate + onSwapRenderMode); screencast ↔ popout relaunches
   * this same session, in-controller, carrying the page asked for rather than
   * racing a navigation into it.
   */
  setRenderMode(mode: RenderMode, opts?: { url?: string }): void {
    if (!this.renderModes.includes(mode)) return;
    const { provider, presentation } = parseRenderMode(mode);
    const headed = presentation === 'popout';
    if (provider !== this.provider) this.sink?.requestRenderSwap(mode);
    else if (headed !== this.headed) this.relaunch(headed, opts?.url);
    else if (opts?.url) this.navigate(opts.url);
  }

  /** The render mode this Surface shows now. */
  private renderMode(): RenderMode {
    return headedRenderMode(this.provider, this.headed);
  }

  private get label(): string {
    return BROWSER_PROVIDER_GUI[this.provider].label;
  }

  getDeviceSize(): { width: number; height: number } {
    return this.device;
  }

  // --- one-time start (from the first attach; keeps side effects out of render) ---

  private ensureStarted(): void {
    if (this.phase.k !== 'idle') return;
    this.watchDpr();
    this.registration = registerAgentBrowserScreen(this.id, {
      snapshot: this.computeScreenSnapshot(),
      actions: this.screenActions,
      chrome: this.chrome,
      chromeActions: this.chromeActions,
      hostCapable: this.hosted,
      renderModes: this.renderModes,
    });
    this.lastPublishedScreen = null;
    this.publishScreen();
    this.bind(this.initialStream);
    this.initialStream = undefined;
  }

  // A display-scale (DPR) change resizes nothing, so the pane's ResizeObserver
  // misses it. A `(resolution)` query fires once when the scale leaves its
  // value, and is re-armed for the new one.
  private watchDpr(): void {
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      : null;
    this.dprQuery?.addEventListener('change', this.onDprChange);
  }

  private onDprChange = (): void => {
    this.watchDpr();
    this.syncToPane();
    this.publishScreen();
  };

  // --- cached pane size ---

  private refreshPaneSize(): void {
    const el = this.sink?.viewport;
    this.paneSize = el ? laidOutSize(el) : null;
  }

  private setupPaneSizeObserver(): void {
    this.teardownPaneSizeObserver();
    const el = this.sink?.viewport;
    if (!el) { this.paneSize = null; return; }
    // Seed synchronously (ResizeObserver's first callback is async, and the test
    // stub never fires) so the first frame reads a real size, not 0×0.
    this.refreshPaneSize();
    // Read in the observer's callback, where layout is already done.
    const observer = new ResizeObserver(() => {
      this.refreshPaneSize();
      this.publishScreen();
      // Send the host the settled pane size, if syncing then (`syncToPane`).
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.resizeTimer = undefined;
        this.syncToPane();
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
    if (this.pendingLaunchFailure !== null) {
      sink.launchFailed(this.pendingLaunchFailure);
      this.pendingLaunchFailure = null;
    }
    // The pane-size observer fires on observe and debounces its size; send it
    // at once too, for a view remounted over a socket already open.
    this.syncToPane();
    this.updateParkState();
    this.publishScreen();
    // A view remounted within the park debounce mounts a blank canvas over a
    // socket still open, whose host sends only changes: ask it for the last frame.
    if (this.phase.k === 'live' && !this.headed) this.connection?.send({ type: 'repaint' });
    return {
      // Guard by identity: a stale handle's detach must no-op if a newer view
      // has already attached (StrictMode attach A → detach A → attach B can
      // interleave), and dispose already released everything.
      detach: () => {
        if (this.phase.k === 'disposed' || this.attachToken !== token) return;
        // A decode aimed at the old canvas needs no cancelling here:
        // `decodeFrame` captures its sink and drops the bitmap when `this.sink`
        // has moved on, which clearing it below guarantees.
        this.sink = null;
        this.attachToken = null;
        // The observed viewport died with the unmount; drop the cache (and the
        // pending sync debounce) so the hot paths fall back to no-element behavior.
        this.teardownPaneSizeObserver();
        this.paneSize = null;
        // The canvas DOM died with the unmount; on reattach a fresh canvas
        // mounts blank, so drop hasFrame to match the minimize/reattach
        // placeholder → first-frame sequence.
        this.setHasFrame(false);
        this.updateParkState();
      },
    };
  }

  // --- params ---

  updateParams(params: AgentBrowserSurfaceParams): void {
    if (this.phase.k === 'disposed') return;
    // Mirror every field first, then rebind once: binding per field would bind
    // a new session with the cwd or binary of the old.
    if (params.cwd !== undefined) this.cwd = params.cwd;
    // First, so neither a stream this rebinds nor one handed over next
    // (`handOverBrowserStream`) inherits a `set viewport` meant for the old mode.
    if (params.renderMode && this.echoed('renderMode', params.renderMode)) this.followParamsHeadedness(params.renderMode);
    const sessionChanged = this.echoed('session', params.session) && params.session !== this.session;
    if (sessionChanged) this.session = params.session;
    this.launchSession = params.launchSession;
    this.binaryPath = allowedBinaryPath(params.binaryPath, this.provider);
    if (params.url !== this.paramsUrl) {
      this.paramsUrl = params.url;
      if (isBrowsableUrl(params.url)) {
        this.latestRestorableUrl = params.url;
        // A new target while a launch opens the old one (a Tool re-framed):
        // go there once live, unless the host opened it after all.
        if (this.phase.k === 'launching') this.pendingIntent.url = params.url;
      }
    }
    if ((params.key ?? null) !== this.paramsKey) {
      this.paramsKey = params.key ?? null;
      this.recomputeChrome();
    }
    if (params.syncEngaged !== undefined) this.paramsSyncEngaged = params.syncEngaged;
    // Before the first attach, `ensureStarted` binds whatever has arrived.
    if (this.phase.k !== 'idle' && sessionChanged) this.bind();
  }

  /**
   * A stream a `dor ab` / `dor pw` command just learned for this Surface's
   * session — the same one again included — to view, leaving `ended` too.
   */
  handOver(stream: number): void {
    if (this.phase.k === 'disposed') return;
    if (this.phase.k === 'idle') this.initialStream = stream;
    else this.adopt(stream);
  }

  /** Whether params may set `field` to `value`: not while they have yet to
   *  show this controller's own last write of it — the echo itself included. */
  private echoed(field: 'renderMode' | 'session', value: unknown): boolean {
    if (!this.unechoed.has(field)) return true;
    if (this.unechoed.get(field) === value) this.unechoed.delete(field);
    return false;
  }

  /**
   * A provider's native launch (Playwright's `open --headed`) can change
   * headedness outside the Display modal; the host reports it, and the Wall
   * records it in params (`ensureBrowserSurface`). This controller's own
   * popOut/popIn write never reaches here (`echoed`), and a relaunch in flight
   * owns the mode.
   */
  private followParamsHeadedness(renderMode: RenderMode): void {
    if (this.phase.k === 'relaunching') return;
    const headed = isHeadedMode(renderMode);
    if (headed === this.headed) return;
    // The last status came from the old browser; auto-revert waits for the
    // new stream's own before it treats a disconnect as the window closing.
    this.setStatus(null);
    if (this.phase.k === 'live') this.phase.seen = false;
    this.setHeaded(headed);
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.updateParkState();
  }

  // Buffer a param write while detached so a minimized (view-less) controller
  // can still record URL changes; flush on the next attach.
  private writeParams(params: Record<string, unknown>): void {
    for (const field of ['renderMode', 'session'] as const) {
      if (typeof params[field] === 'string') this.unechoed.set(field, params[field]);
    }
    if (this.sink) this.sink.updateParameters(params);
    else for (const [k, v] of Object.entries(params)) this.pendingParams.set(k, v);
  }

  // --- phase ---

  /** Enter `next`, with the viewer socket following it. */
  private setPhase(next: Phase): void {
    this.phase = next;
    // A ratio this Surface fixed describes only the browser it was set on.
    if ((next.k === 'live' || next.k === 'parked') && next.stream !== this.boundStream) {
      this.boundStream = next.stream;
      this.fixedDpr = undefined;
    }
    this.reconcileConnection();
    this.emitView();
    // An unpark's stream is proven only once its socket opens.
    if (next.k === 'live' && !next.resumed) this.drivable();
  }

  /** The daemon can be driven again: catch up on what waited for it. The
   *  pane's size goes to the host once the socket opens. */
  private drivable(): void {
    const { url, headed, viewport } = this.pendingIntent;
    this.pendingIntent = {};
    // A popped-out window is never sized.
    if (viewport && !this.headed) this.issueFixedViewport(viewport);
    if (headed !== undefined && headed !== this.headed) this.relaunch(headed, url);
    else if (url) this.drive(`open ${url}`, (browser) => browser.navigate(url));
  }

  /** (Re)bind the current params: no session launches one, a session without
   *  a stream learns it from the host, one whose stream was just handed over
   *  is viewed at once. */
  private bind(handover?: number): void {
    if (!this.session) this.launch();
    else if (handover) this.goLive(handover);
    else this.attach(true);
  }

  /** A stream handed over for the bound session: view it. A launch or
   *  relaunch in flight ignores it — the host's answer is the authoritative
   *  stream. */
  private adopt(stream: number): void {
    const phase = this.phase;
    if (phase.k === 'relaunching' || phase.k === 'launching') return;
    if (phase.k === 'live' && phase.stream === stream) return;
    if (phase.k === 'parked') this.setPhase({ k: 'parked', stream });
    else this.goLive(stream);
  }

  private goLive(stream: number, resumed = false): void {
    this.setPhase(this.parkRequested && !this.headed
      ? { k: 'parked', stream }
      : { k: 'live', stream, seen: false, resumed });
  }

  /**
   * Open this Surface's page in a new browser — in `launchSession` when params
   * name one — and bind the session the host answers with. Every GUI-created
   * browser Surface starts here, and so does one restored before its launch
   * landed. Resolves once the browser is up, never waiting for the page; the
   * Wall's `whenBrowserLaunched` hears the outcome.
   */
  private launch(): void {
    const url = this.launchUrl();
    const session = this.launchSession;
    const headed = this.headed;
    // No creation site has to remember the binary a `dor ab` surface resolved.
    const binaryPath = this.binaryPath ?? launchBinaryPath(this.provider);
    const browser = browserHandle(this.provider, { session, cwd: this.cwd, binaryPath });
    const phase: Phase = { k: 'launching', ...(session && browser ? { named: { session, browser } } : {}) };
    this.setPhase(phase);
    // A launch that cannot start settles as late as one that fails, so whoever
    // created this Surface is always listening by then. A named one is sent
    // only once every close of its session this webview sent has been
    // answered — a failed swap reopening the previous provider's, a Tool
    // re-run's — so no transport can deliver it first; released meanwhile, it
    // opens nothing for a closed Surface.
    const closing = session === undefined ? undefined : closeInFlight(this.provider, session);
    const opened: Promise<BrowserResult> = !browser
      ? Promise.resolve({ ok: false, error: providerUnavailable(this.provider) })
      : !url
        ? Promise.resolve({ ok: false, error: 'no page to open' })
        : !closing
          ? this.bringUp((requestId) => browser.launch(url, headed, requestId))
          : closing.then(() => this.phase === phase ? this.bringUp((requestId) => browser.launch(url, headed, requestId)) : { ok: false });
    opened
      .then((res) => {
        if (this.phase !== phase) {
          // The browser that came up belongs to nobody: close a session the
          // host minted, which only this answer names. A named one a close of
          // this Surface already closed after it (`close`); one left otherwise
          // is whoever holds that session next (a Workspace transfer's
          // destination opens the same one).
          if (res.session && !session) void closeSessionOn(this.provider, res.cwd ?? this.cwd, res.session, res.binaryPath);
          return;
        }
        if (!res.ok || !res.session) {
          const error = res.error ?? `Could not open ${this.label}`;
          this.setPhase({ k: 'ended', error });
          settleLaunch(this.id, error);
          this.reportLaunchFailure(error);
          return;
        }
        rememberLaunchBinaryPath(this.provider, res.binaryPath);
        this.session = res.session;
        if (res.cwd !== undefined) this.cwd = res.cwd;
        this.binaryPath = allowedBinaryPath(res.binaryPath, this.provider) ?? allowedBinaryPath(binaryPath, this.provider);
        this.writeParams({
          session: res.session,
          ...(res.cwd !== undefined ? { cwd: res.cwd } : {}),
          ...(res.nativeIdentity !== undefined ? { nativeIdentity: res.nativeIdentity } : {}),
          ...(this.binaryPath !== undefined ? { binaryPath: this.binaryPath } : {}),
          // The launch is done: its session and its failure policy with it.
          launchSession: undefined,
          launchFallback: undefined,
        });
        this.launchSession = undefined;
        this.openedByHost(url);
        if (res.stream) this.goLive(res.stream);
        else this.attach(false);
        settleLaunch(this.id, null);
      });
  }

  /** Tell the Wall this Surface's first launch failed: it applies the
   *  fallback the Surface's creator stored (`launchFallback`). A view that is
   *  not attached hears it when it attaches. */
  private reportLaunchFailure(error: string): void {
    if (this.sink) this.sink.launchFailed(error);
    else this.pendingLaunchFailure = error;
  }

  /** The page a launch, relaunch or relaunching attach opens: the navigation
   *  still pending, else the page this Surface is on. */
  private launchUrl(): string | undefined {
    const pending = this.pendingIntent.url;
    return isBrowsableUrl(pending) ? pending : this.currentRelaunchUrl();
  }

  /** The host opened `url` in the browser it started: a navigation pending to
   *  that page is done, or `live` would load it a second time. */
  private openedByHost(url: string | undefined): void {
    if (url !== undefined && this.pendingIntent.url === url) delete this.pendingIntent.url;
  }

  /**
   * Ask the host where the session's stream is (`attach`, which never starts a
   * daemon to answer). With `relaunch`, a session whose daemon is gone is
   * reopened at the page this Surface had, so a restore after a reboot comes
   * back where it was. Without, as on an unpark whose stream failed, a gone
   * daemon is `ended`.
   */
  private attach(relaunch: boolean): void {
    const session = this.session;
    if (!session) { this.launch(); return; }
    const browser = this.handle();
    if (!browser) {
      this.setPhase({ k: 'ended' });
      return;
    }
    const phase: Phase = { k: 'attaching' };
    this.setPhase(phase);
    const url = relaunch ? this.launchUrl() : undefined;
    // A browser this relaunches for a Surface closed meanwhile is closed by
    // the host: it runs the close after this attach, or cancels it (`close`).
    (url ? this.bringUp((requestId) => browser.attach({ url, headed: this.headed, requestId })) : browser.attach({ headed: this.headed }))
      .then((res) => {
        if (this.phase !== phase) return;
        // Only a gone daemon is relaunched at the page; a live one was only
        // found, so a navigation pending to it still has to run.
        if (res.relaunched) this.openedByHost(url);
        if (res.ok && res.stream) this.goLive(res.stream);
        else this.setPhase({ k: 'ended', error: relaunch ? res.error : undefined });
      });
  }

  /** Send a request that can bring the browser up under a fresh id, held in
   *  `bringingUp` until the host answers it. */
  private bringUp(send: (requestId: string) => Promise<BrowserResult>): Promise<BrowserResult> {
    const requestId = crypto.randomUUID();
    this.bringingUp.add(requestId);
    // A handle answers failures rather than rejecting.
    return send(requestId).then((result) => {
      this.bringingUp.delete(requestId);
      return result;
    });
  }

  // --- parking ---

  private updateParkState(): void {
    if (this.parkTimer) { clearTimeout(this.parkTimer); this.parkTimer = undefined; }
    // Detached ⇒ hidden. Popped out is exempt: its viewer socket brings the
    // headed window's close, which drives auto-revert, and its page as it
    // navigates, so parking it would break both.
    const shouldPark = !this.headed && (!this.visible || !this.sink);
    if (!shouldPark) { this.setParkRequested(false); return; }
    this.parkTimer = setTimeout(() => {
      this.parkTimer = undefined;
      this.setParkRequested(true);
    }, HIDDEN_PARK_DELAY_MS);
  }

  /** Whether the pane is parked (hidden/detached long enough to shed its stream).
   *  Not in the view snapshot — exposed for tests. */
  isParked(): boolean {
    return this.phase.k === 'parked';
  }

  private setParkRequested(parkRequested: boolean): void {
    if (this.parkRequested === parkRequested) return;
    this.parkRequested = parkRequested;
    const phase = this.phase;
    // A parked pane holds no viewer socket; the daemon/session stays alive and
    // re-broadcasts on reconnect. An unpark views the stream it parked at at
    // once, and asks the host only if that fails: the daemon may have moved
    // while no client was alive.
    if (parkRequested && phase.k === 'live') this.setPhase({ k: 'parked', stream: phase.stream });
    else if (!parkRequested && phase.k === 'parked') this.goLive(phase.stream, true);
  }

  // --- viewer socket (keyed; exists exactly while live) ---

  private reconcileConnection(): void {
    const phase = this.phase;
    // Headedness too: a headed viewer is sent no frames.
    const key = phase.k === 'live' ? `${this.session}:${phase.stream}:${this.headed}` : null;
    if (key === this.connectionKey) return;

    if (this.connection) {
      this.connectionUnsub?.();
      this.connectionUnsub = null;
      this.connection.dispose();
      this.connection = null;
    }
    this.connectionKey = key;
    if (phase.k !== 'live') return;

    const session = this.session!;
    const stream = phase.stream;
    const headed = this.headed;
    const connection = createAgentBrowserConnection({
      session,
      stream,
      viewUrl: async () => {
        const answer = await this.handle()?.view(stream, { headed, debug: abDebugLogsOn() });
        if (!answer?.ok || !answer.url) throw new Error(answer?.error ?? `${this.label} viewer unavailable`);
        return answer.url;
      },
      selectTab: (tabId) => this.driver()?.tab('select', tabId)
        ?? Promise.resolve({ ok: false, error: `${this.label} commands unavailable` }),
      canSelectTabs: () => !this.headed,
      log: abDebugLog,
    });
    this.connection = connection;
    this.connectionUnsub = connection.subscribe((event) => {
      const phase = this.phase;
      if (phase.k !== 'live') return;
      if (event.type === 'connection-open') {
        // The stream it parked at still answers: the daemon it drives is there.
        if (phase.resumed) {
          phase.resumed = false;
          this.drivable();
        }
        // A size the pane took while no socket was open — behind a hidden
        // tab, across a relaunch — or the same one, which the host holds.
        this.syncToPane();
      } else if (event.type === 'sync') {
        this.applyHostSync(event.state, event.engagement);
      } else if (event.type === 'connection-close') {
        // An unpark's daemon may have moved while nothing viewed it.
        if (phase.resumed) this.attach(false);
        else if (event.failures >= 3) this.streamLost();
      } else if (event.type === 'status') {
        this.setStatus(event.status);
        // A browser not yet reported connected is still coming up.
        const lost = !event.status.connected && phase.seen;
        if (event.status.connected) phase.seen = true;
        const { viewportWidth: width, viewportHeight: height, devicePixelRatio: dpr } = event.status;
        if (typeof width === 'number' && typeof height === 'number') this.setDeviceSize(width, height);
        // A status without a ratio sizes the daemon's viewport, not the window.
        if (this.headed && typeof width === 'number' && typeof height === 'number' && typeof dpr === 'number') {
          this.windowViewport = { width, height, dpr };
        }
        if (lost) this.streamLost();
      } else if (event.type === 'url') {
        // A navigation committed. `tabs` catches up only when the driving
        // command completes — for a slow page, the whole load — so record it now:
        // the header follows, and a relaunch mid-load carries the page being
        // loaded rather than the one before it.
        this.applyStreamUrl(event.url);
      } else if (event.type === 'page') {
        this.applyObservedNavigation(event.url, event.title);
      } else if (event.type === 'tabs') {
        this.setTabs(event.tabs);
      } else if (event.type === 'frame') {
        if (event.size) this.setDeviceSize(event.size.width, event.size.height);
        this.paintFrame(event);
      }
    });
    // The new stream reports its own status, and its host its own sync; the
    // last came from whatever this Surface streamed before.
    this.status = null;
    this.hostSynced = false;
    // Unparking reconnects to the same session/stream; the last good frame is
    // still valid, so only blank to the placeholder when the identity changed.
    const identity = `${session}:${stream}`;
    if (this.lastConnectedIdentity !== identity) {
      this.lastConnectedIdentity = identity;
      this.setHasFrame(false);
    }
  }

  /** The browser's viewport, as its stream reports it: never a judgment on
   *  sync-to-pane, which only the host makes. */
  private setDeviceSize(width: number, height: number): void {
    this.device = { width, height };
    this.publishScreen();
  }

  // --- painting ---

  /** Paint a frame from the viewer socket, latest-only: one decodes at a
   *  time, and a newer arrival replaces the one waiting behind it. */
  private paintFrame(frame: ViewerFrame): void {
    if (this.decoding) this.pendingFrame = frame;
    else this.decodeFrame(frame);
  }

  private decodeFrame(frame: ViewerFrame): void {
    const sink = this.sink;
    if (!sink || typeof createImageBitmap !== 'function') return;
    this.decoding = true;
    // The frame's JPEG is a view over the socket's ArrayBuffer.
    createImageBitmap(new Blob([frame.jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })).then((bitmap) => {
      if (this.phase.k === 'disposed' || this.sink !== sink) bitmap.close();
      else this.paintBitmap(sink.canvas, bitmap, frame.kind);
    }, () => {
      // A malformed frame is only a missed paint; the next one replaces it.
    }).finally(() => {
      this.decoding = false;
      const next = this.pendingFrame;
      this.pendingFrame = null;
      if (next) this.decodeFrame(next);
    });
  }

  /**
   * Draw `bitmap` over the whole canvas. A crisp frame sizes the canvas; a
   * provisional one, at CSS resolution, is drawn scaled into a canvas of the
   * same shape rather than resizing it, so switching between the two never
   * reallocates the backing store or relayouts the pane.
   */
  private paintBitmap(canvas: HTMLCanvasElement, bitmap: ImageBitmap, kind: ViewerFrame['kind']): void {
    const sameShape = canvas.width > 0 && canvas.height > 0
      && Math.abs(canvas.width / canvas.height - bitmap.width / bitmap.height) < 0.01;
    if (kind === 'crisp' || !sameShape) {
      if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
      if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
    }
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    this.setHasFrame(true);
  }

  // --- view-snapshot field setters (notify on real change) ---

  private setStatus(status: StreamStatus | null): void {
    this.status = status;
    this.emitView();
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

  private setHeaded(headed: boolean): void {
    if (this.headed === headed) return;
    this.headed = headed;
    this.emitView();
    // Push the render-mode flip (screencast ↔ popout) to the header/modal.
    this.publishScreen();
    this.reconcileConnection();
    this.updateParkState();
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
  }

  /** The host's word on this pane's sync. Only the host decides another
   *  writer took the viewport (`off`), which disengages Resize with pane; a
   *  report on an engagement this pane has since replaced is stale. */
  private applyHostSync(state: ViewerSyncState, engagement: string): void {
    if (engagement !== this.syncEngagement) return;
    this.hostSynced = state === 'synced';
    if (state === 'off') this.setSyncEngaged(false);
    this.publishScreen();
  }

  // --- canonical URL tracking ---

  private rememberRestorableUrl(url: string | null | undefined): boolean {
    if (!isBrowsableUrl(url)) return false;
    this.latestRestorableUrl = url;
    // Track the active tab faithfully so params.url is always the page the user
    // is on. Two guards: freeze while a relaunch is in flight (the active tab is
    // momentarily a blank/booting page that must not overwrite the real target),
    // and never record a URL a relaunch cannot restore (latestRestorableUrl).
    if (this.phase.k !== 'relaunching' && url !== this.paramsUrl) {
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
    if (!isShownUrl(url)) return;
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

  // The stream's `url` message names the active tab's new URL and nothing else;
  // the previous page's title no longer describes it, so the tab falls back to
  // its URL until the load completes and `tabs` brings the real title.
  private applyStreamUrl(url: string): void {
    if (!isShownUrl(url)) return;
    this.rememberRestorableUrl(url);
    const active = this.activeTab();
    if (!active) {
      this.setTabs([{ tabId: 'stream-active', title: null, url, active: true }]);
      return;
    }
    // A reload commits the same URL but invalidates the old document title just
    // as surely as a different-URL navigation. Once cleared, repeat URL events
    // are a true no-op until `tabs` supplies the refreshed title.
    if (active.url === url && active.title === null) return;
    this.setTabs(this.tabs.map((tab) => (tab === active ? { ...tab, url, title: null } : tab)));
  }

  private currentRelaunchUrl(): string | undefined {
    return [
      this.latestRestorableUrl,
      this.chrome.url,
      this.paramsUrl,
    ].find((url) => isBrowsableUrl(url));
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
    // Read the cached pane size (updated by the ResizeObserver)
    // rather than forcing layout on every frame. null ⇒ no attached view ⇒ 0×0.
    const pane = this.paneSize;
    const displayDpr = window.devicePixelRatio || 1;
    const device = this.device;
    const paneCss = { w: pane?.w ?? 0, h: pane?.h ?? 0 };
    // Frames never show the ratio: report the one the browser measures
    // (Playwright's poll, which keeps its own ratio), else the one this Surface
    // fixed, else the one it would sync to.
    const viewport = { w: device.width, h: device.height, dpr: this.status?.devicePixelRatio ?? this.fixedDpr ?? displayDpr };
    // SYNCED only on the host's word that the browser is at this pane's size.
    const state: ScreenState = this.syncEngaged && this.hostSynced ? 'SYNCED' : 'SCALED';
    const renderMode = this.renderMode();
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
      prev.paneCss.w !== next.paneCss.w ||
      prev.paneCss.h !== next.paneCss.h;
    if (changed) {
      this.lastPublishedScreen = next;
      this.registration?.update(next);
    }
  }

  /**
   * While Resize with pane is engaged, send the host the pane's size over the
   * viewer socket: the host sizes the browser to it and alone judges whether
   * it holds. Only over a live socket — the socket's open sends what it
   * missed — and never from a popped-out window, which is its own size.
   */
  private syncToPane(): void {
    // A host that cannot drive the provider (the web demo) sizes nothing; the
    // surface just reads SCALED.
    if (!this.syncEngaged || this.headed || !this.hosted || this.phase.k !== 'live') return;
    const el = this.sink?.viewport;
    if (!el) return;
    const { w: width, h: height } = laidOutSize(el);
    if (!width || !height) return;
    this.connection?.send({ type: 'sync', width, height, dpr: window.devicePixelRatio || 1, engagement: this.syncEngagement } satisfies ViewerSyncIntent);
  }

  /** Fix the screencast at `viewport`, disengaging sync: at once while live,
   *  else once the browser is (the pending intent). */
  private fixViewport(viewport: FixedViewport): void {
    this.setSyncEngaged(false);
    if (this.driver()) this.issueFixedViewport(viewport);
    else this.pendingIntent.viewport = viewport;
  }

  private issueFixedViewport({ width, height, dpr }: FixedViewport): void {
    this.fixedDpr = dpr;
    this.publishScreen();
    this.drive(`set viewport ${width} ${height} ${dpr}`, (browser) => browser.viewport(width, height, dpr));
  }

  /** Another resolution was asked for: a fixed viewport still waiting is
   *  dropped, and the one issued no longer describes the browser. */
  private forgetFixedViewport(): void {
    delete this.pendingIntent.viewport;
    this.fixedDpr = undefined;
    this.publishScreen();
  }

  // --- relaunch: pop-out / pop-in + auto-revert ---

  popIn(): void {
    this.relaunch(false);
  }

  /**
   * Pop-Out / pop-in: relaunch this session's browser headed as a native OS
   * window, or back headless in the pane, at `url` or the page it is on. The
   * host closes the browser and kills its daemon before reopening on a new
   * stream, so the viewer socket is dropped up front — its close would read as
   * the window closing — and reconnects to the stream the host hands back. One
   * relaunch at a time, of a bound browser: anything else keeps only the
   * navigation asked for.
   */
  private relaunch(headed: boolean, url?: string): void {
    const session = this.session;
    const k = this.phase.k;
    const capable = this.hosted;
    if (!capable || !session || (k !== 'live' && k !== 'parked' && k !== 'ended')) {
      // Before the browser is bound, the request waits for it; one arriving
      // mid-relaunch is dropped — one relaunch at a time.
      if (capable && (k === 'idle' || k === 'launching' || k === 'attaching')) this.pendingIntent.headed = headed;
      else abDebugLog(`[ab-panel] ${headed ? 'popOut' : 'popIn'} ignored in ${k}`);
      if (url) this.navigate(url);
      return;
    }
    // The page asked for is the latest navigation, superseding a pending one.
    if (isBrowsableUrl(url)) {
      this.latestRestorableUrl = url;
      this.pendingIntent.url = url;
    }
    const target = this.launchUrl();
    // The phase first: flipping headedness while still live would reopen the
    // viewer socket on the browser the relaunch is closing.
    const phase: Phase = { k: 'relaunching' };
    this.setPhase(phase);
    // A pop-in keeps the window's resolution: the screencast is fixed at it
    // once the headless browser is live.
    const windowViewport = this.windowViewport;
    this.windowViewport = undefined;
    if (!headed && this.headed && windowViewport) this.fixViewport(windowViewport);
    this.setHeaded(headed);
    this.writeParams({ renderMode: this.renderMode() });
    abDebugLog(`[ab-panel] ${headed ? 'popOut' : 'popIn'} -> ${JSON.stringify({ session, url: target })}`);
    this.bringUp((requestId) => this.handle()!.launch(target, headed, requestId)).then((res) => {
      abDebugLog(`[ab-panel] relaunch result ${JSON.stringify(res)}`);
      // Closed meanwhile, the host closes what this brought up after it.
      if (this.phase !== phase) return;
      if (res.ok && res.stream) {
        this.openedByHost(target);
        this.goLive(res.stream);
        return;
      }
      // Failed: back in the pane at the page it was on, relaunching headless
      // there if no daemon came up.
      if (headed) {
        this.setHeaded(false);
        this.writeParams({ renderMode: this.renderMode() });
      }
      this.attach(true);
    });
  }

  /**
   * The stream says its browser is gone, or the stream itself is. A headless
   * one has `ended`: the gate shuts, so nothing reaches a daemon whose stream
   * this controller would never learn. A headed one seen connected auto-reverts —
   * its window closed, so relaunch headless in the pane; one not yet seen is
   * still opening. A Dormouse teardown (pane kill, a render-swap away) releases
   * the controller before it closes the session, so no stream is left to see
   * that close.
   */
  private streamLost(): void {
    const phase = this.phase;
    if (phase.k !== 'live') return;
    if (!this.headed) this.setPhase({ k: 'ended' });
    else if (phase.seen) this.popIn();
  }

  // --- the daemon gate ---

  /** The browser to drive, only while `live`: every command, edit and capture
   *  takes it from here, and what is asked outside it waits as the pending
   *  intent. The host refuses whatever would reach a browser mid-launch or
   *  mid-close, or a daemon that is gone, so this gate orders the Surface's
   *  own intents rather than guarding the daemon (docs/specs/dor-browser.md →
   *  "Browser Connection"). */
  private driver(): BrowserHandle | null {
    if (this.phase.k !== 'live' || !this.session) return null;
    return this.handle();
  }

  /** The bound session's browser, whatever the phase: for what the gate does
   *  not cover — a launch, attach or relaunch, the stream URL, a close.
   *  Rebuilt only when the binding changes: captures take it per frame. */
  private handle(): BrowserHandle | null {
    const { session, cwd, binaryPath } = this;
    const cached = this.handleCache;
    if (cached && cached.session === session && cached.cwd === cwd && cached.binaryPath === binaryPath) return cached.handle;
    const handle = browserHandle(this.provider, { session, cwd, binaryPath });
    this.handleCache = { session, cwd, binaryPath, handle };
    return handle;
  }

  /** One browser operation through the gate, warned about when it fails;
   *  dropped outside `live`. */
  private drive(label: string, act: (browser: BrowserHandle) => Promise<BrowserResult>): void {
    const browser = this.driver();
    if (!browser) {
      abDebugLog(`[ab-panel] ${label} dropped in ${this.phase.k}`);
      return;
    }
    void act(browser).then((result) => {
      if (!result.ok) console.warn(`[${this.provider}] ${label} failed:`, result.error ?? 'no reason given');
    });
  }

  /** Navigate the active tab. Asked while nothing can be driven, it is kept as
   *  the one latest intent and run on the next `live`; an ended browser is
   *  opened again there — attached, relaunching if its daemon is gone, or
   *  launched when it never had a session. */
  private navigate(url: string): void {
    if (!url) return;
    if (this.driver()) {
      // The latest navigation, superseding one an unpark has yet to catch up on.
      delete this.pendingIntent.url;
      this.drive(`open ${url}`, (browser) => browser.navigate(url));
      return;
    }
    if (this.phase.k === 'disposed') return;
    this.pendingIntent.url = url;
    if (this.phase.k !== 'ended') return;
    if (isBrowsableUrl(url)) this.latestRestorableUrl = url;
    this.bind();
  }

  // --- input bridging ---

  /** One input message over the viewer socket, whose host also paints the
   *  stream for a while after it. */
  send(payload: Record<string, unknown>): void {
    this.connection?.send(payload);
  }

  selectTab(tab: StreamTab): void {
    if (!tab.active) this.drive(`tab ${tab.tabId}`, (browser) => browser.tab('select', tab.tabId));
  }

  closeTab(tab: StreamTab): void {
    this.drive(`tab close ${tab.tabId}`, (browser) => browser.tab('close', tab.tabId));
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
  // bridge by sending the text, which the host inserts.
  private insertText(text: string): void {
    for (const message of viewerTextInputs(text)) this.send(message);
  }

  handleKeyDownLike(e: KeyLike): void {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'v') {
      void readTextFromClipboard().then((text) => {
        if (text) this.insertText(text);
      });
      return;
    }
    // Native editing chords (select-all/copy/cut) don't fire over the stream
    // input path (CDP commands field is dropped), on any platform — Cmd on
    // macOS, Ctrl elsewhere. Route the intent through the host's purpose-built
    // edit channel instead — a daemon command, so gated like the rest. A host
    // that cannot drive the provider (the fake adapter) falls through, so the
    // page still gets the chord for its own JS shortcuts.
    if (mod && !e.altKey && !e.shiftKey) {
      const op = EDIT_OPS[e.key.toLowerCase() as keyof typeof EDIT_OPS];
      if (op && this.hosted && this.session) {
        this.drive(op, (browser) => browser.edit(op));
        return;
      }
    }
    this.sendKey(e, 'keyDown');
  }

  // --- teardown ---

  /** Close this Surface's browser session — the one it is bound to, or the
   *  one its launch names — and release the controller. Sent at once: the host
   *  runs it after the Surface's launch, relaunch or attach still running,
   *  closing what that brings up, and cancels one it has not received yet
   *  (docs/specs/dor-browser.md → "Browser Host"); a launch naming the session
   *  waits for its answer (`closeInFlight`).
   *  Returns the session closed, if any, and when the host answered. */
  close(): { session?: string; done: Promise<void> } {
    const phase = this.phase;
    if (phase.k === 'disposed') return { done: Promise.resolve() };
    const session = this.session;
    // Its own requests still unanswered may reach the host after this close;
    // a Surface has one or two at a time, so the newest fit any bound.
    const cancels = [...this.bringingUp].slice(-BROWSER_CLOSE_MAX_CANCELS);
    this.release();
    const done = session ? closeSessionOn(this.provider, this.cwd, session, this.binaryPath, cancels)
      : phase.k === 'launching' && phase.named ? trackClose(this.provider, phase.named.session, phase.named.browser.close(cancels))
      : Promise.resolve();
    return { session, done };
  }

  /** Closed or disposed: nothing here runs again, and a view still mounted
   *  acquires a new controller for the Surface's next params. */
  get released(): boolean {
    return this.phase.k === 'disposed';
  }

  /** Release every client-side resource, leaving the session to whoever holds it
   *  next (a Workspace transfer's destination). */
  dispose(): void {
    if (this.phase.k === 'disposed') return;
    this.release();
  }

  private release(): void {
    // A launch in flight lands on a released controller, which closes a
    // session the host minted for it; whoever awaited one hears that the
    // Surface is gone.
    settleLaunch(this.id, null);
    if (this.parkTimer) { clearTimeout(this.parkTimer); this.parkTimer = undefined; }
    this.teardownPaneSizeObserver();
    this.paneSize = null;
    // Leaving `live` drops the viewer socket.
    this.setPhase({ k: 'disposed' });
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = null;
    this.registration?.dispose();
    this.registration = null;
    this.sink = null;
    this.attachToken = null;
    this.viewListeners.clear();
  }
}

// --- module-level registry (mirrors terminal-lifecycle) ---

const registry = new Map<string, AgentBrowserSurfaceController>();

/**
 * The controller for `id`, created on first use. One driving a different
 * provider than `params` asks for is replaced, since `provider` is fixed for a
 * controller's life: a render swap the Wall restores in place keeps the id.
 */
export function acquireAgentBrowserSurfaceController(
  id: string,
  params: AgentBrowserSurfaceParams,
): AgentBrowserSurfaceController {
  const provider = surfaceProvider(params.renderMode);
  const existing = registry.get(id);
  if (existing?.provider === provider) return existing;
  if (existing) {
    registry.delete(id);
    // Outside the render that asked: disposal notifies the screen registry's
    // subscribers, other components among them.
    queueMicrotask(() => existing.dispose());
  }
  const controller = new AgentBrowserSurfaceController(id, params);
  registry.set(id, controller);
  return controller;
}

export function getAgentBrowserSurfaceController(id: string): AgentBrowserSurfaceController | null {
  return registry.get(id) ?? null;
}

/** Release all CLIENT-side resources for a surface (viewer socket, timers,
 *  screen registration), leaving its session running — for
 *  a Surface whose browser lives on elsewhere. A kill or a swap away uses
 *  `closeBrowserSurface`. A safe no-op for a surface with no controller
 *  (iframe/terminal). */
export function disposeAgentBrowserSurfaceController(id: string): void {
  const controller = registry.get(id);
  registry.delete(id);
  if (controller) controller.dispose();
  else settleLaunch(id, null);
}

/**
 * The one way a session is closed; resolves once the host answered. A close
 * starts no daemon, so it needs no drive gate, and the host serializes it with
 * the browser's launches. `binaryPath` is checked, not merely typed: it may come
 * off the persisted session blob, and names a program the host will spawn
 * (`lib/src/lib/agent-browser-binary.ts`).
 */
function closeSessionOn(provider: BrowserAutomationProvider, cwd: string | undefined, session: string, binaryPath: unknown, cancels?: readonly string[]): Promise<void> {
  const handle = browserHandle(provider, { session, cwd, binaryPath });
  return handle ? trackClose(provider, session, handle.close(cancels)) : Promise.resolve();
}

// Closes of each session this webview has sent and the host has not answered,
// which a launch naming the session waits out (`closeInFlight`): the host
// serializes a browser's launches and closes in arrival order, and not every
// transport delivers requests in the order sent.
const closesInFlight = new Map<string, Promise<void>>();
const closeKey = (provider: BrowserAutomationProvider, session: string) => `${provider}\0${session}`;

/** Record `closing` as a close of `session` in flight until the host answers. */
function trackClose(provider: BrowserAutomationProvider, session: string, closing: Promise<unknown>): Promise<void> {
  const key = closeKey(provider, session);
  const earlier = closesInFlight.get(key);
  const tracked: Promise<void> = Promise.all([earlier, closing]).then(() => {}, () => {})
    .finally(() => { if (closesInFlight.get(key) === tracked) closesInFlight.delete(key); });
  closesInFlight.set(key, tracked);
  return tracked;
}

/** What settles once every close of `session` this webview has sent has
 *  been answered; undefined when none is in flight. */
function closeInFlight(provider: BrowserAutomationProvider, session: string): Promise<void> | undefined {
  return closesInFlight.get(closeKey(provider, session));
}

/** Hand `id`'s controller a stream a `dor` command just learned, with the
 *  params that command just refreshed — acquired from them if no view has
 *  mounted it yet, so its first start views it at once. The params go first,
 *  so a host-reported presentation or cwd applies before the new stream: sync
 *  never sizes a headed window. */
export function handOverBrowserStream(id: string, params: AgentBrowserSurfaceParams, stream: number): void {
  const controller = acquireAgentBrowserSurfaceController(id, params);
  controller.updateParams(params);
  controller.handOver(stream);
}

/** Ask `id`'s browser for a render mode and a page — acquired from `params`
 *  if no view has mounted it yet (a Door a reveal is about to mount), so the
 *  request waits for its first start rather than being dropped. */
export function requestBrowserRenderMode(id: string, params: AgentBrowserSurfaceParams, mode: RenderMode, opts?: { url?: string }): void {
  acquireAgentBrowserSurfaceController(id, params).setRenderMode(mode, opts);
}

/** Close `params`'s automation session, for a Surface no controller holds.
 *  No-op for other surface types. */
function closeBrowserSessionFromParams(params: unknown): Promise<void> {
  const session = agentBrowserSessionFromParams(params);
  const { renderMode, cwd, binaryPath } = params as { renderMode?: unknown; cwd?: string; binaryPath?: unknown };
  const { provider } = parseRenderMode(renderMode);
  return session && provider ? closeSessionOn(provider, cwd, session, binaryPath) : Promise.resolve();
}

/**
 * A kill or a swap away from an automated renderer: surface lifetime and browser
 * lifetime are bound (docs/specs/dor-browser.md → "Placement And Lifetime"), so
 * close its session and release its controller. The controller closes what it
 * holds or its launch names, after any of that session's work still in flight;
 * `params` covers a session no controller holds. Resolves once the host
 * answered every close. No-op for other surface types.
 */
export function closeBrowserSurface(id: string, params: unknown): Promise<void> {
  const controller = registry.get(id);
  registry.delete(id);
  if (!controller) settleLaunch(id, null);
  const closed = controller?.close();
  const closing = [closed?.done ?? Promise.resolve()];
  if (agentBrowserSessionFromParams(params) !== (closed?.session ?? null)) closing.push(closeBrowserSessionFromParams(params));
  return Promise.all(closing).then(() => {});
}

// --- first-launch outcomes (the Wall's side of a controller-owned launch) ---

const launchWaiters = new Map<string, (error: string | null) => void>();

/**
 * The outcome of the first launch of the session-less Surface `id` the caller
 * just created: `null` once it streams — or once the Surface is gone — else why
 * it failed. Register before the Surface can mount, and at most once per id.
 */
export function whenBrowserLaunched(id: string): Promise<string | null> {
  return new Promise((resolve) => launchWaiters.set(id, resolve));
}

function settleLaunch(id: string, error: string | null): void {
  const settle = launchWaiters.get(id);
  launchWaiters.delete(id);
  settle?.(error);
}

/** For tests: controllers now outlive panel unmount, so a suite reusing a
 *  surface id must release them between cases — and forget closes a case left
 *  unanswered, which the next case's named launch would wait on. */
export function disposeAllAgentBrowserSurfaceControllers(): void {
  for (const id of [...registry.keys()]) disposeAgentBrowserSurfaceController(id);
  closesInFlight.clear();
}
