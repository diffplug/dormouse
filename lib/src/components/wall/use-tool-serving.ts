/**
 * The serving trigger: a tool Surface grows a browser in place once its command
 * binds a port (`docs/specs/dor-tool.md` -> Serving).
 *
 * Only tool-designated Sessions are scanned. An ordinary terminal that opens a
 * port never transforms — that is the Dev-Server Chip's job, and panes must not
 * flip under the user (`docs/specs/dor-tool.md` -> Security).
 */
import { useEffect, useRef } from 'react';
import { getTerminalPaneState } from '../../lib/terminal-registry';
import {
  browserUrlFromParams,
  isToolParams,
  namespacedToolKey,
  toolKeysEqual,
  toolBrowserLaunchParams,
  toolPortConflictFromParams,
} from './browser-surface';
import { listenerUrlsByPort } from './port-url';
import { openPortsByTerminal } from './surface-ports';
import { getToolAnnounce, subscribeToToolAnnounces } from '../../lib/tool-announce-store';
import { forgetToolReports } from '../../lib/tool-events';
import { validToolServePath } from 'dor-tools-lib/osc';
import { closeBrowserSurface } from './agent-browser-surface-controller';
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

/** Retire a Tool's browser half and the serving state that framed it, leaving
 *  the terminal forward; false, doing nothing, when nothing is framed. The
 *  browser panel remains mounted behind the terminal half, so its controller
 *  must be released explicitly rather than waiting for an unmount that will not
 *  happen — closing its session with it. */
export function retireToolBrowser(lath: LathWallEngine, id: string, params: Record<string, unknown>): boolean {
  if (browserUrlFromParams(params) === null && toolPortConflictFromParams(params) === null) return false;
  closeBrowserSurface(id, params);
  lath.store.updateParams(id, {
    url: undefined,
    toolAnnouncedPort: undefined,
    toolAnnouncedPath: undefined,
    toolPortConflict: undefined,
    session: undefined,
    launchSession: undefined,
    launchFallback: undefined,
    renderMode: undefined,
    syncEngaged: undefined,
  });
  return true;
}

/** Retire a Session's previous Tool run before another is typed into it: its
 *  browser, announcement, and unsaved state are not the next run's. */
