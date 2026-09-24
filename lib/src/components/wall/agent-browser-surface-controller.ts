/**
 * Surface-scoped browser lifecycle; see docs/specs/dor-browser.md →
 * "Agent-Browser Connection". The registry survives panel unmount and is
 * released by Wall on kill/render swap: `closeBrowserSurface` closes the
 * session too, `disposeAgentBrowserSurfaceController` only the client side.
 */
import type { AgentBrowserCommandResult } from '../../lib/platform/types';
import { isBrowsableUrl, playwrightTextInputs, type BrowserAutomationProvider } from '../../lib/platform/browser-automation';
import { isAllowedBinaryFor } from '../../lib/agent-browser-binary';
import { readTextFromClipboard } from '../../lib/clipboard';
import { messageOf } from '../../lib/errors';
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
import {
  automationMode,
  automationProvider,
  browserPlatform,
  isPopout,
  offeredRenderModes,
  PROVIDER_LABEL,
  type BrowserPlatform,
} from './browser-automation';
import { agentBrowserSessionFromParams, isToolParams } from './browser-surface';
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
/** Keep low-latency stream painting active briefly after input — pointer, keys,
 *  pasted text, editing chords. Continuous input extends the window; idle
 *  animated pages stay on the cheaper crisp path. */
export const PROVISIONAL_INPUT_WINDOW_MS = 250;

// The high-rate `[ab-panel]` stream/screenshot diagnostics fire per frame
// (~20Hz), so the flag is read ONCE — lazily, on the first log — and memoized:
// toggling needs a reload, which is the right trade for a hot loop. The
// connection's always-on debug ring is unaffected.
// `localStorage.setItem('dormouse.flags.abDebugLogs', 'true')` + reload to enable.
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

function dprMatch(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.001;
}


// A stray about:blank the close+reopen of a relaunch can surface is never the
// page the pane shows.
function isShownUrl(url: string | null | undefined): url is string {
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

/** Canonical params for a browser surface, as the view reads them. Pop-out is
 *  deliberately absent: it is derived from `renderMode`, never stored, and
 *  `wsPort` is only a one-shot handover of a port a launch just learned
 *  (docs/specs/dor-browser.md → "Canonical Params"). */
export interface AgentBrowserSurfaceParams {
  surfaceType?: string;
  renderMode?: RenderMode;
  cwd?: string;
  session?: string;
  key?: string;
  wsPort?: number;
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
 * "Agent-Browser Connection" has the transition table). The stream connection
 * exists exactly in `live`, and so does every daemon command (`canDrive`).
 */
type Phase =
  /** Constructed; no view has started it yet. */
  | { k: 'idle' }
  /** No session to show: inert until params deliver one. */
  | { k: 'unbound' }
  /** The session's stream port is being asked of the host (`attach`). */
  | { k: 'attaching' }
  /** Streaming from `port`. `windowSeen`: a headed browser's stream has
   *  connected, so a later drop means its window closed. */
  | { k: 'live'; port: number; windowSeen: boolean }
  /** Hidden long enough to shed the stream; the daemon stays up at `port`. */
  | { k: 'parked'; port: number }
  /** A headed↔headless relaunch toward `headed` is in flight: the host closes
   *  the browser and kills its daemon before reopening on a new port. */
  | { k: 'relaunching'; headed: boolean }
  /** Nothing to show: the browser went away, or `error` kept it from opening. */
  | { k: 'ended'; error?: string }
  /** Released; `closed` when its session was closed with it, so work still in
   *  flight closes whatever it brings back up. */
  | { k: 'disposed'; closed: boolean };

export type BrowserSurfacePhase = Phase['k'];

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
  /** Ask the view to swap to iframe or the other automation provider. The ≥2-tab
   *  typed-confirm gate and the Wall's `onSwapRenderMode` are view concerns; the
   *  view reads tabs from the snapshot and decides. */
  requestRenderSwap(mode?: RenderMode): void;
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
  /** Headed: the browser is (or is being opened as) a separate OS window. */
  poppedOut: boolean;
  phase: BrowserSurfacePhase;
  /** A headed↔headless relaunch is in flight: the old stream is gone by design
   *  and the new one is not yet known, so the view shows neither "ended" nor
   *  a pop-in/pop-out affordance. A projection of `phase`. */
  relaunching: boolean;
  /** Why the browser could not be opened, while `phase` is `ended`. */
  error: string | undefined;
}

const EMPTY_TABS: StreamTab[] = [];

