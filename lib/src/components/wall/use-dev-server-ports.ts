/**
 * Wall-side driver for the dev-server connection chip
 * (docs/specs/dor-browser.md → "Dev-Server Chip").
 *
 * A browser-surface header can't see other panes' open ports, so it registers
 * the loopback port it's showing in the shared store (`useDevServerMatch`) and
 * the Wall resolves it here: scan every terminal pane's listening ports
 * (`getOpenPorts`), find the single pane serving that port, and publish back
 * `{ paneId, label }`.
 *
 * This is **purely decorative and strictly off the hot path.** `getOpenPorts`
 * shells out (per-OS `lsof`/PowerShell) on the host that also drives the live
 * screencast, so scans must never pile onto tab-open or run on a timer forever:
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
import { getActivitySnapshot, getTerminalPaneStateSnapshot } from '../../lib/terminal-registry';
import { buildAppTitleResolver, deriveSurfaceLabel, DEFAULT_IDLE_TITLE } from '../../lib/terminal-state';
import {
  getWantedDevServerPorts,
  setDevServerResolution,
  subscribeDevServerRescan,
  subscribeWantedDevServerPorts,
} from './agent-browser-ports';
import type { DooredItem, VisiblePane } from './wall-types';
import { isBrowserParams } from './browser-surface';

// Wait this long after interest changes before scanning, so a tab's open +
// initial screencast settle first and quick navigation coalesces into one scan.
const DEBOUNCE_MS = 600;
// Re-scan cadence while a wanted port has no match yet (server may be starting).
// Once matched, a port is settled and not rescanned until reload/navigation.
const PENDING_REFRESH_MS = 4000;
// Upper bound on how long the idle scan may be deferred before it's forced.
const IDLE_TIMEOUT_MS = 2000;

type ResolveOutcome = 'busy' | 'idle' | 'pending';

function isTerminalParams(params: unknown): boolean {
  return !isBrowserParams(params);
}

function isTerminalDoor(door: DooredItem): boolean {
  return (door.component ?? 'terminal') === 'terminal';
}

// A process bound here answers `localhost:<port>`: loopback (127.0.0.1 / ::1)
// or any-interface (0.0.0.0 / ::). A process bound to one specific non-loopback
// interface is excluded — it isn't reachable as localhost.
function servesLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '0.0.0.0' || address === '::';
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

export function useDevServerPortCorrelation({
  listVisiblePanes,
  doorsRef,
}: {
  listVisiblePanes: () => VisiblePane[];
  doorsRef: React.MutableRefObject<DooredItem[]>;
}): void {
  useEffect(() => {
    let cancelled = false;
    let running = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let idleHandle: number | undefined;
    // Ports already matched to a pane. We don't rescan these until a reload
    // (clears the whole set) or the port leaves "wanted" (navigation).
    const settled = new Set<number>();

    // Concise pane label (e.g. `pnpm dev`), mirroring buildDorSurfaces; falls
    // back to the panel/door title. Works for visible panes and minimized doors
    // alike (both keep their pty + terminal state).
    const labelForPane = (id: string, fallbackTitle: string | null): string => {
      const states = getTerminalPaneStateSnapshot();
      const state = states.get(id);
      if (state) {
        const appTitleForPane = buildAppTitleResolver(states, getActivitySnapshot());
        const primary = deriveSurfaceLabel(state, [state], appTitleForPane, fallbackTitle);
        if (primary && primary !== DEFAULT_IDLE_TITLE) return primary;
      }
      return fallbackTitle?.trim() || 'terminal';
    };

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
        // No port enumeration on this host (e.g. Tauri today): nothing will ever
        // match, so settle to "no match" and stop (don't poll).
        for (const port of unsettled) setDevServerResolution(port, null);
        return 'idle';
      }

      running = true;
      try {
        const doors = doorsRef.current;
        // title lookups for labelling/fallback, keyed by surface id.
        const titles = new Map<string, string | null>();
        const candidates: string[] = [];
        for (const panel of listVisiblePanes()) {
          if (!isTerminalParams(panel.params)) continue;
          candidates.push(panel.id);
          titles.set(panel.id, panel.title ?? null);
        }
        for (const door of doors) {
          if (!isTerminalDoor(door)) continue;
          if (!candidates.includes(door.id)) candidates.push(door.id);
          titles.set(door.id, door.title ?? null);
        }

        // port → the pane ids that listen on it (loopback-reachable binds only).
        const owners = new Map<number, string[]>();
        await Promise.all(candidates.map(async (id) => {
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
            setDevServerResolution(port, { paneId: list[0], label: labelForPane(list[0], titles.get(list[0]) ?? null) });
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
    };
  }, [listVisiblePanes, doorsRef]);
}
