/**
 * Wall-side driver for the dev-server connection chip
 * (docs/specs/dor-agent-browser.md → "Dev-server connection").
 *
 * A browser-surface header can't see other panes' open ports, so it registers
 * the loopback port it's showing in the shared store (`useDevServerMatch`) and
 * the Wall resolves it here: scan every terminal pane's listening ports
 * (`getOpenPorts`), find the single pane serving that port, and publish back
 * `{ paneId, label }`.
 *
 * This is **purely decorative and strictly off the hot path.** `getOpenPorts`
 * shells out (per-OS `lsof`/PowerShell) on the host that also drives the live
 * screencast, so a scan triggered the instant a tab opens would contend with
 * that tab's first screenshots. So resolution is:
 *   - **deferred & debounced** — a loopback URL appearing schedules a scan a
 *     beat later, coalescing rapid navigation, so tab-open finishes first;
 *   - **idle-scheduled** — the scan runs in `requestIdleCallback` time (with a
 *     timeout fallback), yielding to rendering and the screencast;
 *   - **adaptively paced** — it polls only while a loopback port is on screen,
 *     quickly while a port is still unmatched (a dev server may start after the
 *     tab), then backs off to a slow refresh once matched, and stops entirely
 *     when nothing is wanted.
 * At most one scan is in flight (`running`), and `getOpenPorts`' own ~3s timeout
 * keeps a stuck pane from wedging the loop.
 */
import { useEffect } from 'react';
import type { DockviewApi } from 'dockview-react';
import { getPlatform } from '../../lib/platform';
import { getActivitySnapshot, getTerminalPaneStateSnapshot } from '../../lib/terminal-registry';
import { buildAppTitleResolver, deriveHeader, resolveDisplayPrimary } from '../../lib/terminal-state';
import {
  getDevServerResolution,
  getWantedDevServerPorts,
  setDevServerResolution,
  subscribeWantedDevServerPorts,
  type DevServerMatch,
} from './agent-browser-ports';
import type { DooredItem } from './wall-types';

// Wait this long after interest changes before scanning, so a tab's open +
// initial screencast settle first and quick navigation coalesces into one scan.
const DEBOUNCE_MS = 600;
// Re-scan cadence while a wanted port has no match yet (server may be starting).
const PENDING_REFRESH_MS = 4000;
// Re-scan cadence once every wanted port is matched (servers rarely move).
const MATCHED_REFRESH_MS = 15000;
// Upper bound on how long the idle scan may be deferred before it's forced.
const IDLE_TIMEOUT_MS = 2000;

type ResolveOutcome = 'busy' | 'empty' | 'pending' | 'matched';

function isTerminalParams(params: unknown): boolean {
  if (!params || typeof params !== 'object') return true;
  const surfaceType = (params as { surfaceType?: unknown }).surfaceType;
  return surfaceType !== 'iframe' && surfaceType !== 'agent-browser';
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
  apiRef,
  doorsRef,
}: {
  apiRef: React.MutableRefObject<DockviewApi | null>;
  doorsRef: React.MutableRefObject<DooredItem[]>;
}): void {
  useEffect(() => {
    let cancelled = false;
    let running = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let idleHandle: number | undefined;

    // Concise pane label (e.g. `pnpm dev`), mirroring buildDorSurfaces; falls
    // back to the panel/door title. Works for visible panes and minimized doors
    // alike (both keep their pty + terminal state).
    const labelForPane = (id: string, fallbackTitle: string | null): string => {
      const states = getTerminalPaneStateSnapshot();
      const state = states.get(id);
      if (state) {
        const appTitleForPane = buildAppTitleResolver(states, getActivitySnapshot());
        const derived = deriveHeader(state, [state], { appTitleForPane });
        const primary = resolveDisplayPrimary(derived.primary, fallbackTitle);
        if (primary && primary !== '<idle>') return primary;
      }
      return fallbackTitle?.trim() || 'terminal';
    };

    const resolveOnce = async (): Promise<ResolveOutcome> => {
      if (cancelled || running) return 'busy';
      const ports = getWantedDevServerPorts();
      if (ports.length === 0) return 'empty';

      const platform = getPlatform();
      if (!platform.getOpenPorts) {
        // No port enumeration on this host (e.g. Tauri today): nothing will ever
        // match, so settle to "no match" and pace as matched (no fast polling).
        for (const port of ports) setDevServerResolution(port, null);
        return 'matched';
      }

      running = true;
      try {
        const api = apiRef.current;
        const doors = doorsRef.current;
        // title lookups for labelling/fallback, keyed by surface id.
        const titles = new Map<string, string | null>();
        const candidates: string[] = [];
        for (const panel of api?.panels ?? []) {
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

        // Resolve only what's still wanted — interest can churn during the await.
        const stillWanted = getWantedDevServerPorts();
        for (const port of stillWanted) {
          const list = owners.get(port) ?? [];
          // Exactly one owner ⇒ confident match. Zero (no pane) or two+
          // (ambiguous) ⇒ no match; the header degrades to just the URL.
          const match: DevServerMatch | null = list.length === 1
            ? { paneId: list[0], label: labelForPane(list[0], titles.get(list[0]) ?? null) }
            : null;
          setDevServerResolution(port, match);
        }

        if (stillWanted.length === 0) return 'empty';
        // "pending" while any wanted port is still unmatched, so we keep looking
        // (the server may not have started when the tab opened).
        return stillWanted.every((port) => getDevServerResolution(port) != null) ? 'matched' : 'pending';
      } finally {
        running = false;
      }
    };

    const scheduleRefresh = (delay: number) => {
      if (cancelled) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => scheduleScan(0), delay);
    };

    // Run a scan during idle time, then pace the next one by the outcome.
    const runIdleScan = () => {
      idleHandle = scheduleIdle(() => {
        idleHandle = undefined;
        void resolveOnce().then((outcome) => {
          if (cancelled || outcome === 'busy') return; // an in-flight scan paces itself
          if (outcome === 'empty') return;             // nothing wanted → wait for new interest
          scheduleRefresh(outcome === 'pending' ? PENDING_REFRESH_MS : MATCHED_REFRESH_MS);
        });
      });
    };

    // Coalesce triggers: debounce, then scan at idle. Never scans synchronously
    // on the triggering event (tab open / navigation).
    const scheduleScan = (delay: number) => {
      if (cancelled) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      cancelIdle(idleHandle);
      idleHandle = undefined;
      debounceTimer = setTimeout(runIdleScan, delay);
    };

    // A header showing a new loopback URL bumps "wanted"; debounce + defer so the
    // scan lands after the tab is up, not during its first paints.
    const unsubscribe = subscribeWantedDevServerPorts(() => scheduleScan(DEBOUNCE_MS));
    scheduleScan(DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      cancelIdle(idleHandle);
      unsubscribe();
    };
  }, [apiRef, doorsRef]);
}