export class AgentBrowserSurfaceController {
  readonly id: string;
  readonly provider: BrowserAutomationProvider;
  private cwd?: string;
  /** Rebuilt only when `cwd` changes: the Playwright adapter closes over it,
   *  and every stream frame reads it several times. */
  private platformCache: BrowserPlatform | null = null;
  private get platform(): BrowserPlatform {
    return this.platformCache ??= browserPlatform(this.provider, this.cwd);
  }
  /** Gates the render modes offered; see `ensureStarted`. */
  private readonly isTool: boolean;
  /** What `setRenderMode` accepts, fixed at start with the host's capabilities. */
  private renderModes: readonly RenderMode[] = [];

  private phase: Phase = { k: 'idle' };
  /** The presentation this Surface shows: a separate OS window, or in the pane.
   *  Seeded from `renderMode`; changed by a relaunch (optimistically, reverted
   *  if it fails) or, for Playwright, by a native relaunch the host reports. */
  private headed: boolean;

  // --- params (mirrors of the persisted blob) ---
  private session: string | undefined;
  private binaryPath: string | undefined;
  /** The last `wsPort` params carried: a change is a handover of a live port. */
  private paramsWsPort: number | undefined;
  private paramsUrl: string | undefined;
  private paramsKey: string | null;
  private paramsSyncEngaged: boolean | undefined;

  // --- stream connection (exists only while live) ---
  private connection: AgentBrowserConnection | null = null;
  private screenshotLoop: ScreenshotLoop | null = null;
  private connectionUnsub: (() => void) | null = null;
  private connectionKey: string | null = null;
  // The `session:port` the connection last (re)connected to. An unpark
  // reconnects to the same identity, so the last good frame is still valid and
  // must not be blanked to the placeholder; only a real identity change resets
  // hasFrame.
  private lastConnectedIdentity: string | null = null;
  /** The port of the last live/parked phase, whose viewport sync still holds. */
  private boundPort: number | undefined;

  // --- view state (the snapshot) ---
  private status: StreamStatus | null = null;
  private hasFrame = false;
  private connectionLost = false;
  private tabs: StreamTab[] = EMPTY_TABS;

  // --- visibility / parking ---
  private visible = true;
  /** Hidden (or detached) for the park delay: a live pane parks. */
  private parkRequested = false;
  private parkTimer: ReturnType<typeof setTimeout> | undefined;

  /** The latest navigation asked for while nothing could be driven, run once
   *  the Surface is live: a relaunch or attach must not lose it. */
  private pendingNavigation: string | undefined;

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

  // --- CDP observer (while popped out) ---
  private cdpKey: string | null = null;
  private cdpTeardown: (() => void) | null = null;

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
  // Counts the provisional paints that supersede a crisp capture in flight —
  // not those made only while one is overdue, which it is newer than
  // (`createScreenshotLoop`).
  private provisionalPaintGeneration = 0;
  private paintingForOverdue = false;
  // Param writes buffered while detached (a minimized popped-out pane can still
  // observe URL changes); flushed on the next attach.
  private pendingParams = new Map<string, unknown>();
  private pendingTitle: string | null = null;
  // The renderMode this controller last wrote, until params show it back
  // (`followParamsHeadedness`).
  private unechoedRenderMode: RenderMode | null = null;

  private readonly viewListeners = new Set<() => void>();
  private viewSnapshot: AgentBrowserViewSnapshot;

