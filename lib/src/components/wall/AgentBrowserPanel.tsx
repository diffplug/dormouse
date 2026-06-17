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
import {
  openAgentBrowserScreenModal,
  registerAgentBrowserScreen,
  type ChromeActions,
  type ChromeSnapshot,
  type ScreenActions,
  type ScreenRegistration,
  type ScreenSnapshot,
  type ScreenState,
} from './agent-browser-screen';
import { hostPathDisplay } from './browser-url';
import {
  EDIT_OPS,
  MOUSE_BUTTONS,
  MOUSE_BUTTON_MASKS,
  SPECIAL_KEYS,
  modifiers,
  virtualKeyCode,
} from './agent-browser-input';
import { createScreenshotLoop } from './agent-browser-screenshot-loop';
import { usePaneChrome } from './use-pane-chrome';
import {
  ModeContext,
  SelectedIdContext,
  WallActionsContext,
} from './wall-context';

type AgentBrowserPanelParams = {
  surfaceType?: string;
  session?: string;
  key?: string;
  wsPort?: number;
  binaryPath?: string;
  /** Whether sync-to-pane is engaged; persists via the dockview layout blob so
   *  a re-attached surface re-engages sync if it was engaged. Absent on a fresh
   *  surface ⇒ auto-engage (see docs/specs/dor-agent-browser.md). */
  syncEngaged?: boolean;
};

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

// Stream messages above this size are frames (a base64 JPEG — ~150–220 KB at
// desktop sizes); `status`/`tabs` are well under 16 KB. We display screenshots,
// not frames, so a frame's payload is discarded — there's no point paying
// JSON.parse + a throwaway allocation for it (measured ~13 MB/s at 1080p/60fps
// on an animating page). We pulse on the raw message and read the viewport from
// the small `status` messages instead. Smaller messages still get parsed, so a
// rare tiny-viewport frame falling under the cutoff still pulses correctly.
const FRAME_PULSE_THRESHOLD = 16384;

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

function tabDisplayTitle(tab: StreamTab): string {
  const title = tab.title?.trim();
  if (title) return title;
  return hostPathDisplay(tab.url) || 'untitled';
}

// Decode a base64 screencast frame to an ImageBitmap (the fallback display path
// for hosts that can't screenshot). Callers apply their own freshness guard.
function decodeScreencastFrame(dataBase64: string): Promise<ImageBitmap> {
  const bytes = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
}

export function AgentBrowserPanel({ api, params }: IDockviewPanelProps<AgentBrowserPanelParams>) {
  const actions = useContext(WallActionsContext);
  const mode = useContext(ModeContext);
  const selectedId = useContext(SelectedIdContext);
  const elRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  usePaneChrome(api, elRef);

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

  const screenshotLoop = useMemo(() => createScreenshotLoop({
    getSession: () => sessionRef.current,
    getBinaryPath: () => binaryPathRef.current,
    isCapable: () => screenshotCapableRef.current,
    draw: drawBitmap,
  }), [drawBitmap]);

  useEffect(() => () => screenshotLoop.dispose(), [screenshotLoop]);

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
    return { state, viewport, paneCss, displayDpr, syncEngaged: syncEngagedRef.current };
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
      !dimsMatch(prev.paneCss, next.paneCss);
    if (changed) {
      lastPublishedRef.current = next;
      registrationRef.current?.update(next);
    }
  }, [computeSnapshot]);

  // Push the current pane size to the browser as a native `set viewport`.
  const issueSyncToPane = useCallback(() => {
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
    if (!wsPort) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    knownTabIdsRef.current = new Set();

    // Fallback only (hosts without the screenshot capability, e.g. Tauri):
    // render the CSS-resolution screencast frame directly.
    const drawScreencastFrame = (data: string) => {
      const seq = ++frameSeqRef.current;
      decodeScreencastFrame(data).then((bitmap) => {
        // JPEG decodes are async; drop frames that finished out of order.
        if (disposed || seq !== frameSeqRef.current) {
          bitmap.close();
          return;
        }
        drawBitmap(bitmap);
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
        // The frame carries the browser's live viewport; update it, reconcile
        // sync, and refresh the indicator (publishScreen self-gates). Then use
        // the frame as a "page changed" pulse to grab a crisp screenshot — or,
        // where the host can't screenshot, render the frame itself.
        if (msg.metadata?.deviceWidth && msg.metadata?.deviceHeight) {
          deviceRef.current = { width: msg.metadata.deviceWidth, height: msg.metadata.deviceHeight };
        }
        maybeDisengageSync();
        publishScreen();
        if (screenshotCapableRef.current) screenshotLoop.pulse();
        else drawScreencastFrame(msg.data);
      } else if (msg.type === 'status') {
        setStatus({ connected: msg.connected === true, screencasting: msg.screencasting === true });
        setConnectionLost(msg.connected === false);
        if (typeof msg.viewportWidth === 'number' && typeof msg.viewportHeight === 'number') {
          deviceRef.current = { width: msg.viewportWidth, height: msg.viewportHeight };
          maybeDisengageSync();
          publishScreen();
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
      ws.onmessage = (ev) => {
        // Fast-path discarded frames: any large message is a screencast frame
        // whose pixels we don't display, so pulse without parsing the payload.
        const data = ev.data;
        if (screenshotCapableRef.current && typeof data === 'string' && data.length > FRAME_PULSE_THRESHOLD) {
          screenshotLoop.pulse();
          return;
        }
        handleMessage(data);
      };
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
  }, [wsPort, runAgentBrowser, maybeDisengageSync, publishScreen, screenshotLoop, drawBitmap]);

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
  }), [api.id, issueSyncToPane]);

  useEffect(() => {
    const registration = registerAgentBrowserScreen(api.id, {
      snapshot: computeSnapshot(),
      actions: screenActions,
      chrome: chromeSnapshotRef.current,
      chromeActions,
      hostCapable: !!getPlatform().agentBrowserCommand,
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
  }, [chromeSnapshot.url, chromeSnapshot.displayUrl, chromeSnapshot.title, chromeSnapshot.key]);

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
    if (!wsPort || !syncEngagedRef.current) return;
    lastIssuedRef.current = null;
    issueSyncToPane();
  }, [wsPort, issueSyncToPane]);

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
      if (e.target instanceof HTMLElement &&
        (e.target.isContentEditable || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
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
      <div ref={viewportRef} className="relative flex min-h-0 flex-1 items-center justify-center">
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
