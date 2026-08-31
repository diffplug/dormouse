/**
 * The serving trigger: a tool Surface grows a browser in place once its command
 * binds a port (`docs/specs/dor-tool.md` -> Serving).
 *
 * Only tool-designated Sessions are scanned. An ordinary terminal that opens a
 * port never transforms — that is the Dev-Server Chip's job, and panes must not
 * flip under the user (`docs/specs/dor-tool.md` -> Security).
 */
import { useEffect, useRef } from 'react';
import { getPlatform } from '../../lib/platform';
import { getTerminalPaneState } from '../../lib/terminal-registry';
import {
  browserUrlFromParams,
  isToolParams,
  namespacedToolKey,
  toolKeysEqual,
  toolPortConflictFromParams,
} from './browser-surface';
import { attachAgentBrowserSession } from './connect-port';
import { listenerUrlsByPort } from './port-url';
import { getToolAnnounce } from '../../lib/tool-announce-store';
import { sessionForKey } from 'dor-lib-common/agent-browser';
import type { LathWallEngine } from './lath-wall-engine';
import type { DooredItem } from './wall-types';

// A serving command usually binds within a second or two of starting, but a
// cold `pnpm` boot can take much longer, so this keeps polling for as long as
// the command runs. The scan shells out per Surface (lsof / PowerShell), so the
// cadence is deliberately slow and only tools without a URL are scanned.
const POLL_MS = 1500;

type ToolLeaf = { id: string; params: Record<string, unknown> | undefined };

/** The registered name a tool was spawned under; null for `dor tool -- <cmd>`. */
function toolNameFromParams(params: Record<string, unknown> | undefined): string | null {
  const name = params?.toolName;
  return typeof name === 'string' ? name : null;
}

function toolLeaves(lath: LathWallEngine, doors: DooredItem[]): ToolLeaf[] {
  const leaves: ToolLeaf[] = [];
  for (const pane of lath.listPanes()) {
    if (isToolParams(pane.params)) leaves.push({ id: pane.id, params: pane.params });
  }
  for (const door of doors) {
    const params = lath.getMeta(door.id)?.params;
    if (isToolParams(params)) leaves.push({ id: door.id, params });
  }
  return leaves;
}

