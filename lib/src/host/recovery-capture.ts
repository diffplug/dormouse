/**
 * Interrupt the live PTYs, then detect each pane's agent resume invocation.
 *
 * The press-wait-press machine, host-agnostic: the VS Code extension host runs it
 * over `vscode-ext/src/pty-manager.ts`, the Tauri sidecar over `pty-core.js`.
 * Both reach it through the same four primitives — interrupt, a monotonic
 * received count, the output since a mark, and the live id set — because that is
 * all the detection ever needed (docs/compatible-agents.md -> "Capture").
 *
 * The gesture is always `^C` written *into* the pty, never a signal: the tty
 * line discipline delivers the SIGINT to the foreground process group, so the
 * hint comes back as ordinary PTY output on the path the host already reads.
 *
 * The scrollback read here never leaves this module: only the detected
 * invocation reaches `onCommand`, so no transcript can reach persisted state.
 */

import { detectResumeCommand } from '../lib/resume-patterns';
import { stripTerminalControls } from '../lib/terminal-controls';

// An explicit ask (Claude's `Press Ctrl-C again`, Cursor's `Press Ctrl+C
// again`, Copilot's `ctrl+c again to exit`) permits an immediate further press.
// Other panes without a recovery hint must pass both fallback clocks below
// before retrying. Keying on an English UI string is deliberate:
// docs/compatible-agents.rationale.md.
const ASKS_FOR_ANOTHER_PRESS = /Ctrl[-+]C again/i;

// The most presses any pane gets. Only an ask earns one past the second: an
// agent interrupted mid-turn spends its first press cancelling the turn (Claude,
// Copilot, Antigravity) and then asks for its usual exit pair.
export const MAX_PRESSES = 3;

// When to press a silent pane again without having been asked.
//
// Claude's and codex's response to `^C` turns out to be state-dependent.
// Observed in a real pane: codex answered the first press by repainting its TUI
// (+256 bytes of cursor positioning, ending on its footer hint) and simply
// carried on running.
// It never printed a hint and never asked for another press, so an ask-only gate
// left it stuck there for the whole poll.
// Pi clears its editor on the first press and exits only if the next arrives
// within 500ms (Pi 1.0.0, macOS). Leave a poll's margin below that window while
// still waiting past Codex's measured ~262ms one-press exit. The quiet gate
// below still defers a retry while output is arriving.
export const BLIND_SECOND_PRESS_MS = 400;

// ...but a second press that lands while an agent is mid-shutdown destroys its
// hint, so require the pane to have been silent for this long first. Note this is
// quiet used *correctly*: not as evidence that the pane is finished (that mistake
// cost two rounds), but as evidence that pressing again cannot interrupt a print
// already in flight.
export const QUIET_BEFORE_RETRY_MS = 200;

// What counts as a print in flight for that gate: anything with a line feed, or
// visible text written where the cursor already was. Output that only repaints
// in place (Pi's `Working` spinner, every ~82ms) or carries no text at all
// (Claude polls `ESC[?6n` every ~200ms after a cancel) would otherwise hold the
// gate shut for the whole capture.
const REPOSITIONS = /\x1b\[[0-9;?]*[HfABCDEFGJKd]|\r(?!\n)/;
function printsInFlight(output: string): boolean {
  if (output.includes('\n')) return true;
  return stripTerminalControls(output).trim() !== '' && !REPOSITIONS.test(output);
}

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

// Every target is resized to this before its first press. Agents lay their exit
// hint out for the pane: Copilot hard-wraps it below ~74 columns, and the
// separator its wrap adds lands inside the id. These PTYs are killed right after
// the capture, so nobody sees the size.
export const RECOVERY_SIZE = { cols: 250, rows: 50 };

// How long the resize gets to reach each program before the marks are taken:
// the repaint it provokes is old screen content, not output of the interrupt.
const WIDEN_SETTLE_MS = 80;

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
  /** Resize a PTY, as a window resize would. */
  resize(id: string, cols: number, rows: number): void;
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

  for (const id of liveIds) host.resize(id, RECOVERY_SIZE.cols, RECOVERY_SIZE.rows);
  await sleep(WIDEN_SETTLE_MS);

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
  // Panes that asked for another press since their latest one.
  const asked = new Set<string>();
  const presses = new Map(liveIds.map((id) => [id, 1]));
  // Where each pane's latest press landed in its output: an ask only counts
  // after it, or a slow exit would see the previous press's ask and press again.
  const pressMark = new Map(startMark);
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
      const sincePress = host.outputSince(id, pressMark.get(id) ?? start).slice(-ASK_TAIL_CHARS);
      if (ASKS_FOR_ANOTHER_PRESS.test(stripTerminalControls(sincePress))) asked.add(id);
    }
  };

  // One press to everything, then retry through the ask or quiet fallback gate.
  // `interrupt` is already bounded and always settles within its own timeout.
  await host.interrupt(liveIds);
  // The clock the second-press rules run on, taken *after* the ack rather than at
  // entry. `BLIND_SECOND_PRESS_MS` is a statement about the agent ("long enough
  // that a one-press agent would already have spoken"), and the agent's clock
  // starts when the `^C` lands. Measuring from `started` folds the interrupt's own
  // round trip into the window, which shortens the time an agent has to answer
  // and fires the blind press while codex is still on its first ~255ms of silence.
  // The wall-clock `deadline` below stays anchored to `started`, because *that* is
  // a shutdown budget rather than an agent timing.
  const interruptedAt = now();
  for (const id of liveIds) lastGrewAt.set(id, interruptedAt);

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
      const last = lastMark.get(id) ?? mark;
      if (mark === last) continue;
      if (printsInFlight(host.outputSince(id, last))) lastGrewAt.set(id, now());
      lastMark.set(id, mark);
    }
    const quietFor = (id: string) => now() - (lastGrewAt.get(id) ?? interruptedAt);
    const retry = pending().filter((id) => {
      const count = presses.get(id) ?? 1;
      if (asked.has(id)) return count < MAX_PRESSES;
      return count === 1 && elapsed >= BLIND_SECOND_PRESS_MS && quietFor(id) >= QUIET_BEFORE_RETRY_MS;
    });
    if (retry.length > 0) {
      const why = retry.some((id) => asked.has(id)) ? 'asked' : `silent past ${BLIND_SECOND_PRESS_MS}ms`;
      for (const id of retry) {
        presses.set(id, (presses.get(id) ?? 1) + 1);
        pressMark.set(id, host.receivedChars(id));
        asked.delete(id);
      }
      log.info(`[recovery] another press for ${retry.length} pane(s) at +${elapsed}ms after ^C (${why})`);
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
    log.info(`[recovery]   no hint from ${id}: +${after} bytes since interrupt, asked=${asked.has(id)}, presses=${presses.get(id)}`);
  }
  return found;
}
