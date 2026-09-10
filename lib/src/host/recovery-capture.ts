/**
 * Interrupt the live PTYs, then detect each pane's agent resume invocation.
 *
 * The press-wait-press machine, host-agnostic: the VS Code extension host runs it
 * over `vscode-ext/src/pty-manager.ts`, the Tauri sidecar over `pty-core.js`.
 * Both reach it through the same four primitives — interrupt, a monotonic
 * received count, the output since a mark, and the live id set — because that is
 * all the detection ever needed (docs/specs/vscode.md -> "Capturing agent
 * recovery", docs/specs/standalone.md -> "Agent recovery").
 *
 * The scrollback read here never leaves this module: only the detected
 * invocation reaches `onCommand`, so no transcript can reach persisted state.
 */

import { detectResumeCommand } from '../lib/resume-patterns';
import { stripTerminalControls } from '../lib/terminal-controls';

// Claude's explicit request permits an immediate second press. Other panes
// without a recovery hint must pass both fallback clocks below before retrying.
const ASKS_FOR_SECOND_PRESS = /Press Ctrl-C again/i;

// When to press a silent pane again without having been asked.
//
// Both agents' response to `^C` turns out to be state-dependent. Observed in a
// real pane: codex answered the first press by repainting its TUI (+256 bytes of
// cursor positioning, ending on its footer hint) and simply carried on running.
// It never printed a hint and never asked for another press, so an ask-only gate
// left it stuck there for the whole poll.
export const BLIND_SECOND_PRESS_MS = 600;

// ...but a second press that lands while an agent is mid-shutdown destroys its
// hint, so require the pane to have been silent for this long first. Note this is
// quiet used *correctly*: not as evidence that the pane is finished (that mistake
// cost two rounds), but as evidence that pressing again cannot interrupt a print
// already in flight.
export const QUIET_BEFORE_RETRY_MS = 200;

// `Press Ctrl-C again` is a live TUI footer, so it is always within a few hundred
// bytes of the tail. Bounding the strip matters: the buffer runs to ~1MB, and
// stripping all of it costs ~3.5ms per pane on every 40ms tick — stolen from the
// same thread that has to deliver the hints being polled for.
const ASK_TAIL_CHARS = 8192;

// How far back of already-scanned output each tick re-reads, so a scan window is
// bounded by what arrived since the last tick rather than by everything since the
// interrupt. It has to cover both things a scan looks for across a tick boundary:
// the longest recognizable invocation, and the ask phrase's tail window. The ask
// window is by far the larger of the two, so it sets the overlap.
const SCAN_OVERLAP_CHARS = ASK_TAIL_CHARS;

/** How long the whole capture may take by default. */
export const DEFAULT_RECOVERY_WAIT_MS = 1300;

const POLL_STEP_MS = 40;

export interface RecoveryLog {
  info(message: string): void;
  error(message: string): void;
}

/** Everything the machine needs from whichever host owns the PTYs. */
export interface RecoveryHost {
  /** Ids that can still take a `^C`. An exited PTY can neither receive one nor
   *  ever yield a hint, so it must not appear here. */
  liveIds(): string[];
  /** Send exactly ONE `^C` to each id and resolve when the host has acked it.
   *  The second press is this module's decision, never the host's. */
  interrupt(ids: string[]): Promise<void>;
  /** Chars ever received for a pane, never decremented by a buffer trim. */
  receivedChars(id: string): number;
  /** Output received after a `receivedChars` mark, clamped to what is still held. */
  outputSince(id: string, mark: number): string;
  /** A detected invocation, handed over the moment it is found. */
  onCommand(id: string, command: string): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  log?: RecoveryLog;
}

export interface RecoveryCaptureOptions {
  /** Restrict the capture to these ids (intersected with the live set). Omitted
   *  takes every live PTY. */
  ids?: readonly string[];
  maxWaitMs?: number;
}