export function useToolServing({
  lath,
  doorsRef,
}: {
  lath: LathWallEngine;
  doorsRef: React.MutableRefObject<DooredItem[]>;
}): void {
  // Ports seen on the previous tick, per leaf — the settle check's memory.
  // A ref, not state: it drives no render, and a leaf's entry is dropped when
  // its command exits so a re-run settles again from scratch.
  const seenPorts = useRef<Map<string, number[]>>(new Map());

  useEffect(() => {
    const platform = getPlatform();
    if (!platform.getOpenPorts) return;
    let cancelled = false;

    const tick = async () => {
      const leaves = toolLeaves(lath, doorsRef.current);
      // A killed tool never reaches the exit branch below, so prune by absence.
      const live = new Set(leaves.map((leaf) => leaf.id));
      for (const id of seenPorts.current.keys()) {
        if (!live.has(id)) seenPorts.current.delete(id);
      }

      for (const leaf of leaves) {
        if (cancelled) return;
        const announce = getToolAnnounce(leaf.id);

        // A runtime re-key re-labels this Surface and nothing else — it never
        // dedupes (docs/specs/dor-tool.md -> Identity and dedupe). The
        // namespace that keeps process output from claiming another tool's key
        // is `namespacedToolKey`'s job; see its doc comment.
        const announcedKey = namespacedToolKey(toolNameFromParams(leaf.params), announce?.key ?? null);
        if (announcedKey && !toolKeysEqual(leaf.params?.toolKey, announcedKey)) {
          lath.store.updateParams(leaf.id, { toolKey: announcedKey });
        }

        const hasUrl = browserUrlFromParams(leaf.params) !== null;
        const hasConflict = toolPortConflictFromParams(leaf.params) !== null;
        const running = getTerminalPaneState(leaf.id).currentCommand !== null;

        // Command exit retires the browser and the pane flips back to a prompt
        // above the tool's dying words. Re-running revives it on the same
        // Surface, because the params, not the id, changed. A conflict is
        // derived the same way and retires with it, so a re-run gets a fresh
        // verdict rather than the last run's.
        // Drop the settle memory on *any* exit, not only one that committed: a
        // command that died mid-settle would otherwise leave its port list
        // behind, and the next run's first tick would compare equal to it and
        // commit immediately — framing whichever port bound earliest, which is
        // the regression the settle window exists to prevent.
        if (!running) seenPorts.current.delete(leaf.id);

        if ((hasUrl || hasConflict) && !running) {
          lath.store.updateParams(leaf.id, {
            url: undefined,
            showTerminal: undefined,
            toolPortConflict: undefined,
          });
          continue;
        }
        // A conflict is a verdict about *guessing*, not a final state: the
        // announcement always wins, so a tool that names its port after autobind
        // has already refused must still be framed. Without the second clause
        // the pane would show the conflict for the life of the command, telling
        // the user to announce a port it had just announced.
        // An announcement outranks whatever autobind decided, framed or
        // refused: OSC 367 `serve` is re-emittable and last-write-wins, so a
        // tool that moves its port must be able to re-point the pane.
        const announcedPort = announce?.port ?? null;
        const alreadyOnAnnounced = announcedPort !== null
          && browserUrlFromParams(leaf.params)?.includes(`:${announcedPort}/`) === true;
        if (!running) continue;
        if ((hasUrl || hasConflict) && (announcedPort === null || alreadyOnAnnounced)) continue;

        let ports;
        try {
          ports = await platform.getOpenPorts!(leaf.id);
        } catch {
          continue; // A scan that fails is a scan that finds nothing yet.
        }
        if (cancelled) return;
        const entries = listenerUrlsByPort(ports);
        let entry;

        if (announce?.port != null) {
          // The announcement disambiguates; the scan supplies the number, so an
          // announced port that nothing bound frames nothing.
          entry = entries.find((candidate) => candidate.port === announce.port);
          if (!entry) continue;
        } else if (leaf.params?.toolPort !== 'auto') {
          // `announced`: never guess. No announcement, no browser.
          continue;
        } else {
          // Autobind. Do not commit on first sighting: ports appear one at a
          // time during boot, so framing the first one seen would frame
          // whichever bound earliest — for the standalone harness that is the
          // dev bridge, not vite. Wait for the set to stop changing, which
          // costs one tick and never has to retract a framed browser.
          const found = entries.map((candidate) => candidate.port);
          const previous = seenPorts.current.get(leaf.id);
          seenPorts.current.set(leaf.id, found);
          if (found.length === 0) continue;
          if (!previous || previous.length !== found.length
            || previous.some((port, index) => port !== found[index])) {
            continue; // Still settling; re-check next tick.
          }
          if (found.length > 1) {
            // Two or more is an error, never a tie-break: the rest of Dormouse
            // declines to guess among several ports and this used to be the
            // outlier. Shown where the browser would have gone.
            lath.store.updateParams(leaf.id, { toolPortConflict: found });
            continue;
          }
          entry = entries[0];
        }

        // Frame it, under whichever renderer the tool declared. Show the
        // destination immediately even for `ab-screencast`: the panel's
        // session-less branch renders `Connecting to browser session…` while
        // the daemon boots, and cannot race it (see docs/specs/dor-browser.md
        // -> Instant create). `toolFace` tests the conflict before the url, so
        // a stale verdict would keep the conflict forward over the browser.
        const agentDrivable = leaf.params?.toolRender === 'ab-screencast';
        lath.store.updateParams(leaf.id, {
          url: entry.url,
          renderMode: agentDrivable ? 'ab-screencast' : 'iframe',
          toolPortConflict: undefined,
        });
        if (!agentDrivable) continue;

        // An agent-drivable tool needs a real browser behind it. Bind the
        // session to the tool's *own* Surface rather than creating a second
        // one: a tool's browser is a param of its own leaf, which is what keeps
        // its id stable while its capabilities come and go.
        const session = sessionForKey(`tool.${leaf.id}`);
        await attachAgentBrowserSession({
          url: entry.url,
          platform,
          session,
          surfaceId: leaf.id,
          refreshSurface: (id, patch) => {
            if (!cancelled) lath.store.updateParams(id, patch);
          },
        });
        if (cancelled) return;
        // The Surface can be killed while the daemon boots. Param writes no-op
        // on a dead leaf, but the daemon would keep running with nothing bound
        // to it and no teardown path — `closeAgentBrowserSession` reads a
        // `session` param this leaf no longer has. Close it here instead
        // (docs/specs/dor-tool.md -> Lifecycle: kill reaps the browser's
        // resources).
        if (!lath.getMeta(leaf.id)) {
          void platform.agentBrowserCommand?.(session, ['close']).catch(() => {});
        }
      }
    };

    // `getOpenPorts` shells out (lsof / PowerShell) and an agent-browser launch
    // is seconds, either of which can outrun the interval. Without this guard a
    // second tick re-enters a leaf whose `url` is not written yet and issues a
    // duplicate `agent-browser open`.
    let ticking = false;
    const runTick = async () => {
      if (ticking) return;
      ticking = true;
      try {
        await tick();
      } finally {
        ticking = false;
      }
    };

    void runTick();
    const timer = setInterval(() => void runTick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [lath, doorsRef]);
}
