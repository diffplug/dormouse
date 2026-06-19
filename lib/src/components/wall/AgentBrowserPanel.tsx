/**
 * Live agent-browser session viewer (see docs/specs/dor-agent-browser.md).
 *
 * One WebSocket — the session's stream socket — carries everything: JPEG
 * frames out, `input_mouse`/`input_keyboard` in, plus pushed `status` and
 * `tabs` messages. Tab actions (switch/close) go through the host's
 * `agentBrowserCommand` because a webview cannot spawn the agent-browser CLI.
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { clsx } from 'clsx';
import { TERMINAL_BOTTOM_RADIUS_CLASS } from '../design';
import { getPlatform } from '../../lib/platform';
import { readTextFromClipboard } from '../../lib/clipboard';
import { isEditableTarget } from '../../lib/dom';
import {
  openAgentBrowserScreenModal,
  registerAgentBrowserScreen,
  type ChromeActions,
  type ChromeSnapshot,
  type RenderMode,
  type ScreenActions,
  type ScreenRegistration,
  type ScreenSnapshot,
  type ScreenState,
} from './agent-browser-screen';
import { hostPathDisplay } from './browser-url';
import { resolveRenderMode } from './browser-surface';
import { clearAgentBrowserSessionClosed, isAgentBrowserSessionClosed } from './agent-browser-sessions';
import {
  EDIT_OPS,
  MOUSE_BUTTONS,
  MOUSE_BUTTON_MASKS,
  SPECIAL_KEYS,
  modifiers,
  virtualKeyCode,
} from './agent-browser-input';
import { createScreenshotLoop } from './agent-browser-screenshot-loop';
import {
  createAgentBrowserConnection,
  type AgentBrowserConnection,
  type AgentBrowserStreamStatus as StreamStatus,
  type AgentBrowserTab as StreamTab,
} from './agent-browser-connection';
import { usePaneChrome } from './use-pane-chrome';
import {
  ModeContext,
  SelectedIdContext,
  WallActionsContext,
} from './wall-context';

type AgentBrowserPanelParams = {
  surfaceType?: string;
  /** Canonical render backend; the BrowserPanel shell also passes it as a prop. */
  renderMode?: RenderMode;
  session?: string;
  key?: string;
  wsPort?: number;
  binaryPath?: string;
  /** The active tab's URL, mirrored from the live session so it persists in the
   *  layout blob and is available to render-mode swaps and pop-out without a live
   *  stream. The canonical target for the surface (see dor-iframe.md → Path 1). */
  url?: string;
  /** Whether sync-to-pane is engaged; persists via the dockview layout blob so
   *  a re-attached surface re-engages sync if it was engaged. Absent on a fresh
   *  surface ⇒ auto-engage (see docs/specs/dor-agent-browser.md). */
  syncEngaged?: boolean;
  /** Whether this session is currently popped out to a headed OS window
   *  (docs/specs/dor-agent-browser.md → "Headed Pop-Out"). Persists via the
   *  layout blob so a re-attached surface re-renders the stub. */
  poppedOut?: boolean;
};

/** Best-effort screen rect for positioning a popped-out window over the pane.
 *  VS Code webviews can't read true screen coords (the host then centers); on
 *  standalone, window.screenX/Y offset the pane's viewport rect into screen
 *  space. */
