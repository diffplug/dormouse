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
 * Cost control (per the spec): only runs while at least one loopback port is
 * wanted, resolves promptly when new interest appears, and otherwise refreshes
 * on a slow interval. `getOpenPorts` has a ~3s timeout, so a stuck pane can't
 * wedge the loop — `runningRef` keeps at most one sweep in flight.
 */
import { useEffect } from 'react';
import type { DockviewApi } from 'dockview-react';
import { getPlatform } from '../../lib/platform';
import { getActivitySnapshot, getTerminalPaneStateSnapshot } from '../../lib/terminal-registry';
import { buildAppTitleResolver, deriveHeader, resolveDisplayPrimary } from '../../lib/terminal-state';
import {
  getWantedDevServerPorts,
  setDevServerResolution,
  subscribeWantedDevServerPorts,
  type DevServerMatch,
} from './agent-browser-ports';
import type { DooredItem } from './wall-types';

const REFRESH_MS = 5000;

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
    let timer: ReturnType<typeof setTimeout> | undefined;

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

    const resolveOnce = async () => {
      if (cancelled || running) return;
      const ports = getWantedDevServerPorts();
      if (ports.length === 0) return;

      const platform = getPlatform();
      if (!platform.getOpenPorts) {
        for (const port of ports) setDevServerResolution(port, null);
        return;
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
        if (cancelled) return;

        // Resolve only what's still wanted — interest can churn during the await.
        const stillWanted = new Set(getWantedDevServerPorts());
        for (const port of ports) {
          if (!stillWanted.has(port)) continue;
          const list = owners.get(port) ?? [];
          // Exactly one owner ⇒ confident match. Zero (no pane) or two+
          // (ambiguous) ⇒ no match; the header degrades to just the URL.
          const match: DevServerMatch | null = list.length === 1
            ? { paneId: list[0], label: labelForPane(list[0], titles.get(list[0]) ?? null) }
            : null;
          setDevServerResolution(port, match);
        }
      } finally {
        running = false;
      }
    };

    const tick = async () => {
      await resolveOnce();
      if (!cancelled) timer = setTimeout(() => void tick(), REFRESH_MS);
    };

    // New interest (a header just showed a loopback URL) resolves promptly
    // rather than waiting out the slow refresh.
    const unsubscribe = subscribeWantedDevServerPorts(() => {
      if (!cancelled) void resolveOnce();
    });
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [apiRef, doorsRef]);
}