  constructor(id: string, params: AgentBrowserSurfaceParams) {
    this.id = id;
    // An unset mode (a direct mount in tests) is agent-browser.
    this.provider = automationProvider(params.renderMode) ?? 'agent-browser';
    this.cwd = params.cwd;
    // A Surface's kind never changes over its life (a tool's capabilities come
    // and go, its identity does not), so this is safe to seed once.
    this.isTool = isToolParams(params);
    this.session = params.session;
    this.binaryPath = allowedBinaryPath(params.binaryPath, this.provider);
    this.paramsWsPort = params.wsPort;
    this.paramsUrl = params.url;
    this.paramsKey = params.key ?? null;
    this.paramsSyncEngaged = params.syncEngaged;
    this.latestRestorableUrl = isBrowsableUrl(params.url) ? params.url : undefined;
    // Headedness is derived from the canonical renderMode; an unset mode (a
    // direct mount in tests) is not popped out.
    this.headed = isPopout(params.renderMode);
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
        this.runCommand(['set', 'device', name]);
      },
      applyViewport: (w, h, dpr) => {
        this.lastIssued = null;
        this.setSyncEngaged(false);
        this.runCommand(['set', 'viewport', String(w), String(h), String(dpr)]);
      },
      openModal: () => openAgentBrowserScreenModal(this.id),
      setRenderMode: (mode, opts) => {
        // Only what the modal could offer: the popout below never reaches the
        // Wall's own tool guard.
        if (!this.renderModes.includes(mode)) return;
        // A swap to iframe or the other provider is a render swap handled by
        // the Wall (the view owns the ≥2-tab confirm gate + onSwapRenderMode);
        // screencast ↔ popout relaunches this same session, in-controller,
        // carrying the page asked for rather than racing a navigation into it.
        if (automationProvider(mode) !== this.provider) this.sink?.requestRenderSwap(mode);
        else if (isPopout(mode) !== this.headed) this.relaunch(isPopout(mode), opts?.url);
        else if (opts?.url) this.navigate(opts.url);
      },
    };

    // Native history nav — issued like tab actions, through the daemon gate.
    this.chromeActions = {
      navigate: (url) => this.navigate(url),
      back: () => this.runCommand(['back']),
      forward: () => this.runCommand(['forward']),
      reload: () => this.runCommand(['reload']),
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
    return {
      tabs: this.tabs,
      status: this.status,
      connectionLost: this.connectionLost,
      hasFrame: this.hasFrame,
      poppedOut: this.headed,
      phase: phase.k,
      relaunching: phase.k === 'relaunching',
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
      prev.connectionLost === next.connectionLost &&
      prev.hasFrame === next.hasFrame &&
      prev.poppedOut === next.poppedOut &&
      prev.phase === next.phase &&
      prev.error === next.error
    ) return;
    this.viewSnapshot = next;
    for (const listener of this.viewListeners) listener();
  }

  getDeviceSize(): { width: number; height: number } {
    return this.device;
  }

  // --- one-time start (from the first attach; keeps side effects out of render) ---

  private ensureStarted(): void {
    if (this.phase.k !== 'idle') return;
    // Never a popout or another provider for a tool, whose `render` is `iframe`
    // or `ab-screencast`: the swap would tear the browser down and re-derive
    // the same screencast, so asking for a native window would get a reload
    // (`docs/specs/dor-tool.md` -> Declaring tools).
    this.renderModes = offeredRenderModes(this.isTool, this.provider);
    this.watchDpr();
    this.registration = registerAgentBrowserScreen(this.id, {
      snapshot: this.computeScreenSnapshot(),
      actions: this.screenActions,
      chrome: this.chrome,
      chromeActions: this.chromeActions,
      hostCapable: !!this.platform.agentBrowserCommand,
      renderModes: this.renderModes,
    });
    this.lastPublishedScreen = null;
    this.publishScreen();
    this.bind(this.paramsWsPort);
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
      this.publishScreen();
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
    this.publishScreen();
    // After a (re)attach, if a live in-pane connection exists, force one capture
    // so a view remounted within the park debounce repaints instead of sitting
    // blank — the connection's own frame dedup swallows the heartbeat rebroadcast,
    // and the bumped generation defeats the screenshot loop's byte dedup.
    if (this.phase.k === 'live' && !this.headed) this.screenshotLoop?.pulse();
    return {
      // Guard by identity: a stale handle's detach must no-op if a newer view
      // has already attached (StrictMode attach A → detach A → attach B can
      // interleave), and dispose already released everything.
      detach: () => {
        if (this.phase.k === 'disposed' || this.attachToken !== token) return;
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
    if (this.phase.k === 'disposed') return;
    // Mirror every field first, then rebind once: a session and the port a
    // launch learned for it land as a single write, and binding per field would
    // attach the session before its port is mirrored.
    if (params.cwd !== undefined && params.cwd !== this.cwd) {
      this.cwd = params.cwd;
      this.platformCache = null;
    }
    // Before the port below, so the new stream never inherits a `set viewport`
    // meant for the old mode.
    if (params.renderMode) this.followParamsHeadedness(params.renderMode);
    const sessionChanged = params.session !== this.session;
    this.session = params.session;
    this.binaryPath = allowedBinaryPath(params.binaryPath, this.provider);
    let handover: number | undefined;
    if (params.wsPort !== this.paramsWsPort) {
      this.paramsWsPort = params.wsPort;
      handover = params.wsPort;
    }
    if (params.url !== this.paramsUrl) {
      this.paramsUrl = params.url;
      if (isBrowsableUrl(params.url)) this.latestRestorableUrl = params.url;
    }
    if ((params.key ?? null) !== this.paramsKey) {
      this.paramsKey = params.key ?? null;
      this.recomputeChrome();
    }
    if (params.syncEngaged !== undefined) this.paramsSyncEngaged = params.syncEngaged;
    // Before the first attach, `ensureStarted` binds whatever has arrived.
    if (this.phase.k === 'idle') return;
    if (sessionChanged) this.bind(handover);
    else if (handover) this.adopt(handover);
  }

  /**
   * Playwright's native `open` can change headedness outside the Display modal,
   * and the Wall records the host-reported mode in params
   * (`ensureAgentBrowserSurface`). Everything else that arrives here is this
   * controller's own popOut/popIn write coming back, so agent-browser ignores
   * it, and so does a relaunch in flight. Params that have not yet shown this
   * controller's last mode write predate it — buffered while detached, or a
   * render (StrictMode's second effect pass) that ran before the store caught
   * up — and would flip the mode back.
   */
  private followParamsHeadedness(renderMode: RenderMode): void {
    if (this.unechoedRenderMode !== null) {
      if (renderMode === this.unechoedRenderMode) this.unechoedRenderMode = null;
      return;
    }
    if (this.provider !== 'playwright' || this.phase.k === 'relaunching') return;
    const headed = isPopout(renderMode);
    if (headed === this.headed) return;
    // The last status came from the old browser; auto-revert waits for the
    // new stream's own before it treats a disconnect as the window closing.
    this.setStatus(null);
    if (this.phase.k === 'live') this.phase.windowSeen = false;
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
    if (typeof params.renderMode === 'string') this.unechoedRenderMode = params.renderMode as RenderMode;
    if (this.sink) this.sink.updateParameters(params);
    else for (const [k, v] of Object.entries(params)) this.pendingParams.set(k, v);
  }

  // --- phase ---

  /** Enter `next`, with the stream connection and CDP observer following it. */
  private setPhase(next: Phase): void {
    this.phase = next;
    if (next.k === 'live' || next.k === 'parked') {
      // A new or restarted browser comes up at its native viewport; if sync is
      // engaged, reclaim the pane size. Clearing lastIssued is essential — it
      // otherwise still holds the previous browser's pane size and
      // issueSyncToPane would no-op, leaving the fresh browser unsynced.
      if (next.port !== this.boundPort) {
        this.boundPort = next.port;
        this.lastIssued = null;
      }
    }
    this.reconcileConnection();
    this.reconcileCdp();
    this.emitView();
    if (next.k !== 'live') return;
    // issueSyncToPane no-ops outside `live`, so a resize made meanwhile — behind
    // a hidden tab, or across a relaunch — is pushed now (lastIssued makes this a
    // no-op when the pane size did not change).
    if (this.syncEngaged) this.issueSyncToPane();
    const url = this.pendingNavigation;
    this.pendingNavigation = undefined;
    if (url) this.runCommand(['open', url]);
  }

  /** (Re)bind the current params: a session without a port learns it from the
   *  host, one whose port was just handed over streams from it at once. */
  private bind(handover?: number): void {
    if (!this.session) this.setPhase({ k: 'unbound' });
    else if (handover) this.goLive(handover);
    else this.attach(true);
  }

  /** A port handed over for the bound session: stream from it. A relaunch in
   *  flight ignores it — the host's answer is the authoritative port. */
  private adopt(port: number): void {
    const phase = this.phase;
    if (phase.k === 'relaunching' || phase.k === 'unbound') return;
    if (phase.k === 'live' && phase.port === port) return;
    if (phase.k === 'parked') this.setPhase({ k: 'parked', port });
    else this.goLive(port);
  }

  private goLive(port: number): void {
    this.setPhase(this.parkRequested && !this.headed
      ? { k: 'parked', port }
      : { k: 'live', port, windowSeen: false });
  }

  /**
   * Ask the host where the session's stream is (`attach`, which never starts a
   * daemon to answer). With `relaunch`, a session whose daemon is gone is
   * reopened at the page this Surface had, so a restore after a reboot comes
   * back where it was. Without, as on an unpark, a gone daemon is `ended`, or
   * `fallbackPort` streams on to find that out.
   */
  private attach(relaunch: boolean, fallbackPort?: number): void {
    const session = this.session;
    if (!session) { this.setPhase({ k: 'unbound' }); return; }
    const platform = this.platform;
    if (!platform.agentBrowserAttach) {
      if (fallbackPort) this.goLive(fallbackPort);
      else this.setPhase({ k: 'ended' });
      return;
    }
    const phase: Phase = { k: 'attaching' };
    this.setPhase(phase);
    const url = relaunch ? this.currentRelaunchUrl() : undefined;
    // Call through the adapter instance — pulling the method into a bare
    // variable would detach `this` and break its internal `requestResponse`.
    platform.agentBrowserAttach(session, { url, headed: this.headed }, this.binaryPath)
      .catch((err: unknown) => ({ ok: false, wsPort: undefined, error: messageOf(err) }))
      .then((res) => {
        if (this.phase !== phase) {
          if (url) this.closeIfClosedMeanwhile(session);
          return;
        }
        if (res.ok && res.wsPort) this.goLive(res.wsPort);
        else if (fallbackPort) this.goLive(fallbackPort);
        else this.setPhase({ k: 'ended', error: relaunch ? res.error : undefined });
      });
  }

  /** The Surface was closed while `session` had work in flight that can bring
   *  its daemon back up — a relaunch, or an attach that relaunches — so close
   *  it again once that work lands. */
  private closeIfClosedMeanwhile(session: string): void {
    if (this.phase.k === 'disposed' && this.phase.closed) this.closeSession(session);
  }

  private closeSession(session: string): void {
    // A close starts no daemon, so it needs no gate.
    this.platform.agentBrowserCommand?.(session, ['close'], this.binaryPath).catch(() => {});
  }

  // --- parking ---

  private updateParkState(): void {
    if (this.parkTimer) { clearTimeout(this.parkTimer); this.parkTimer = undefined; }
    // Detached ⇒ hidden. Popped out is exempt: its stream/CDP observer detects a
    // headed window close and drives auto-revert, so parking it would break that.
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
    // A parked pane holds no stream/screenshot loop; the daemon/session stays
    // alive and re-broadcasts on reconnect. An unpark asks the host where the
    // stream is now — the daemon may have moved while no client was alive —
    // falling back to the port it parked at.
    if (parkRequested && phase.k === 'live') this.setPhase({ k: 'parked', port: phase.port });
    else if (!parkRequested && phase.k === 'parked') this.attach(false, phase.port);
  }

  // --- stream connection (keyed; exists exactly while live) ---

  private reconcileConnection(): void {
    const phase = this.phase;
    const key = phase.k === 'live' ? `${this.session}:${phase.port}` : null;
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
    if (phase.k !== 'live') return;

    const session = this.session!;
    const streamPort = phase.port;

    // Per-connection pairing: the screenshot loop and the connection are created
    // and disposed together. The loop lives here (not in a separate effect) so a
    // reconnect always re-creates it — a disposed loop would silently drop every
    // frame pulse.
    const screenshotLoop = createScreenshotLoop({
      getPlatform: () => this.platform,
      getSession: () => this.session,
      getBinaryPath: () => this.binaryPath,
      isCapable: () => !!this.platform.agentBrowserScreenshot && this.canDrive(),
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
      getStreamUrl: async (port) => (await this.platform.getAgentBrowserStreamUrl?.(port)) ?? undefined,
      runCommand: (_session, args) => this.command(args)
        ?? Promise.resolve({ exitCode: 1, stdout: '', stderr: `${PROVIDER_LABEL[this.provider]} commands unavailable` }),
      canSelectTabs: () => !this.headed,
      wantFrameData: () => this.wantsProvisionalFrame(),
      log: abDebugLog,
    });
    this.connection = connection;
    this.screenshotLoop = screenshotLoop;
    this.connectionUnsub = connection.subscribe((event) => {
      if (event.type === 'connection-open') {
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
      } else if (event.type === 'url') {
        // A navigation committed. `tabs` catches up only when the driving
        // command completes — for a slow page, the whole load — so record it now:
        // the header follows, and a relaunch mid-load carries the page being
        // loaded rather than the one before it.
        this.applyStreamUrl(event.url);
      } else if (event.type === 'tabs') {
        const prevActiveId = event.previousTabs.find((t) => t.active)?.tabId;
        const nextActiveId = event.tabs.find((t) => t.active)?.tabId;
        this.setTabs(event.tabs);
        // Switching the active tab doesn't make the daemon emit a screencast
        // frame, and the dedup'd stream is otherwise silent on a static page, so
        // force one capture so the surface follows the tab the user just selected.
        if (nextActiveId && nextActiveId !== prevActiveId && !this.headed) {
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
        if (event.data) this.drawProvisionalFrame(event.data, this.paintingForOverdue);
        this.maybeDisengageSync();
        this.publishScreen();
        if (!this.headed) screenshotLoop.pulse();
      }
    });
    // The new stream reports its own status; the last one came from whatever
    // this Surface streamed before.
    this.status = null;
    this.connectionLost = false;
    // Unparking reconnects to the same session/port; the last good frame is still
    // valid, so only blank to the placeholder when the identity actually changed.
    const identity = `${session}:${streamPort}`;
    if (this.lastConnectedIdentity !== identity) {
      this.lastConnectedIdentity = identity;
      this.setHasFrame(false);
    }
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

  private drawProvisionalFrame(data: string, forOverdueCapture: boolean): void {
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
    // Latest-only, like the crisp loop: a newer pulse arriving while this decode
    // is in flight bumps the sequence, and the stale bitmap is dropped rather
    // than painted over the newer frame.
    const mySeq = ++this.frameDrawSeq;
    createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })).then((bitmap) => {
      if (this.phase.k === 'disposed' || mySeq !== this.frameDrawSeq || this.sink !== sink) {
        bitmap.close();
        return;
      }
      if (!forOverdueCapture) this.provisionalPaintGeneration += 1;
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
    const forInput = !this.hasFrame || !this.platform.agentBrowserScreenshot || performance.now() <= this.provisionalUntil;
    this.paintingForOverdue = !forInput;
    return forInput || !!this.screenshotLoop?.captureOverdue();
  }

  // agent-browser's stream publishes the initial headed tab list but not every
  // same-tab manual navigation. While popped out, subscribe directly to Chrome
  // DevTools Protocol target/page events so the Dormouse URL/header tracks the
  // headed window without polling.
  private reconcileCdp(): void {
    if (this.provider === 'playwright') return; // The host stream also observes headed navigation.
    const phase = this.phase;
    // `get cdp-url` is a daemon command, so it waits for `live` like every other.
    const desired = phase.k === 'live' && this.headed && !!this.platform.agentBrowserCommand;
    const key = desired ? `${this.session}:${phase.port}` : null;
    if (key === this.cdpKey) return;
    this.cdpTeardown?.();
    this.cdpTeardown = null;
    this.cdpKey = key;
    if (!desired) return;
    this.cdpTeardown = this.startCdpObserver();
  }

  private startCdpObserver(): () => void {
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
        const result = await this.command(['get', 'cdp-url']);
        if (result?.exitCode === 0) cdpUrl = parseCdpUrl(result.stdout);
        else if (result) abDebugLog(`[ab-panel] cdp-url failed ${JSON.stringify({ stderr: result.stderr, stdout: result.stdout })}`);
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

  // --- view-snapshot field setters (notify on real change) ---

  private setStatus(status: StreamStatus | null): void {
    const prevConnected = this.status?.connected;
    this.status = status;
    this.emitView();
    if (status?.connected !== prevConnected) this.maybeAutoRevert();
  }

  private setConnectionLost(connectionLost: boolean): void {
    if (this.connectionLost === connectionLost) return;
    this.connectionLost = connectionLost;
    this.emitView();
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

  private setHeaded(headed: boolean): void {
    if (this.headed === headed) return;
    this.headed = headed;
    this.emitView();
    // Push the render-mode flip (screencast ↔ popout) to the header/modal.
    this.publishScreen();
    this.reconcileCdp();
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
    // The always-on pane-size observer reads syncEngaged at fire time, so there
    // is nothing to (re)wire here. Engaging issues a sync via engageSync; a
    // pending debounce that outlives a disengage is dropped by its own re-check.
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
    // DPR can't be read back from frames, so report the density we'd sync to.
    const viewport = { w: device.width, h: device.height, dpr: displayDpr };
    const state: ScreenState = dimsMatch(viewport, paneCss) ? 'SYNCED' : 'SCALED';
    const renderMode = automationMode(this.provider, this.headed);
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
    // Only a live browser is driven: a parked (hidden) pane's rect can be
    // degenerate, and nothing reaches a daemon mid-launch or mid-relaunch. The
    // next `live` reconciles any resize made meanwhile.
    if (!this.canDrive()) return;
    // A popped-out surface is a real headed OS window the user drives directly;
    // never force its viewport to the (now-stub) pane size. Sync resumes when it
    // pops back in — the new port's reclaim re-issues against the fresh session.
    if (this.headed) return;
    // Hosts without agentBrowserCommand (e.g. the web demo) can't drive the
    // viewport; stay silent rather than warn on every resize — the surface just
    // reads SCALED.
    if (!this.platform.agentBrowserCommand) return;
    const el = this.sink?.viewport;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const prev = this.lastIssued;
    if (prev && prev.w === w && prev.h === h && dprMatch(prev.dpr, dpr)) return;
    this.lastIssued = { w, h, dpr };
    this.syncConfirmed = false;
    this.runCommand(['set', 'viewport', String(w), String(h), String(dpr)]);
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

  // --- relaunch: pop-out / pop-in + auto-revert ---

  popIn(): void {
    this.relaunch(false);
  }

  /**
   * Pop-Out / pop-in: relaunch this session's browser headed as a native OS
   * window, or back headless in the pane, at `url` or the page it is on. The
   * host closes the browser and kills its daemon before reopening on a new
   * port, so the stream is dropped up front — its close would read as the
   * window closing, and a daemon command in the gap spawns a competing daemon —
   * and reconnects to the port the host hands back. One relaunch at a time, of
   * a bound browser: anything else keeps only the navigation asked for.
   */
  private relaunch(headed: boolean, url?: string): void {
    const session = this.session;
    const platform = this.platform;
    const k = this.phase.k;
    const capable = headed ? !!platform.agentBrowserPopOut : !!platform.agentBrowserPopIn;
    if (!session || !capable || (k !== 'live' && k !== 'parked' && k !== 'ended')) {
      abDebugLog(`[ab-panel] ${headed ? 'popOut' : 'popIn'} ignored in ${k}`);
      if (url) this.navigate(url);
      return;
    }
    if (isBrowsableUrl(url)) this.latestRestorableUrl = url;
    const target = this.currentRelaunchUrl();
    // The phase first: flipping headedness while still live would start the
    // CDP observer, whose `get cdp-url` would land in the close/reopen gap.
    const phase: Phase = { k: 'relaunching', headed };
    this.setPhase(phase);
    this.setHeaded(headed);
    this.writeParams({ renderMode: automationMode(this.provider, headed) });
    abDebugLog(`[ab-panel] ${headed ? 'popOut' : 'popIn'} -> ${JSON.stringify({ session, url: target })}`);
    // Call through the adapter instance — detaching the method drops `this`.
    const relaunched = headed
      ? platform.agentBrowserPopOut!(session, { rect: paneScreenRect(this.sink?.viewport), url: target }, this.binaryPath)
      : platform.agentBrowserPopIn!(session, { url: target }, this.binaryPath);
    relaunched.catch((err: unknown) => ({ ok: false, wsPort: undefined, error: messageOf(err) })).then((res) => {
      abDebugLog(`[ab-panel] relaunch result ${JSON.stringify(res)}`);
      if (this.phase !== phase) {
        this.closeIfClosedMeanwhile(session);
        return;
      }
      if (res.ok && res.wsPort) {
        this.goLive(res.wsPort);
        return;
      }
      // Failed: back in the pane at the page it was on, relaunching headless
      // there if no daemon came up.
      if (headed) {
        this.setHeaded(false);
        this.writeParams({ renderMode: automationMode(this.provider, false) });
      }
      this.attach(true);
    });
  }

  // Auto-revert: once the headed stream has connected, a later disconnect means
  // the window closed → relaunch headless and resume streaming. A Dormouse
  // teardown (pane kill, a render-swap away) releases the controller before it
  // closes the session, so no stream is left to see that close.
  private maybeAutoRevert(): void {
    const phase = this.phase;
    if (phase.k !== 'live' || !this.headed) return;
    if (this.status?.connected === true) phase.windowSeen = true;
    else if (phase.windowSeen && (this.status?.connected === false || this.connectionLost)) this.popIn();
  }

  // --- the daemon gate ---

  /** Whether a daemon command may run now: only while `live`. Mid-launch,
   *  mid-attach or mid-relaunch, a CLI command starts a competing daemon at
   *  about:blank (docs/specs/dor-browser.md → "Agent-Browser Connection"). */
  private canDrive(): boolean {
    return this.phase.k === 'live';
  }

  /** The one way this controller issues a daemon command; null when the gate
   *  refuses it or the host cannot run one. */
  private command(args: string[]): Promise<AgentBrowserCommandResult> | null {
    const session = this.session;
    if (!this.canDrive() || !session) {
      abDebugLog(`[ab-panel] ${args.join(' ')} dropped in ${this.phase.k}`);
      return null;
    }
    // Call through the adapter instance — pulling the method into a bare variable
    // would detach `this` and break its internal `requestResponse`.
    return this.platform.agentBrowserCommand?.(session, args, this.binaryPath) ?? null;
  }

  private runCommand(args: string[]): void {
    if (this.canDrive() && !this.platform.agentBrowserCommand) {
      console.warn(`[${this.provider}] this host cannot run ${PROVIDER_LABEL[this.provider]} commands; tab actions are unavailable`);
      return;
    }
    this.command(args)?.then((result) => {
      if (result.exitCode !== 0) {
        console.warn(`[${this.provider}] ${args.join(' ')} failed:`, result.stderr || result.stdout || `exit ${result.exitCode}`);
      }
    }).catch((error) => {
      console.warn(`[${this.provider}] ${args.join(' ')} failed:`, error);
    });
  }

  /** Navigate the active tab. Asked while nothing can be driven, it is kept as
   *  the one latest intent and run on the next `live`; an ended browser is
   *  attached again, relaunching at that page if its daemon is gone. */
  private navigate(url: string): void {
    if (!url) return;
    if (this.canDrive()) {
      this.runCommand(['open', url]);
      return;
    }
    if (this.phase.k === 'disposed') return;
    this.pendingNavigation = url;
    if (this.phase.k !== 'ended' || !this.session) return;
    if (isBrowsableUrl(url)) this.latestRestorableUrl = url;
    this.attach(true);
  }

  // --- input bridging ---

  send(payload: Record<string, unknown>): void {
    // Typing is the most latency-sensitive input there is: its echo must not
    // wait a crisp capture round trip any more than a hover does.
    if (typeof payload.type === 'string' && payload.type.startsWith('input_')) this.openProvisionalWindow();
    this.connection?.send(payload);
  }

  private openProvisionalWindow(): void {
    this.provisionalUntil = performance.now() + PROVISIONAL_INPUT_WINDOW_MS;
  }

  selectTab(tab: StreamTab): void {
    if (!tab.active) this.runCommand(['tab', tab.tabId]);
  }

  closeTab(tab: StreamTab): void {
    this.runCommand(['tab', 'close', tab.tabId]);
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
  // bridge by replaying the text: agent-browser's stream takes only key events,
  // so as per-character keyDown events; the Playwright host inserts it whole.
  private insertText(text: string): void {
    if (this.provider === 'playwright') {
      for (const message of playwrightTextInputs(text)) this.send(message);
      return;
    }
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
    // Native editing chords (select-all/copy/cut) don't fire over the stream
    // input path (CDP commands field is dropped), on any platform — Cmd on
    // macOS, Ctrl elsewhere. Route the intent through the host's purpose-built
    // edit channel instead — a daemon command, so gated like the rest. Every
    // shipped host implements `agentBrowserEdit`; the fall-through covers a
    // host that does not (the fake adapter), so the page still gets the chord
    // for its own JS shortcuts.
    if (mod && !e.altKey && !e.shiftKey) {
      const op = EDIT_OPS[e.key.toLowerCase() as keyof typeof EDIT_OPS];
      // Call through the adapter instance — detaching the method drops `this`.
      const platform = this.platform;
      const session = this.session;
      if (op && platform.agentBrowserEdit && session) {
        if (!this.canDrive()) return;
        this.openProvisionalWindow();
        platform.agentBrowserEdit(session, op, this.binaryPath).then((r) => {
          if (!r.ok && r.error) console.warn(`[${this.provider}] ${op} failed:`, r.error);
        }).catch((err) => console.warn(`[${this.provider}] ${op} failed:`, err));
        return;
      }
    }
    this.sendKey(e, 'keyDown');
  }

  // --- teardown ---

  /** Close this Surface's browser session and release the controller. Work in
   *  flight that could bring the session back up closes it again when it lands.
   *  Returns the session closed, if any. */
  close(): string | undefined {
    if (this.phase.k === 'disposed') return undefined;
    const session = this.session;
    this.release(true);
    if (session) this.closeSession(session);
    return session;
  }

  /** Release every client-side resource, leaving the session to whoever holds it
   *  next (a Workspace transfer's destination). */
  dispose(): void {
    if (this.phase.k === 'disposed') return;
    this.release(false);
  }

  private release(closed: boolean): void {
    if (this.parkTimer) { clearTimeout(this.parkTimer); this.parkTimer = undefined; }
    this.teardownPaneSizeObserver();
    this.paneSize = null;
    // Leaving `live` drops the connection, its screenshot loop and the CDP
    // observer.
    this.setPhase({ k: 'disposed', closed });
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
  const provider = automationProvider(params.renderMode) ?? 'agent-browser';
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

/** Release all CLIENT-side resources for a surface (connection, screenshot loop,
 *  CDP observer, timers, screen registration), leaving its session running — for
 *  a Surface whose browser lives on elsewhere. A kill or a swap away uses
 *  `closeBrowserSurface`. A safe no-op for a surface with no controller
 *  (iframe/terminal). */
export function disposeAgentBrowserSurfaceController(id: string): void {
  const controller = registry.get(id);
  if (!controller) return;
  registry.delete(id);
  controller.dispose();
}

/** Close `params`'s automation session, for a Surface no controller holds.
 *  No-op for other surface types. */
export function closeBrowserSessionFromParams(params: unknown): void {
  const session = agentBrowserSessionFromParams(params);
  if (!session) return;
  const { renderMode, cwd, binaryPath } = params as { renderMode?: unknown; cwd?: string; binaryPath?: unknown };
  const provider = automationProvider(renderMode);
  if (!provider) return;
  browserPlatform(provider, cwd).agentBrowserCommand?.(
    session,
    ['close'],
    // Checked, not merely typed: these params come off the persisted session
    // blob, and `binaryPath` names a program the host will spawn
    // (`lib/src/lib/agent-browser-binary.ts`).
    allowedBinaryPath(binaryPath, provider),
  ).catch(() => {});
}

/**
 * A kill or a swap away from an automated renderer: surface lifetime and browser
 * lifetime are bound (docs/specs/dor-browser.md → "Placement And Lifetime"), so
 * close its session and release its controller. The controller closes what it
 * holds, and closes again after any relaunch still in flight; `params` covers a
 * session no controller has bound yet. No-op for other surface types.
 */
export function closeBrowserSurface(id: string, params: unknown): void {
  const controller = registry.get(id);
  registry.delete(id);
  const closed = controller?.close();
  if (agentBrowserSessionFromParams(params) !== (closed ?? null)) closeBrowserSessionFromParams(params);
}

/** For tests: controllers now outlive panel unmount, so a suite reusing a
 *  surface id must release them between cases. */
export function disposeAllAgentBrowserSurfaceControllers(): void {
  for (const id of [...registry.keys()]) disposeAgentBrowserSurfaceController(id);
}
