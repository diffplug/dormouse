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
import { attachAgentBrowserSession } from './tool-browser-session';
import { listenerUrlsByPort } from './port-url';
import { getToolAnnounce } from '../../lib/tool-announce-store';
import { sessionForKey } from 'dor-lib-common/agent-browser';
import { markAgentBrowserSessionClosed } from './agent-browser-sessions';
import { disposeAgentBrowserSurfaceController } from './agent-browser-surface-controller';
import type { LathWallEngine } from './lath-wall-engine';
import type { DooredItem } from './wall-types';
import type { CommandRun } from '../../lib/terminal-state';

// A serving command usually binds within a second or two of starting, but a
// cold `pnpm` boot can take much longer, so this keeps polling for as long as
// the command runs. The scan shells out per Surface (lsof / PowerShell), so the
// cadence is deliberately slow and only tools without a URL are scanned.
const POLL_MS = 1500;

const neverPaused = () => false;

type ToolLeaf = { id: string; params: Record<string, unknown> };

/** The registered name a tool was spawned under; null for `dor tool -- <cmd>`. */
function toolNameFromParams(params: Record<string, unknown>): string | null {
  const name = params.toolName;
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
  paused = neverPaused,
}: {
  lath: LathWallEngine;
  doorsRef: React.MutableRefObject<DooredItem[]>;
  paused?: () => boolean;
}): void {
  // Ports seen on the previous tick, per leaf — the settle check's memory.
  // A ref, not state: it drives no render, and a leaf's entry is dropped when
  // its command exits so a re-run settles again from scratch.
  const seenPorts = useRef<Map<string, number[]>>(new Map());
  // A prompt and same-command restart can both happen between polls. Seed the
  // first observed run without retiring an imported live Workspace binding.
  const observedRuns = useRef<Map<string, string | null>>(new Map());

  useEffect(() => {
    const platform = getPlatform();
    if (!platform.getOpenPorts) return;
    let cancelled = false;

    const tick = async () => {
      if (paused()) return;
      const leaves = toolLeaves(lath, doorsRef.current);
      // A killed tool never reaches the exit branch below, so prune by absence.
      const live = new Set(leaves.map((leaf) => leaf.id));
      for (const id of seenPorts.current.keys()) {
        if (!live.has(id)) seenPorts.current.delete(id);
      }
      for (const id of observedRuns.current.keys()) {
        if (!live.has(id)) observedRuns.current.delete(id);
      }

      // Pass one, synchronous: fold in whatever the running commands announced
      // and decide which leaves still need a port scan. Nothing here awaits, so
      // no leaf can be retired out from under a later one.
      const scanning: { leaf: ToolLeaf; run: CommandRun; announcedPort: number | null }[] = [];
      for (const leaf of leaves) {
        const run = getTerminalPaneState(leaf.id).currentCommand;
        const runId = run?.id ?? null;
        const runChanged = observedRuns.current.has(leaf.id) && observedRuns.current.get(leaf.id) !== runId;
        observedRuns.current.set(leaf.id, runId);
        const running = run !== null && run.rawCommandLine === leaf.params.command;
        const announce = running ? getToolAnnounce(leaf.id) : null;

        // A runtime re-key re-labels this Surface and nothing else — it never
        // dedupes (docs/specs/dor-tool.md -> Identity and dedupe). The
        // namespace that keeps process output from claiming another tool's key
        // is `namespacedToolKey`'s job; see its doc comment.
        const announcedKey = namespacedToolKey(toolNameFromParams(leaf.params), announce?.key ?? null);
        if (announcedKey && !toolKeysEqual(leaf.params.toolKey, announcedKey)) {
          lath.store.updateParams(leaf.id, { toolKey: announcedKey });
        }

        const hasUrl = browserUrlFromParams(leaf.params) !== null;
        const hasConflict = toolPortConflictFromParams(leaf.params) !== null;

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
        if (!running || runChanged) seenPorts.current.delete(leaf.id);

        if ((hasUrl || hasConflict) && (!running || runChanged)) {
          const session = typeof leaf.params.session === 'string' ? leaf.params.session : null;
          if (session) {
            const binaryPath = typeof leaf.params.binaryPath === 'string' ? leaf.params.binaryPath : undefined;
            // Mark before close so a popped-out/stream-loss callback cannot
            // auto-relaunch a browser the command exit is retiring.
            markAgentBrowserSessionClosed(session);
            void platform.agentBrowserCommand?.(session, ['close'], binaryPath).catch(() => {});
          }
          // The browser panel remains mounted behind the terminal half, so its
          // controller must be disposed explicitly rather than waiting for an
          // unmount that will not happen.
          disposeAgentBrowserSurfaceController(leaf.id);
          lath.store.updateParams(leaf.id, {
            url: undefined,
            toolAnnouncedPort: undefined,
            toolPortConflict: undefined,
            session: undefined,
            wsPort: undefined,
            renderMode: undefined,
            syncEngaged: undefined,
          });
          continue;
        }
        // An announcement outranks whatever autobind decided, framed or
        // refused: a conflict is a verdict about *guessing*, not a final state,
        // so a tool that names its port after autobind refused must still be
        // framed rather than be told to announce a port it just announced.
        // Only a *changed* announced port re-points a live browser — treating a
        // mismatch with params.url as a change would undo URL-bar navigation
        // every poll after the user left the announced origin. The memory is
        // `params.toolAnnouncedPort`, the announcement the framed URL came
        // from, so there is no second map to keep in step with it.
        const announcedPort = announce?.port ?? null;
        const announcedPortChanged = announcedPort !== null && leaf.params.toolAnnouncedPort !== announcedPort;
        if (!running) continue;
        if ((hasUrl || hasConflict) && !announcedPortChanged) continue;
        scanning.push({ leaf, run, announcedPort });
      }

      if (scanning.length === 0 || cancelled || paused()) return;
      // One scan per leaf, all in flight together: each shells out (lsof /
      // PowerShell), so running them in series would make a Workspace of tools
      // take that cost times the number of tools on every poll.
      const scans = await Promise.all(
        // A scan that fails is a scan that finds nothing yet.
        scanning.map(({ leaf }) => platform.getOpenPorts!(leaf.id).catch(() => null)),
      );

      // Pass two: apply each verdict, re-checking the state every scan was
      // decided against — the awaits above gave the Surface time to be killed,
      // moved, or handed a different command.
      for (let index = 0; index < scanning.length; index += 1) {
        if (cancelled || paused()) return;
        const ports = scans[index];
        if (ports === null) continue;
        const { leaf, run, announcedPort } = scanning[index];
        if (!lath.getMeta(leaf.id) || getTerminalPaneState(leaf.id).currentCommand?.id !== run.id) continue;
        const entries = listenerUrlsByPort(ports);
        let entry;

        if (announcedPort !== null) {
          // The announcement disambiguates; the scan supplies the number, so an
          // announced port that nothing bound frames nothing.
          entry = entries.find((candidate) => candidate.port === announcedPort);
          if (!entry) continue;
        } else if (leaf.params.toolPort !== 'auto') {
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
        const agentDrivable = leaf.params.toolRender === 'ab-screencast';
        const session = typeof leaf.params.session === 'string' ? leaf.params.session : sessionForKey(`tool.${leaf.id}`);
        const binaryPath = typeof leaf.params.binaryPath === 'string' ? leaf.params.binaryPath : undefined;
        lath.store.updateParams(leaf.id, {
          url: entry.url,
          renderMode: agentDrivable ? 'ab-screencast' : 'iframe',
          toolPortConflict: undefined,
          toolAnnouncedPort: announcedPort ?? undefined,
          // Reopening an existing browser is also an in-flight connection:
          // withhold its binding until open settles so a Workspace move cannot
          // capture the old stream while this webview still owns the launch.
          ...(agentDrivable ? { session: undefined, wsPort: undefined } : {}),
        });
        if (!agentDrivable) continue;

        // An agent-drivable tool needs a real browser behind it. Bind the
        // session to the tool's *own* Surface rather than creating a second
        // one: a tool's browser is a param of its own leaf, which is what keeps
        // its id stable while its capabilities come and go.
        await attachAgentBrowserSession({
          url: entry.url,
          platform,
          session,
          surfaceId: leaf.id,
          binaryPath,
          refreshSurface: (id, patch) => {
            if (!cancelled && getTerminalPaneState(id).currentCommand?.id === run.id) lath.store.updateParams(id, patch);
          },
        });
        // The Surface can be killed while the daemon boots. Param writes no-op
        // on a dead leaf, but the daemon would keep running with nothing bound
        // to it and no teardown path — `closeAgentBrowserSession` reads a
        // `session` param this leaf no longer has. Close it here instead
        // (docs/specs/dor-tool.md -> Lifecycle: kill reaps the browser's
        // resources).
        if (cancelled || !lath.getMeta(leaf.id) || getTerminalPaneState(leaf.id).currentCommand?.id !== run.id) {
          void platform.agentBrowserCommand?.(session, ['close'], binaryPath).catch(() => {});
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
  }, [lath, doorsRef, paused]);
}