function paneScreenRect(el: HTMLElement | null): { x: number; y: number; width: number; height: number } | undefined {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  const sx = typeof window.screenX === 'number' ? window.screenX : 0;
  const sy = typeof window.screenY === 'number' ? window.screenY : 0;
  return { x: Math.round(sx + r.left), y: Math.round(sy + r.top), width: Math.round(r.width), height: Math.round(r.height) };
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

function tabDisplayTitle(tab: StreamTab): string {
  const title = tab.title?.trim();
  if (title) return title;
  return hostPathDisplay(tab.url) || 'untitled';
}

export function AgentBrowserPanel({ api, params, renderMode: renderModeProp }: IDockviewPanelProps<AgentBrowserPanelParams> & { renderMode?: RenderMode }) {
  const actions = useContext(WallActionsContext);
  // Stable handle so the screen controller (registered once) can reach the live
  // Wall actions — used by setRenderMode to trigger an in-place surface swap.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const mode = useContext(ModeContext);
  const selectedId = useContext(SelectedIdContext);
  const elRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  usePaneChrome(api, elRef);

  const session = params?.session;
  const wsPort = params?.wsPort;
  const [streamPort, setStreamPort] = useState(wsPort);
  useEffect(() => { setStreamPort(wsPort); }, [wsPort]);
  const interactive = mode === 'passthrough' && selectedId === api.id;
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  // A direct mouse click on the canvas should reach the page even when this pane
  // isn't the selected one yet — the click is what selects it (via the root
  // `onClickPanel`), but `selectedId` only updates on the next render, so gating
  // mouse-down/up on `interactive` would swallow the very first click on a
  // freshly-opened surface (the user clicks, nothing happens, they click again).
  // Mouse forwarding therefore only requires passthrough mode; keyboard/wheel
  // still require full `interactive` so a background pane never steals them.
  const passthrough = mode === 'passthrough';
  const passthroughRef = useRef(passthrough);
  passthroughRef.current = passthrough;

  const connectionRef = useRef<AgentBrowserConnection | null>(null);
  const deviceRef = useRef({ width: 1280, height: 720 });
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [streamRecoverySeq, setStreamRecoverySeq] = useState(0);
  const [tabs, setTabs] = useState<StreamTab[]>([]);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // Crossing to the single-frame iframe renderer closes all but the active tab;
  // when others are open the swap is gated behind a typed confirm (overlay below).
  const [pendingIframeSwap, setPendingIframeSwap] = useState(false);
  const swapConfirmRef = useRef<HTMLDivElement>(null);

  // Pop-out state: while true the browser runs in a headed OS window and the
  // pane is a stub. Seeded from params so it survives a re-attach.
  // poppedOut is derived from the canonical renderMode the shell passes; fall
  // back to resolving it from params for a direct mount (tests) or a legacy blob.
  const seededMode = renderModeProp ?? resolveRenderMode(params);
  const [poppedOut, setPoppedOut] = useState<boolean>(seededMode === 'ab-popout');
  const poppedOutRef = useRef(poppedOut);
  poppedOutRef.current = poppedOut;
  // Gate auto-revert: only treat a dropped stream as "window closed" once the
  // headed stream has actually connected (avoids reverting mid-relaunch).
  const headedConnectedRef = useRef(false);
  // True while a headed↔headless relaunch is in flight. The relaunch closes the
  // current stream before reopening on a new port, so that expected drop must
  // not be read as "the headed window closed" (it would auto-revert mid-pop-out).
  const relaunchingRef = useRef(false);

  const binaryPath = params?.binaryPath;
  const runAgentBrowser = useCallback((args: string[]) => {
    if (!session) return;
    // Call through the adapter instance — pulling the method into a bare
    // variable would detach `this` and break its internal `requestResponse`.
    const platform = getPlatform();
    if (!platform.agentBrowserCommand) {
      console.warn('[agent-browser] this host cannot run agent-browser commands; tab actions are unavailable');
      return;
    }
    platform.agentBrowserCommand(session, args, binaryPath).then((result) => {
      if (result.exitCode !== 0) {
        console.warn(`[agent-browser] ${args.join(' ')} failed:`, result.stderr || result.stdout || `exit ${result.exitCode}`);
      }
    }).catch((error) => {
      console.warn(`[agent-browser] ${args.join(' ')} failed:`, error);
    });
  }, [session, binaryPath]);
  const runAgentBrowserRef = useRef(runAgentBrowser);
  runAgentBrowserRef.current = runAgentBrowser;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const binaryPathRef = useRef(binaryPath);
  binaryPathRef.current = binaryPath;
  const wsPortRef = useRef(streamPort);
  wsPortRef.current = streamPort;
  const liveStreamPortRef = useRef<number | null>(null);
  // Canonical URL mirror (params.url): kept in a ref so the pop-out / pop-in
  // callbacks read the latest without re-creating, and prefer it over the live
  // chrome snapshot, which can be momentarily empty during a relaunch.
  const paramsUrl = params?.url;
  const paramsUrlRef = useRef(paramsUrl);
  paramsUrlRef.current = paramsUrl;
  // The newest non-blank active-tab URL observed from the live stream. This is
  // deliberately separate from params.url: Dockview param writes can lag a tab
  // message, but pop-in/auto-revert must carry the page the user just navigated
  // to in the headed window.
  const latestRestorableUrlRef = useRef<string | undefined>(isRestorableUrl(paramsUrl) ? paramsUrl : undefined);
  useEffect(() => {
    if (isRestorableUrl(paramsUrl)) latestRestorableUrlRef.current = paramsUrl;
  }, [paramsUrl]);
  const rememberRestorableUrl = useCallback((url: string | null | undefined) => {
    if (!isRestorableUrl(url)) return false;
    latestRestorableUrlRef.current = url;
    if (!relaunchingRef.current && url !== paramsUrlRef.current) {
      paramsUrlRef.current = url;
      api.updateParameters({ url });
    }
    return true;
  }, [api]);
  const rememberActiveTabUrl = useCallback((next: StreamTab[]) => {
    const active = next.find((t) => t.active) ?? next[0] ?? null;
    rememberRestorableUrl(active?.url);
  }, [rememberRestorableUrl]);
  const applyObservedNavigation = useCallback((url: string | null | undefined, title?: string | null) => {
    if (!isRestorableUrl(url)) return;
    rememberRestorableUrl(url);
    setTabs((prev) => {
      if (prev.length === 0) return [{ tabId: 'cdp-active', title: title ?? null, url, active: true }];
      const activeIndex = Math.max(0, prev.findIndex((tab) => tab.active));
      const current = prev[activeIndex];
      if (!current || (current.url === url && (title == null || current.title === title))) return prev;
      return prev.map((tab, index) => index === activeIndex
        ? { ...tab, url, title: title ?? tab.title }
        : tab);
    });
  }, [rememberRestorableUrl]);

  const closeIfSessionMarkedClosed = useCallback((targetSession: string | null | undefined = sessionRef.current): boolean => {
    if (!targetSession || !isAgentBrowserSessionClosed(targetSession)) return false;
    getPlatform().agentBrowserCommand?.(targetSession, ['close'], binaryPathRef.current).catch(() => {});
    return true;
  }, []);

  const reconcileStreamPort = useCallback(async (directPort?: number): Promise<boolean> => {
    if (closeIfSessionMarkedClosed()) return false;
    setConnectionLost(false);
    setStatus(null);
    setHasFrame(false);

    if (directPort && directPort > 0) {
      if (directPort !== wsPortRef.current) {
        setStreamPort(directPort);
        console.log(`[ab-panel] subscribing to returned stream port ${JSON.stringify({ session: sessionRef.current, wsPort: directPort, previousWsPort: wsPortRef.current })}`);
      }
      if (directPort !== wsPort) {
        api.updateParameters({ wsPort: directPort });
      } else {
        setStreamRecoverySeq((seq) => seq + 1);
      }
      return true;
    }

    const currentSession = sessionRef.current;
    const platform = getPlatform();
    if (!currentSession || !platform.agentBrowserStreamStatus) {
      setStreamRecoverySeq((seq) => seq + 1);
      return false;
    }

    try {
      const res = await platform.agentBrowserStreamStatus(currentSession, binaryPathRef.current);
      if (closeIfSessionMarkedClosed(currentSession)) return false;
      if (!res.ok || !res.wsPort) return false;
      if (res.wsPort !== wsPortRef.current) {
        setStreamPort(res.wsPort);
        api.updateParameters({ wsPort: res.wsPort });
      } else {
        setStreamRecoverySeq((seq) => seq + 1);
      }
      return true;
    } catch {
      return false;
    }
  }, [api, closeIfSessionMarkedClosed, wsPort]);

  // --- display: crisp HiDPI screenshots, paced by stream-frame "pulses" ---
  //
  // The screencast is CSS-resolution only, so we DISPLAY device-resolution
  // screenshots and use stream frames purely as "page changed" pulses. The
  // backpressure machine lives in createScreenshotLoop; here we just supply the
  // live session/binary/capability (via refs) and the canvas draw.
  const drawBitmap = useCallback((bitmap: ImageBitmap) => {
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
  }, []);

  const screenshotCapableRef = useRef(false);
  screenshotCapableRef.current = !!getPlatform().agentBrowserScreenshot && !!session;

  // --- screen indicator (SYNCED/SCALED) + sync-to-pane ---
  //
  // A fresh surface auto-engages sync (no persisted flag); a re-attached one
  // restores whatever was persisted into the layout blob.
  const [syncEngaged, setSyncEngaged] = useState<boolean>(params?.syncEngaged ?? true);
  const syncEngagedRef = useRef(syncEngaged);
  syncEngagedRef.current = syncEngaged;
  // The pane size we last issued `set viewport` for; null while not driving the
  // viewport (device/custom, or never issued). Used both to skip redundant
  // re-issues and to detect an external `set …` taking over.
  const lastIssuedRef = useRef<{ w: number; h: number; dpr: number } | null>(null);
  // True once a frame has confirmed `lastIssued` actually landed. Until then,
  // frames still at the browser's pre-resize size are our own `set` not having
  // taken effect yet — not an external override.
  const syncConfirmedRef = useRef(false);
  const lastPublishedRef = useRef<ScreenSnapshot | null>(null);
  const registrationRef = useRef<ScreenRegistration | null>(null);

  const computeSnapshot = useCallback((): ScreenSnapshot => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const displayDpr = window.devicePixelRatio || 1;
    const device = deviceRef.current;
    const paneCss = { w: rect ? Math.round(rect.width) : 0, h: rect ? Math.round(rect.height) : 0 };
    // DPR can't be read back from frames, so report the density we'd sync to.
    const viewport = { w: device.width, h: device.height, dpr: displayDpr };
    const state: ScreenState = dimsMatch(viewport, paneCss) ? 'SYNCED' : 'SCALED';
    const renderMode = poppedOutRef.current ? 'ab-popout' : 'ab-screencast';
    return { state, viewport, paneCss, displayDpr, syncEngaged: syncEngagedRef.current, renderMode };
  }, []);

  // Publish to the registry only when something the header/modal cares about
  // changed — never per frame (the frame loop calls this every paint).
  const publishScreen = useCallback(() => {
    const next = computeSnapshot();
    const prev = lastPublishedRef.current;
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
      lastPublishedRef.current = next;
      registrationRef.current?.update(next);
    }
  }, [computeSnapshot]);

  // Push the current pane size to the browser as a native `set viewport`.
  const issueSyncToPane = useCallback(() => {
    // A popped-out surface is a real headed OS window the user drives directly;
    // never force its viewport to the (now-stub) pane size. Sync resumes when it
    // pops back in — the wsPort-change effect re-issues against the fresh session.
    if (poppedOutRef.current) return;
    // Hosts without agentBrowserCommand (Tauri today) can't drive the viewport;
    // stay silent rather than warn on every resize. The surface just reads
    // SCALED, which is accurate.
    if (!getPlatform().agentBrowserCommand) return;
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const prev = lastIssuedRef.current;
    if (prev && prev.w === w && prev.h === h && Math.abs(prev.dpr - dpr) <= 0.001) return;
    lastIssuedRef.current = { w, h, dpr };
    syncConfirmedRef.current = false;
    runAgentBrowserRef.current(['set', 'viewport', String(w), String(h), String(dpr)]);
  }, []);

  // Last-writer-wins: drop sync when an external `dor ab set …` takes the
  // viewport away from what we issued. The trap is that right after we issue a
  // new size, the browser keeps streaming the OLD size for a few frames — those
  // must NOT count as external. So we only disengage once a frame has first
  // *confirmed* our issued size landed, and a later frame then deviates.
  const maybeDisengageSync = useCallback(() => {
    if (!syncEngagedRef.current) return;
    const issued = lastIssuedRef.current;
    const el = viewportRef.current;
    if (!issued || !el) return;
    const rect = el.getBoundingClientRect();
    const pane = { w: Math.round(rect.width), h: Math.round(rect.height) };
    // Mid-resize: we haven't issued for the pane's current size yet.
    if (!dimsMatch(issued, pane)) return;
    const device = { w: deviceRef.current.width, h: deviceRef.current.height };
    if (dimsMatch(device, issued)) {
      syncConfirmedRef.current = true; // our `set` landed
      return;
    }
    // Frame differs from what we issued: a pre-landing stale frame until
    // confirmed; an external override once confirmed.
    if (syncConfirmedRef.current) setSyncEngaged(false);
  }, []);

  // --- stream connection ---

  useEffect(() => {
    if (!streamPort || !session) return;

    // Per-connection resource: created here and disposed in this effect's cleanup
    // so it survives React StrictMode's mount→cleanup→mount double-invoke. A
    // memoized loop disposed by a separate effect's cleanup would never be
    // recreated on the re-mount, leaving every frame pulse dropped (disposed loop).
    const screenshotLoop = createScreenshotLoop({
      getSession: () => sessionRef.current,
      getBinaryPath: () => binaryPathRef.current,
      isCapable: () => screenshotCapableRef.current,
      draw: drawBitmap,
    });

    const connection = createAgentBrowserConnection({
      session,
      streamPort,
      binaryPath: binaryPathRef.current,
      getStreamUrl: async (port) => (await getPlatform().getAgentBrowserStreamUrl?.(port)) ?? undefined,
      runCommand: (targetSession, args, targetBinaryPath) => getPlatform().agentBrowserCommand?.(targetSession, args, targetBinaryPath)
        ?? Promise.resolve({ exitCode: 1, stdout: '', stderr: 'agent-browser commands unavailable' }),
      canSelectTabs: () => !poppedOutRef.current && !relaunchingRef.current,
      log: (message) => console.log(message),
    });
    connectionRef.current = connection;
    const unsubscribe = connection.subscribe((event) => {
      if (event.type === 'connection-open') {
        liveStreamPortRef.current = event.port;
        setConnectionLost(false);
      } else if (event.type === 'connection-close') {
        if (event.failures >= 3) setConnectionLost(true);
      } else if (event.type === 'status') {
        setStatus(event.status);
        setConnectionLost(event.status.connected === false);
        const maybeStatus = event.status as StreamStatus & { viewportWidth?: number; viewportHeight?: number };
        if (typeof maybeStatus.viewportWidth === 'number' && typeof maybeStatus.viewportHeight === 'number') {
          deviceRef.current = { width: maybeStatus.viewportWidth, height: maybeStatus.viewportHeight };
          maybeDisengageSync();
          publishScreen();
        }
      } else if (event.type === 'tabs') {
        const prevActiveId = event.previousTabs.find((t) => t.active)?.tabId;
        const nextActiveId = event.tabs.find((t) => t.active)?.tabId;
        rememberActiveTabUrl(event.tabs);
        setTabs(event.tabs);
        // Switching the active tab doesn't make the daemon emit a screencast
        // frame, and the dedup'd stream is otherwise silent on a static page, so
        // nothing would repaint the canvas onto the newly-active tab. Force one
        // capture so the surface follows the tab the user just selected.
        if (nextActiveId && nextActiveId !== prevActiveId && !poppedOutRef.current && !relaunchingRef.current) {
          screenshotLoop.pulse();
        }
      } else if (event.type === 'frame-pulse') {
        if (event.metadata?.deviceWidth && event.metadata?.deviceHeight) {
          deviceRef.current = { width: event.metadata.deviceWidth, height: event.metadata.deviceHeight };
        }
        maybeDisengageSync();
        publishScreen();
        if (!poppedOutRef.current && !relaunchingRef.current) screenshotLoop.pulse();
      }
    });
    setHasFrame(false);
    setConnectionLost(false);
    return () => {
      unsubscribe();
      if (connectionRef.current === connection) connectionRef.current = null;
      connection.dispose();
      screenshotLoop.dispose();
    };
  }, [streamPort, streamRecoverySeq, session, maybeDisengageSync, publishScreen, drawBitmap, rememberActiveTabUrl]);

  // agent-browser's stream currently publishes the initial headed tab list, but
  // not every same-tab manual navigation. While popped out, subscribe directly
  // to Chrome DevTools Protocol target/page events so the Dormouse URL/header
  // tracks the headed window without polling.
  useEffect(() => {
    if (!poppedOut || !session) return;
    const platform = getPlatform();
    // Bind to a local const: TS doesn't carry the narrowing of an optional
    // property into the nested `connect` closure, so the direct call wouldn't
    // typecheck against the `agentBrowserCommand?` signature.
    const runCommand = platform.agentBrowserCommand;
    if (!runCommand) return;
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
      applyObservedNavigation(
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
        console.log(`[ab-panel] cdp target destroyed ${JSON.stringify({ targetId: msg.params?.targetId })}`);
      } else if (msg.method === 'Page.frameNavigated') {
        const frame = msg.params?.frame;
        if (!frame?.parentId) {
          applyObservedNavigation(
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
        const result = await runCommand(session, ['get', 'cdp-url'], binaryPathRef.current);
        if (result.exitCode === 0) cdpUrl = parseCdpUrl(result.stdout);
        else console.log(`[ab-panel] cdp-url failed ${JSON.stringify({ stderr: result.stderr, stdout: result.stdout })}`);
      } catch (err) {
        console.log(`[ab-panel] cdp-url error ${String(err)}`);
      }
      if (disposed || !cdpUrl) return;
      console.log(`[ab-panel] connecting cdp ${JSON.stringify({ cdpUrl })}`);
      ws = new WebSocket(cdpUrl);
      ws.onopen = () => {
        console.log('[ab-panel] cdp open');
        send('Target.setDiscoverTargets', { discover: true });
        send('Target.getTargets');
        // If get cdp-url ever returns a page websocket instead of the browser
        // websocket, these page-level events are the navigation source.
        send('Page.enable');
      };
      ws.onmessage = (ev) => handleCdpMessage(ev.data);
      ws.onclose = () => { if (!disposed) console.log('[ab-panel] cdp close'); };
      ws.onerror = () => console.log('[ab-panel] cdp error');
    };

    void connect();
    return () => {
      disposed = true;
      ws?.close();
    };
  }, [poppedOut, session, streamPort, applyObservedNavigation]);

  // A persisted panel may restore with a stale wsPort: the agent-browser
  // session is still alive, but the stream server restarted on a new port while
  // VS Code/webview state kept the old one. Once the old socket is proven dead
  // (or no port was persisted), ask the host for the current port and rewrite
  // panel params so the normal WebSocket effect reconnects.
  useEffect(() => {
    if (!session) return;
    // Critical: do NOT query the daemon mid-relaunch. A pop-out/pop-in close+kills
    // the daemon before reopening; querying `stream status` in that window spawns
    // a fresh COMPETING headless daemon on a different port and pins the panel to
    // it — so the panel ends up streaming an about:blank ghost instead of the
    // headed window. The host hands back the authoritative port when it's done.
    if (relaunchingRef.current) return;
    // Once this exact port has opened, a later disconnect is a live stream
    // failure, not a stale persisted port. Do not ask `stream status` here:
    // the CLI can spawn a fresh daemon and reset the session, hiding the real
    // failure and reverting the URL.
    if (streamPort && liveStreamPortRef.current === streamPort) {
      if (connectionLost || status?.connected === false) {
        console.log(`[ab-panel] stream recovery skipped for live port ${JSON.stringify({ session, wsPort: streamPort, connectionLost, connected: status?.connected })}`);
      }
      return;
    }
    if (streamPort && !connectionLost && status?.connected !== false) return;
    const platform = getPlatform();
    if (!platform.agentBrowserStreamStatus) return;
    let cancelled = false;
    platform.agentBrowserStreamStatus(session, binaryPath).then((res) => {
      if (cancelled || !res.ok || !res.wsPort) return;
      setConnectionLost(false);
      setStatus(null);
      if (res.wsPort !== streamPort) {
        setStreamPort(res.wsPort);
        api.updateParameters({ wsPort: res.wsPort });
      } else {
        setStreamRecoverySeq((seq) => seq + 1);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [session, binaryPath, streamPort, connectionLost, status?.connected, api]);

  // --- header: persisted title + browser-chrome (URL / key) ---

  const activeTab = useMemo(() => tabs.find((tab) => tab.active) ?? tabs[0] ?? null, [tabs]);

  // The persisted panel title (door labels, session save) stays the active
  // tab's display title; the live browser-chrome header shows the URL instead
  // (from the snapshot below) and demotes this title to a tooltip.
  useEffect(() => {
    if (activeTab) api.setTitle(tabDisplayTitle(activeTab));
  }, [activeTab, api]);

  // The browser-chrome snapshot the header reads. Recomputed each render and
  // mirrored into a ref so a (re-)registration always seeds the latest; the
  // publish effect below pushes it to subscribers only on real changes.
  const chromeSnapshot: ChromeSnapshot = {
    url: activeTab?.url ?? '',
    displayUrl: activeTab ? hostPathDisplay(activeTab.url) : '',
    title: activeTab?.title ?? null,
    key: params?.key ?? null,
  };
  const chromeSnapshotRef = useRef(chromeSnapshot);
  chromeSnapshotRef.current = chromeSnapshot;
  const currentRelaunchUrl = useCallback(() => {
    return [
      latestRestorableUrlRef.current,
      chromeSnapshotRef.current.url,
      paramsUrlRef.current,
    ].find(isRestorableUrl);
  }, []);

  // Native history nav — `back`/`forward`/`reload` issued like tab actions
  // (allowlisted in agentBrowserCommand). Stable; reads the live closure via
  // the ref so the registered controller never goes stale.
  const chromeActions = useMemo<ChromeActions>(() => ({
    navigate(url) { if (url) runAgentBrowserRef.current(['open', url]); },
    back() { runAgentBrowserRef.current(['back']); },
    forward() { runAgentBrowserRef.current(['forward']); },
    reload() { runAgentBrowserRef.current(['reload']); },
  }), []);

  // --- screen controller: register for the header/modal bridge ---

  // Stable across renders (reads refs / stable setters), so the registered
  // controller never goes stale. Engaging always re-issues (clears lastIssued)
  // so it reclaims the viewport even from an external device.
  // --- Headed Pop-Out: relaunch this session's browser as a native OS window.
  // The pane becomes a stub; the stream stays connected to observe tabs/status
  // and to auto-revert when the window closes. The new Chrome process gets a
  // fresh stream port, which we write into params so the WS reconnects. ---
  const popOut = useCallback(() => {
    const platform = getPlatform();
    if (!session || !platform.agentBrowserPopOut) return;
    if (closeIfSessionMarkedClosed(session)) return;
    headedConnectedRef.current = false;
    relaunchingRef.current = true;
    setPoppedOut(true);
    api.updateParameters({ renderMode: 'ab-popout' });
    // Pop-out failed: revert to in-pane unless the stream came back live anyway.
    const revertUnlessLive = () => reconcileStreamPort().then((live) => {
      relaunchingRef.current = false;
      if (live) return;
      setPoppedOut(false);
      api.updateParameters({ renderMode: 'ab-screencast' });
    });
    // Don't reconcile to the current (headless) port first — it's about to close.
    // Connect to the headed window's fresh port once the relaunch returns it.
    const url = currentRelaunchUrl();
    console.log(`[ab-panel] popOut -> ${JSON.stringify({ session, url })}`);
    platform.agentBrowserPopOut(session, { rect: paneScreenRect(elRef.current), url }, binaryPathRef.current).then((res) => {
      console.log(`[ab-panel] popOut result ${JSON.stringify(res)}`);
      if (closeIfSessionMarkedClosed(session)) return;
      if (!res.ok) {
        void revertUnlessLive();
        return;
      }
      void reconcileStreamPort(res.wsPort);
      relaunchingRef.current = false;
    }).catch((err) => {
      console.log(`[ab-panel] popOut error ${String(err)}`);
      if (closeIfSessionMarkedClosed(session)) return;
      void revertUnlessLive();
    });
  }, [session, api, reconcileStreamPort, closeIfSessionMarkedClosed, currentRelaunchUrl]);

  const popIn = useCallback(() => {
    if (closeIfSessionMarkedClosed(session)) return;
    // Same expected mid-relaunch stream drop as pop-out: suppress screenshot
    // pulses so none relaunches the just-closed browser at about:blank.
    relaunchingRef.current = true;
    setPoppedOut(false);
    api.updateParameters({ renderMode: 'ab-screencast' });
    const platform = getPlatform();
    if (!session || !platform.agentBrowserPopIn) { relaunchingRef.current = false; return; }
    // Don't reconcile to the current (headed) port first — the host is about to
    // kill that daemon. Querying now would spawn a competing daemon (see the
    // recovery-effect note). Connect to the fresh port the host returns.
    const url = currentRelaunchUrl();
    console.log(`[ab-panel] popIn -> ${JSON.stringify({ session, url })}`);
    platform.agentBrowserPopIn(session, { url }, binaryPathRef.current).then((res) => {
      console.log(`[ab-panel] popIn result ${JSON.stringify(res)}`);
      if (closeIfSessionMarkedClosed(session)) { relaunchingRef.current = false; return; }
      if (res.ok) void reconcileStreamPort(res.wsPort);
      else void reconcileStreamPort();
      relaunchingRef.current = false;
    }).catch(() => {
      if (closeIfSessionMarkedClosed(session)) { relaunchingRef.current = false; return; }
      void reconcileStreamPort();
      relaunchingRef.current = false;
    });
  }, [session, api, reconcileStreamPort, closeIfSessionMarkedClosed, currentRelaunchUrl]);

  const bringToFront = useCallback(() => {
    if (!session) return;
    getPlatform().agentBrowserBringToFront?.(session, binaryPathRef.current)?.catch(() => {});
  }, [session]);

  const popOutRef = useRef(popOut);
  popOutRef.current = popOut;
  const popInRef = useRef(popIn);
  popInRef.current = popIn;

  const screenActions = useMemo<ScreenActions>(() => ({
    engageSync() {
      // Clear lastIssued so the issue below isn't skipped, and issue now rather
      // than relying on the syncEngaged effect — re-selecting Sync while already
      // engaged must still reclaim the viewport (e.g. from an external `set`).
      lastIssuedRef.current = null;
      setSyncEngaged(true);
      issueSyncToPane();
    },
    applyDevice(name) {
      lastIssuedRef.current = null;
      setSyncEngaged(false);
      runAgentBrowserRef.current(['set', 'device', name]);
    },
    applyViewport(w, h, dpr) {
      lastIssuedRef.current = null;
      setSyncEngaged(false);
      runAgentBrowserRef.current(['set', 'viewport', String(w), String(h), String(dpr)]);
    },
    openModal() {
      openAgentBrowserScreenModal(api.id);
    },
    setRenderMode(renderMode) {
      // agent-browser → iframe is a render swap handled by the Wall;
      // ab-screencast ↔ ab-popout relaunches this same session, handled in-panel.
      if (renderMode === 'iframe') {
        // The iframe renderer is single-frame: only the active tab survives.
        // Warn + require a typed confirm when other tabs would be closed.
        if (tabsRef.current.length >= 2) setPendingIframeSwap(true);
        else actionsRef.current.onSwapRenderMode(api.id, 'iframe');
      } else if (renderMode === 'ab-popout') popOutRef.current();
      else if (poppedOutRef.current) popInRef.current(); // ab-popout → ab-screencast
    },
  }), [api.id, issueSyncToPane]);

  useEffect(() => {
    const registration = registerAgentBrowserScreen(api.id, {
      snapshot: computeSnapshot(),
      actions: screenActions,
      chrome: chromeSnapshotRef.current,
      chromeActions,
      hostCapable: !!getPlatform().agentBrowserCommand,
      canPopOut: !!getPlatform().agentBrowserPopOut,
    });
    registrationRef.current = registration;
    lastPublishedRef.current = null;
    publishScreen();
    return () => {
      registration.dispose();
      registrationRef.current = null;
    };
  }, [api.id, screenActions, chromeActions, computeSnapshot, publishScreen]);

  // Push browser-chrome changes to the header on a channel separate from the
  // screen snapshot. Gated on the primitive fields so it fires on real
  // tab/status changes, not every frame pulse.
  useEffect(() => {
    registrationRef.current?.updateChrome(chromeSnapshotRef.current);
    // displayUrl is a pure function of url, so url covers it.
  }, [chromeSnapshot.url, chromeSnapshot.title, chromeSnapshot.key]);

  // Mirror the active tab's URL into params so it persists in the layout blob and
  // render-mode swaps / pop-out have a canonical URL even when the live stream is
  // momentarily without an active tab (see dor-iframe.md → Path 1, "url is
  // single-homed"). Non-empty changes only; the write sets params.url === url so
  // it does not re-fire.
  useEffect(() => {
    const url = chromeSnapshot.url;
    // Track the active tab faithfully so url is always the page the user is on —
    // this is the source of truth the relaunch (pop-out/pop-in/auto-revert)
    // reads. Two guards: freeze while a relaunch is in flight (the active tab is
    // momentarily a blank/booting page that must not overwrite the real target),
    // and never record a transient about:blank.
    if (!relaunchingRef.current && isRestorableUrl(url) && url !== paramsUrlRef.current) {
      latestRestorableUrlRef.current = url;
      paramsUrlRef.current = url;
      api.updateParameters({ url });
    }
  }, [chromeSnapshot.url, api]);

  // Push the render-mode flip (screencast ↔ popout) to the header/modal.
  useEffect(() => { publishScreen(); }, [poppedOut, publishScreen]);

  // This surface owns its session again — clear any teardown mark a prior
  // surface (re-using the same managed name) left behind, so auto-revert works.
  useEffect(() => {
    if (session) clearAgentBrowserSessionClosed(session);
  }, [session]);

  // Auto-revert: once the headed stream has connected, a later disconnect means
  // the window closed → relaunch headless and resume streaming (spec → Lifecycle).
  // But a disconnect also happens when Dormouse itself closes the session (pane
  // kill, or a render-swap away from popout); the closed-session mark tells those
  // apart so we don't resurrect a session that's being torn down.
  useEffect(() => {
    if (!poppedOut) { headedConnectedRef.current = false; return; }
    // The expected mid-relaunch drop isn't the window closing — ignore it.
    if (relaunchingRef.current) return;
    if (status?.connected === true) headedConnectedRef.current = true;
    else if (headedConnectedRef.current && (status?.connected === false || connectionLost)) {
      if (sessionRef.current && isAgentBrowserSessionClosed(sessionRef.current)) return;
      popInRef.current();
    }
  }, [poppedOut, status?.connected, connectionLost]);

  // Focus the swap-confirm overlay when it appears so it captures the typed
  // confirm/cancel keys (the pane's key-forwarder skips in-pane targets).
  useEffect(() => {
    if (pendingIframeSwap) swapConfirmRef.current?.focus();
  }, [pendingIframeSwap]);

  // Persist sync state into the panel params so it round-trips through the
  // dockview layout blob (and survives reattach). Skip no-op writes.
  useEffect(() => {
    if (params?.syncEngaged !== syncEngaged) api.updateParameters({ syncEngaged });
  }, [syncEngaged, params?.syncEngaged, api]);

  // Reflect a sync flip in the indicator immediately, without waiting for the
  // next frame.
  useEffect(() => {
    publishScreen();
  }, [syncEngaged, publishScreen]);

  // While sync is engaged, follow the pane: re-issue `set viewport` (debounced)
  // on resize. ResizeObserver fires once on observe, giving the initial sync;
  // the explicit call covers re-engaging at an unchanged size.
  useEffect(() => {
    if (!syncEngaged) return;
    const el = viewportRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        issueSyncToPane();
        publishScreen();
      }, 200);
    });
    observer.observe(el);
    issueSyncToPane();
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [syncEngaged, issueSyncToPane, publishScreen]);

  // A new/restarted session (wsPort change) comes up at agent-browser's native
  // viewport; if sync is engaged, reclaim the pane size. Clearing lastIssued is
  // essential — it otherwise still holds the previous session's pane size and
  // issueSyncToPane would no-op, leaving the fresh browser unsynced (SCALED).
  useEffect(() => {
    if (!streamPort || !syncEngagedRef.current) return;
    lastIssuedRef.current = null;
    issueSyncToPane();
  }, [streamPort, issueSyncToPane]);

  // Display-scale (DPR) changes don't resize the pane, so ResizeObserver misses
  // them; a window resize is the available signal. Recompute the indicator and,
  // if synced, re-issue at the new DPR.
  useEffect(() => {
    const onWindowResize = () => {
      if (syncEngagedRef.current) issueSyncToPane();
      publishScreen();
    };
    window.addEventListener('resize', onWindowResize);
    return () => window.removeEventListener('resize', onWindowResize);
  }, [issueSyncToPane, publishScreen]);

  // --- input forwarding (stream-native input_* messages) ---

  const send = useCallback((payload: Record<string, unknown>) => {
    connectionRef.current?.send(payload);
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
    if (!passthroughRef.current) return;
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
    // Pair with onCanvasMouseDown: gate on passthrough (not full `interactive`)
    // so the release of a first, pane-selecting click still completes the click.
    if (!passthroughRef.current) return;
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
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'v') {
      void readTextFromClipboard().then((text) => {
        if (text) insertText(text);
      });
      return;
    }
    // macOS native editing chords (select-all/copy/cut) don't fire over the
    // stream input path (CDP commands field is dropped). Route the intent
    // through the host's purpose-built edit channel instead. If the host
    // lacks it (e.g. standalone), fall through so the page still gets the
    // chord for its own JS shortcuts.
    if (mod && !e.altKey && !e.shiftKey) {
      const op = EDIT_OPS[e.key.toLowerCase() as keyof typeof EDIT_OPS];
      // Call through the adapter instance — detaching the method drops `this`.
      const platform = getPlatform();
      if (op && platform.agentBrowserEdit && session) {
        platform.agentBrowserEdit(session, op, binaryPath).then((r) => {
          if (!r.ok && r.error) console.warn(`[agent-browser] ${op} failed:`, r.error);
        }).catch((err) => console.warn(`[agent-browser] ${op} failed:`, err));
        return;
      }
    }
    sendKey(e, 'keyDown');
  }, [insertText, sendKey, session, binaryPath]);

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
      // A screen modal (or any dialog) renders outside the pane element, so the
      // contains() check above misses it; without this, typing into the modal's
      // Custom W/H/DPI fields would be swallowed and forwarded to the browser.
      if (e.target instanceof Element && e.target.closest('[role="dialog"]')) return;
      // Likewise never hijack keystrokes destined for an editable field that
      // lives outside the pane — notably the header's URL editor.
      if (isEditableTarget(e.target)) return;
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
    if (!streamPort) return `Waiting for browser session ${session ?? ''} — run dor ab open <url>`;
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
      <div ref={viewportRef} className="relative flex min-h-0 flex-1 items-center justify-center">
        {/* Canvas stays mounted across pop-out (its listeners keep their element)
            — just hidden under the stub while a headed window renders instead. */}
        <canvas
          ref={canvasRef}
          className={clsx('block max-h-full max-w-full select-none', (!hasFrame || poppedOut) && 'hidden')}
          onMouseDown={onCanvasMouseDown}
          onMouseUp={onCanvasMouseUp}
          onMouseMove={onCanvasMouseMove}
          onContextMenu={(e) => {
            if (interactiveRef.current) e.preventDefault();
          }}
        />
        {poppedOut ? (
          // Popped out to a headed OS window — the pane is a clean stub.
          <div className="flex flex-col items-center gap-3 px-4 text-center text-sm text-muted">
            <div>This browser is running in a separate window.</div>
            <div className="flex gap-2 text-xs">
              {getPlatform().agentBrowserBringToFront && (
                <button
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    bringToFront();
                  }}
                  className="rounded border border-border px-2.5 py-1 text-muted transition-colors hover:border-foreground hover:text-foreground"
                >
                  Bring to front
                </button>
              )}
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  popIn();
                }}
                className="rounded border border-border px-2.5 py-1 text-muted transition-colors hover:border-foreground hover:text-foreground"
              >
                Pop back in
              </button>
            </div>
          </div>
        ) : placeholder ? (
          <div className="px-4 text-center text-sm text-muted">{placeholder}</div>
        ) : null}
        {pendingIframeSwap && (
          <div
            ref={swapConfirmRef}
            tabIndex={-1}
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-terminal-bg/95 px-6 text-center outline-none"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'c' || e.key === 'C') {
                setPendingIframeSwap(false);
                actions.onSwapRenderMode(api.id, 'iframe');
              } else if (e.key === 'Escape') {
                setPendingIframeSwap(false);
              }
            }}
          >
            <div className="max-w-sm text-sm text-foreground">
              Switching to the iframe renderer keeps only the active tab.{' '}
              <span className="font-semibold">{Math.max(0, tabs.length - 1)} other tab{tabs.length - 1 === 1 ? '' : 's'}</span> will be closed.
            </div>
            <div className="text-xs text-muted">
              Press <kbd className="rounded bg-app-bg px-1 py-0.5 font-mono">c</kbd> to continue · <kbd className="rounded bg-app-bg px-1 py-0.5 font-mono">Esc</kbd> to cancel
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
