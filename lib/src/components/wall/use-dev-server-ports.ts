/**
 * Dev-server connection chip driver
 * (docs/specs/dor-browser.md → "Dev-Server Chip").
 *
 * A browser-surface header can't see other panes' open ports, so it registers
 * the loopback port it's showing in the shared store (`useDevServerMatch`) and
 * this module resolves it: scan every terminal Surface's listening ports
 * (`getOpenPorts`), find the single one serving that port, and publish back
 * `{ paneId, label }`.
 *
 * **One loop per WINDOW, over every mounted Wall's Surfaces.** The wanted-port
 * store and the resolutions are window-wide, so a per-Wall loop would answer
 * another Workspace's port with "no match", clobber the owner's resolution, and
 * never settle — polling `lsof` forever. Each Wall registers its Surfaces as a
 * candidate source instead, and the loop is reference-counted so a lone Wall
 * still runs exactly one.
 *
 * The scan is **purely decorative and strictly off the hot path.**
 * `getOpenPorts` shells out (per-OS `lsof`/PowerShell) on the host that also
 * drives the live screencast, so scans must never pile onto tab-open or run on a
 * timer forever:
 *   - **deferred & debounced** — a loopback URL appearing schedules a scan a
 *     beat later, coalescing rapid navigation, so tab-open finishes first;
 *   - **idle-scheduled** — the scan runs in `requestIdleCallback` time (with a
 *     timeout fallback), yielding to rendering and the screencast;
 *   - **scan once, then settle** — a matched port is remembered and never
 *     rescanned; we only keep polling (slowly, at idle) while a wanted port is
 *     still *unmatched* (a dev server may start after the tab opened);
 *   - **re-validate on reload** — a surface reload (or navigating to a new
 *     loopback port) un-settles and rescans, but optimistically: the current
 *     chip stays until the rescan disagrees.
 * At most one scan is in flight (`running`), and `getOpenPorts`' own ~3s timeout
 * keeps a stuck pane from wedging the loop.
 */
import { useEffect } from 'react';
import { getPlatform } from '../../lib/platform';
import { createRefCount } from '../../lib/ref-count';
import { deriveSessionLabel } from '../../lib/session-label';
import {
  getWantedDevServerPorts,
  setDevServerResolution,
  subscribeDevServerRescan,
  subscribeWantedDevServerPorts,
} from './agent-browser-ports';
import type { DooredItem } from './wall-types';
import type { LathWallEngine } from './lath-wall-engine';
import { surfaceKindFromParams } from './browser-surface';
import { hasTerminal } from 'dor/commands/types';
import { servesLoopback } from './port-url';

// Wait this long after interest changes before scanning, so a tab's open +
// initial screencast settle first and quick navigation coalesces into one scan.
const DEBOUNCE_MS = 600;
// Re-scan cadence while a wanted port has no match yet (server may be starting).
// Once matched, a port is settled and not rescanned until reload/navigation.
const PENDING_REFRESH_MS = 4000;
// Upper bound on how long the idle scan may be deferred before it's forced.
const IDLE_TIMEOUT_MS = 2000;

type ResolveOutcome = 'busy' | 'idle' | 'pending';

/** One Wall's terminal Surfaces, with the titles the label falls back on. */
type CandidateSource = () => Array<{ id: string; title: string | null }>;

// Port scans are terminal-gated (`docs/specs/glossary.md` → Panes and Surfaces).
function isTerminalParams(params: unknown): boolean {
  return hasTerminal(surfaceKindFromParams(params));
}

// requestIdleCallback isn't universal (absent in WKWebView / Tauri on macOS),
// so fall back to a short timer. Handles are plain numbers in both paths.
function scheduleIdle(cb: () => void): number {
  if (typeof requestIdleCallback === 'function') {
    return requestIdleCallback(cb, { timeout: IDLE_TIMEOUT_MS }) as unknown as number;
  }
  return setTimeout(cb, 1) as unknown as number;
}

function cancelIdle(handle: number | undefined): void {
  if (handle == null) return;
  if (typeof cancelIdleCallback === 'function') cancelIdleCallback(handle);
  else clearTimeout(handle);
}

const sources = new Set<CandidateSource>();
let stopLoop: (() => void) | null = null;
let scheduleScanNow: ((delay: number) => void) | null = null;

/** Ports already matched to a Surface. Not rescanned until a reload (clears the
 *  whole set), the port leaves "wanted" (navigation), or the set of Walls
 *  changes — a Wall arriving or leaving can change who owns a port. */
const settled = new Set<number>();

/** A Wall arriving or leaving changes who can own a port, so re-validate:
 *  a resolution settled without it may now be ambiguous, or newly resolvable. */
const acquireLoop = createRefCount({
  onFirst: () => {
    stopLoop = startCorrelationLoop();
    return () => { stopLoop?.(); stopLoop = null; };
  },
  onChange: () => {
    settled.clear();
    scheduleScanNow?.(DEBOUNCE_MS);
  },
});

/** id → fallback title across every mounted Wall; the first Wall to claim an id
 *  owns it, and a Wall only ever lists its own Surfaces. */
function collectCandidates(): Map<string, string | null> {
  const byId = new Map<string, string | null>();
  for (const source of sources) {
    for (const candidate of source()) {
      if (!byId.has(candidate.id)) byId.set(candidate.id, candidate.title);
    }
  }
  return byId;
}