/** Null-prototype: surface ids are arbitrary strings, and on a plain literal an
 *  id of `constructor` or `toString` reads back as an inherited function while
 *  `__proto__` refuses to be stored at all. */
export const noCommands = (): Record<string, string> => Object.create(null);

/** The default log for every module in this scope: recovery must never require
 *  one to run. */
export const silent: RecoveryLog = { info: () => {}, error: () => {} };

/**
 * Press, wait, press again where it helps, and report what each pane printed.
 * Resolves with the number of commands detected.
 *
 * Two properties earn the complexity:
 *
 * 1. **It runs first in a teardown.** The budget has never once been generous
 *    enough to reach the end, so the one step whose data cannot be reconstructed
 *    goes before the ones whose data can (cwd re-reads, alert merges).
 * 2. **It reports eagerly.** `onCommand` fires the moment a pane yields, so being
 *    killed mid-poll costs at most a late agent's command, never everything found
 *    so far.
 */
export async function captureAgentRecovery(
  host: RecoveryHost,
  options: RecoveryCaptureOptions = {},
): Promise<number> {
  const log = host.log ?? silent;
  // Called through `host` rather than pulled off it: a class-based host loses
  // `this` the moment one of these is captured as a bare function.
  const now = (): number => host.now?.() ?? Date.now();
  const sleep = (ms: number): Promise<void> =>
    host.sleep?.(ms) ?? new Promise<void>((resolve) => { setTimeout(resolve, ms); });
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_RECOVERY_WAIT_MS;
  const started = now();

  const wanted = options.ids ? new Set(options.ids) : null;
  const liveIds = host.liveIds().filter((id) => wanted === null || wanted.has(id));
  if (liveIds.length === 0) {
    log.info('[recovery] no live PTYs to interrupt');
    return 0;
  }

  const commands: Record<string, string> = noCommands();
  // Marks come from the exact monotonic counter the buffer already maintains, not
  // from its *length*: a pane at the buffer cap holds its length pinned while
  // output keeps flowing, so a length is neither a usable growth signal nor a
  // usable offset — and that pane is exactly the long-running agent this exists
  // for.
  const startMark = new Map(liveIds.map((id) => [id, host.receivedChars(id)]));
  const lastMark = new Map(startMark);
  // How far each pane has already been scanned. A tick re-reads only
  // `SCAN_OVERLAP_CHARS` behind it, so scanning costs what arrived since the last
  // tick instead of re-joining and re-stripping everything since the interrupt.
  const scannedTo = new Map(startMark);
  // Seeded once the interrupt is acked, not here — see `interruptedAt`.
  const lastGrewAt = new Map<string, number>();

  const pending = () => liveIds.filter((id) => !commands[id]);
  // Panes that asked for a second press during the most recent scan.
  const asked = new Set<string>();
  // One buffer read per pending pane per tick, shared by both things a tick needs
  // to know about that pane: joining the chunks is the expensive part, so asking
  // twice would double the cost of the poll for no new information.
  const scanPending = () => {
    asked.clear();
    for (const id of pending()) {
      // Recovery commands are executable state, so only trust bytes that arrived
      // after this teardown started interrupting the pane: the window never
      // reaches back past `startMark`. Scanning the existing buffer would let an
      // old launch echo or a previous agent hint run on the next restore. If
      // bounded scrollback evicted bytes past the mark in the meantime, this can
      // only return less than the pane printed; it cannot expose stale output as
      // fresh.
      const start = startMark.get(id) ?? Infinity;
      const from = Math.max(start, (scannedTo.get(id) ?? start) - SCAN_OVERLAP_CHARS);
      const scanned = host.outputSince(id, from);
      scannedTo.set(id, host.receivedChars(id));
      if (!scanned) continue;
      const detected = detectResumeCommand(scanned);
      if (detected) {
        commands[id] = detected;
        log.info(`[recovery]   ${id} -> ${detected} (+${now() - started}ms)`);
        host.onCommand(id, detected);
        continue;
      }
      // Strip presentation controls first — claude renders that prompt inside its
      // TUI, so the raw buffer can carry escapes through the phrase.
      if (ASKS_FOR_SECOND_PRESS.test(stripTerminalControls(scanned.slice(-ASK_TAIL_CHARS)))) {
        asked.add(id);
      }
    }
  };

  // One press to everything, then retry through the ask or quiet fallback gate.
  // `interrupt` is already bounded and always settles within its own timeout.
  await host.interrupt(liveIds);
  // The clock the second-press rules run on, taken *after* the ack rather than at
  // entry. `BLIND_SECOND_PRESS_MS` is a statement about the agent ("long enough
  // that a one-press agent would already have spoken"), and the agent's clock
  // starts when the `^C` lands. Measuring from `started` folds the interrupt's own
  // round trip into the window, which at worst leaves a claude 200ms to answer in
  // and fires the blind press while codex is still on its first ~255ms of silence.
  // The wall-clock `deadline` below stays anchored to `started`, because *that* is
  // a shutdown budget rather than an agent timing.
  const interruptedAt = now();
  for (const id of liveIds) lastGrewAt.set(id, interruptedAt);
  const pressedTwice = new Set<string>();

  // Poll to the ceiling. Do NOT try to finish early on quiet: codex says nothing
  // for ~250ms after the interrupt and then prints its whole shutdown at once, so
  // silence is what it looks like *before* it speaks, not after. Two heuristics
  // died on that — settling when detections stopped arriving and settling when
  // output stopped arriving — both mistaking the gap for completion.
  //
  // Waiting is close to free now that every command is reported the moment it is
  // found: the only cost is budget taken from the later teardown steps, and those
  // are precisely the ones whose data can be reconstructed. The one early exit
  // that is safe is having nothing left to wait for.
  const deadline = started + maxWaitMs;
  while (now() < deadline) {
    await sleep(POLL_STEP_MS);
    scanPending();
    if (pending().length === 0) break;

    // Retry an uncaptured pane when it asks, or after both fallback clocks pass.
    const elapsed = now() - interruptedAt;
    for (const id of pending()) {
      const mark = host.receivedChars(id);
      if (mark !== lastMark.get(id)) { lastMark.set(id, mark); lastGrewAt.set(id, now()); }
    }
    const quietFor = (id: string) => now() - (lastGrewAt.get(id) ?? interruptedAt);
    const retry = pending().filter((id) => !pressedTwice.has(id)
      && (asked.has(id)
        || (elapsed >= BLIND_SECOND_PRESS_MS && quietFor(id) >= QUIET_BEFORE_RETRY_MS)));
    if (retry.length > 0) {
      const why = retry.some((id) => asked.has(id)) ? 'asked' : `silent past ${BLIND_SECOND_PRESS_MS}ms`;
      retry.forEach((id) => pressedTwice.add(id));
      log.info(`[recovery] second press for ${retry.length} pane(s) at +${elapsed}ms after ^C (${why})`);
      await host.interrupt(retry);
    }
  }

  const found = Object.keys(commands).length;
  log.info(`[recovery] settled with ${found} command(s) across ${liveIds.length} live PTY(s) at +${now() - started}ms`);
  // A pane that yielded nothing is worth a line, but only its shape — never its
  // output. Whether the interrupt produced *any* bytes separates "the ^C never
  // landed" from "it ran and kept going", which is the fork that matters, and it
  // is the one piece of this that can be logged forever: dumping the actual tail
  // would write terminal output into a log file, which is precisely the
  // disclosure this whole scope exists to remove.
  for (const id of pending()) {
    const after = host.receivedChars(id) - (startMark.get(id) ?? 0);
    log.info(`[recovery]   no hint from ${id}: +${after} bytes since interrupt, asked=${asked.has(id)}, pressedTwice=${pressedTwice.has(id)}`);
  }
  return found;
}