export function retireToolRun(lath: LathWallEngine, id: string): void {
  const params = lath.getMeta(id)?.params;
  if (params) retireToolBrowser(lath, id, params);
  forgetToolReports(id);
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
    let cancelled = false;

    /** One scan pass over every tool leaf, or over `only` — the leaves an
     *  announcement named, leaving every other leaf's settle state alone. */
    const tick = async (only?: ReadonlySet<string>) => {
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
      const scanning: { leaf: ToolLeaf; run: CommandRun; announcedPort: number | null; announcedPath: string }[] = [];
      for (const leaf of leaves) {
        if (only && !only.has(leaf.id)) continue;
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

        if ((!running || runChanged) && retireToolBrowser(lath, leaf.id, leaf.params)) continue;
        // An announcement outranks whatever autobind decided, framed or
        // refused: a conflict is a verdict about *guessing*, not a final state,
        // so a tool that names its port after autobind refused must still be
        // framed rather than be told to announce a port it just announced.
        // Only a changed port/path re-points a live browser. Compare the
        // applied announcement params, not params.url, to preserve navigation.
        const announcedPort = announce?.port ?? null;
        // Transfer content bypasses the parser; reject authority-bearing paths
        // here too before resolving the path against the scanned listener.
        const announcedPath = validToolServePath(announce?.path) ? announce.path : '/';
        const appliedPath = validToolServePath(leaf.params.toolAnnouncedPath) ? leaf.params.toolAnnouncedPath : '/';
        const announcementChanged = announcedPort !== null
          && (leaf.params.toolAnnouncedPort !== announcedPort || appliedPath !== announcedPath);
        if (!running) continue;
        if ((hasUrl || hasConflict) && !announcementChanged) continue;
        // `announced` never guesses: no announcement, nothing to scan for. An
        // announcement's own scan never counts as an autobind settle tick,
        // which two scans milliseconds apart would make meaningless.
        if (announcedPort === null && (only || leaf.params.toolPort !== 'auto')) continue;
        scanning.push({ leaf, run, announcedPort, announcedPath });
      }

      if (scanning.length === 0 || cancelled || paused()) return;
      // One batched scan for every leaf: each scan shells out (lsof /
      // PowerShell), so one per tool would multiply that cost on every poll.
      const portsById = await openPortsByTerminal(scanning.map(({ leaf }) => leaf.id));

      // Pass two: apply each verdict, re-checking the state every scan was
      // decided against — the awaits above gave the Surface time to be killed,
      // moved, or handed a different command.
      for (let index = 0; index < scanning.length; index += 1) {
        if (cancelled || paused()) return;
        // A scan that fails is a scan that finds nothing yet.
        const ports = portsById[scanning[index].leaf.id];
        if (!ports) continue;
        const { leaf, run, announcedPort, announcedPath } = scanning[index];
        if (!lath.getMeta(leaf.id) || getTerminalPaneState(leaf.id).currentCommand?.id !== run.id) continue;
        const entries = listenerUrlsByPort(ports);
        let entry;

        if (announcedPort !== null) {
          // The announcement disambiguates; the scan supplies the number, so an
          // announced port that nothing bound frames nothing.
          entry = entries.find((candidate) => candidate.port === announcedPort);
          if (!entry) continue;
        } else {
          // Autobind. Do not commit on first sighting: ports appear one at a
          // time during boot, so framing the first one seen would frame
          // whichever bound earliest — for the innerdogfood harness that is the
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

        // Frame it, under whichever renderer the tool declared. `toolFace`
        // tests the conflict before the url, so a stale verdict would keep the
        // conflict forward over the browser.
        //
        // An agent-drivable tool needs a real browser behind it, bound to the
        // tool's *own* Surface rather than a second one: a tool's browser is a
        // param of its own leaf, which is what keeps its id stable while its
        // capabilities come and go. Its controller launches it — reusing the
        // session it had, which a changed destination just navigates — and
        // binds the session once it is up; until then the pane shows the
        // destination and Workspace transfer waits (docs/specs/dor-browser.md
        // -> "Browser Connection").
        const url = new URL(announcedPath, entry.url).href;
        lath.store.updateParams(leaf.id, {
          ...(leaf.params.toolRender === 'agent-browser-screencast' || leaf.params.toolRender === 'playwright-screencast'
            ? toolBrowserLaunchParams(leaf.id, leaf.params, url, leaf.params.toolRender === 'playwright-screencast' ? 'playwright' : 'agent-browser')
            : { url, renderMode: 'iframe' }),
          toolPortConflict: undefined,
          toolAnnouncedPort: announcedPort ?? undefined,
          toolAnnouncedPath: announcedPort === null ? undefined : announcedPath,
        });
      }
    };

    // `getOpenPorts` shells out (lsof / PowerShell) and can outrun the
    // interval. Without this guard a second tick re-enters a leaf whose `url`
    // is not written yet and frames it twice. A poll that lands mid-tick is
    // dropped; an announcement is not, since the tick in flight decided its
    // scans before the announcement existed: its leaf waits in `pending` for
    // a run of its own once the tick settles.
    let ticking = false;
    const pending = new Set<string>();
    const runTick = async (full: boolean) => {
      if (ticking || (!full && pending.size === 0)) return;
      ticking = true;
      try {
        if (full) {
          // A full tick reads every announcement recorded so far.
          pending.clear();
          await tick();
        }
        while (pending.size > 0 && !cancelled) {
          const only = new Set(pending);
          pending.clear();
          await tick(only);
        }
      } finally {
        ticking = false;
      }
    };

    // An announcement names the port the next poll would find, so scan that
    // Tool now rather than up to a poll interval later. It still only selects:
    // the announced port must appear in the scan. The run waits for a
    // microtask, since the announcement is recorded mid-chunk and a later event
    // in that chunk (a command start) can retire it.
    const unsubscribe = subscribeToToolAnnounces((id) => {
      if (!toolLeaves(lath, doorsRef.current).some((leaf) => leaf.id === id)) return;
      pending.add(id);
      queueMicrotask(() => void runTick(false));
    });
    void runTick(true);
    const timer = setInterval(() => void runTick(true), POLL_MS);
    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(timer);
    };
  }, [lath, doorsRef, paused]);
}