function startCorrelationLoop(): () => void {
  let cancelled = false;
  let running = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let idleHandle: number | undefined;

  const resolveOnce = async (): Promise<ResolveOutcome> => {
    if (cancelled || running) return 'busy';

    const wanted = getWantedDevServerPorts();
    // Drop settled ports that are no longer on screen (navigated away).
    for (const port of [...settled]) {
      if (!wanted.includes(port)) settled.delete(port);
    }
    if (wanted.length === 0) return 'idle';

    // Only chase ports we haven't matched yet — matched ones stay put.
    const unsettled = wanted.filter((port) => !settled.has(port));
    if (unsettled.length === 0) return 'idle';

    const platform = getPlatform();
    if (!platform.getOpenPorts) {
      // No port enumeration on this host: nothing will ever match, so settle
      // to "no match" and stop (don't poll).
      for (const port of unsettled) setDevServerResolution(port, null);
      return 'idle';
    }

    running = true;
    try {
      const titles = collectCandidates();

      // port → the surface ids that listen on it (loopback-reachable binds only).
      const owners = new Map<number, string[]>();
      await Promise.all([...titles.keys()].map(async (id) => {
        let open;
        try {
          open = await platform.getOpenPorts!(id);
        } catch {
          return;
        }
        for (const entry of open) {
          if (entry.protocol !== 'tcp' || !servesLoopback(entry.address)) continue;
          const list = owners.get(entry.port) ?? [];
          if (!list.includes(id)) list.push(id);
          owners.set(entry.port, list);
        }
      }));
      if (cancelled) return 'busy';

      // Resolve only what's still wanted + unsettled — interest can churn
      // during the await.
      const stillWanted = new Set(getWantedDevServerPorts());
      for (const port of unsettled) {
        if (!stillWanted.has(port)) continue;
        const list = owners.get(port) ?? [];
        // Exactly one owner ⇒ confident match; settle it. Zero (no pane) or
        // two+ (ambiguous) ⇒ no match; leave it unsettled so we keep looking
        // (e.g. the dev server is still starting up).
        if (list.length === 1) {
          settled.add(port);
          setDevServerResolution(port, { paneId: list[0], label: deriveSessionLabel(list[0], titles.get(list[0]) ?? null) });
        } else {
          setDevServerResolution(port, null);
        }
      }

      const remaining = getWantedDevServerPorts().some((port) => !settled.has(port));
      return remaining ? 'pending' : 'idle';
    } finally {
      running = false;
    }
  };

  const scheduleRefresh = (delay: number) => {
    if (cancelled) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => scheduleScan(0), delay);
  };

  // Run a scan during idle time; keep polling only while ports are unmatched.
  const runIdleScan = () => {
    idleHandle = scheduleIdle(() => {
      idleHandle = undefined;
      void resolveOnce().then((outcome) => {
        if (cancelled) return;
        // 'busy' → an in-flight scan paces itself; 'idle' → all matched (or
        // nothing wanted) so stop until reload/navigation wakes us.
        if (outcome === 'pending') scheduleRefresh(PENDING_REFRESH_MS);
      });
    });
  };

  // Coalesce triggers: debounce, then scan at idle. Never scans synchronously
  // on the triggering event (tab open / navigation / reload).
  const scheduleScan = (delay: number) => {
    if (cancelled) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    cancelIdle(idleHandle);
    idleHandle = undefined;
    debounceTimer = setTimeout(runIdleScan, delay);
  };
  scheduleScanNow = scheduleScan;

  // A header showing a new loopback URL bumps "wanted"; debounce + defer so the
  // scan lands after the tab is up, not during its first paints.
  const unsubscribeWanted = subscribeWantedDevServerPorts(() => scheduleScan(DEBOUNCE_MS));
  // A reload un-settles every port and re-validates — optimistically, since we
  // leave the published resolutions in place until the rescan overwrites them.
  const unsubscribeRescan = subscribeDevServerRescan(() => {
    settled.clear();
    scheduleScan(DEBOUNCE_MS);
  });
  scheduleScan(DEBOUNCE_MS);

  return () => {
    cancelled = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (refreshTimer) clearTimeout(refreshTimer);
    cancelIdle(idleHandle);
    unsubscribeWanted();
    unsubscribeRescan();
    settled.clear();
    scheduleScanNow = null;
  };
}

export function useDevServerPortCorrelation({
  lath,
  doorsRef,
}: {
  /** The Lath engine — source of the visible-pane projection (`lath.listPanes()`). */
  lath: LathWallEngine;
  doorsRef: React.MutableRefObject<DooredItem[]>;
}): void {
  useEffect(() => {
    const source: CandidateSource = () => {
      const candidates: Array<{ id: string; title: string | null }> = [];
      for (const panel of lath.listPanes()) {
        if (!isTerminalParams(panel.params)) continue;
        candidates.push({ id: panel.id, title: panel.title ?? null });
      }
      // A Door's component/title live in the store, which stays their authority
      // while the Surface is minimized.
      for (const door of doorsRef.current) {
        const meta = lath.getMeta(door.id);
        if ((meta?.component ?? 'terminal') !== 'terminal') continue;
        if (candidates.some((candidate) => candidate.id === door.id)) continue;
        candidates.push({ id: door.id, title: meta?.title ?? null });
      }
      return candidates;
    };

    sources.add(source);
    const release = acquireLoop();

    return () => {
      sources.delete(source);
      release();
    };
  }, [lath, doorsRef]);
}
