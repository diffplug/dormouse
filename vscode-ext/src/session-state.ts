import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as ptyManager from './pty-manager';
import type { AlertState } from '../../lib/src/lib/alert-manager';
import { browserPersistedPane, readPersistedSession, type PersistedAlertState, type PersistedPane, type PersistedSession } from '../../lib/src/lib/session-types';
import { detectResumeCommand } from '../../lib/src/lib/resume-patterns';
import { stripTerminalControls } from '../../lib/src/lib/terminal-controls';
import { log } from './log';

const SESSION_STATE_KEY = 'dormouse.session';

export function getSavedSessionState(context: vscode.ExtensionContext): PersistedSession | null {
  const saved = readPersistedSession(context.workspaceState.get<unknown>(SESSION_STATE_KEY));
  return saved && Array.isArray(saved.panes) ? saved : null;
}

export function saveSessionState(context: vscode.ExtensionContext, state: unknown): Thenable<void> {
  return context.workspaceState.update(SESSION_STATE_KEY, state);
}

function toPersistedAlert(alert: AlertState | undefined, fallback: PersistedAlertState | null | undefined): PersistedAlertState | null {
  if (!alert) return fallback ?? null;
  return {
    status: alert.status,
    todo: alert.todo,
    notification: alert.notification,
  };
}

/**
 * Merge current alert states into a session state object from the frontend.
 * Called on every periodic save so alert data is always current in workspaceState,
 * rather than relying on deactivate (which may not complete).
 */
export function mergeAlertStates(state: unknown, alertStates: Map<string, AlertState>): unknown {
  const parsed = readPersistedSession(state);
  if (!parsed || !Array.isArray(parsed.panes)) return state;
  return {
    ...parsed,
    panes: parsed.panes.map((pane) => pane.surfaceType === 'browser'
      ? pane
      : {
        ...pane,
        alert: toPersistedAlert(alertStates.get(pane.id), pane.alert),
      }),
  };
}

export async function refreshSavedSessionStateFromPtys(
  context: vscode.ExtensionContext,
  alertStates?: Map<string, AlertState>,
): Promise<void> {
  const saved = getSavedSessionState(context);
  if (!saved) {
    log.info('[session] refreshFromPtys: no saved session, skipping');
    return;
  }

  const ptys = ptyManager.getBufferedPtys();
  log.info(`[session] refreshFromPtys: ${saved.panes.length} saved panes, ${ptys.size} live PTYs`);

  const panes = await Promise.all(
    saved.panes.map(async (pane) => {
      if (pane.surfaceType === 'browser') {
        log.info(`[session] ${pane.id}: browser surface, skipping PTY refresh`);
        return browserPersistedPane(pane, pane.alert ?? null);
      }

      const alert = toPersistedAlert(alertStates?.get(pane.id), pane.alert);

      if (!ptys.has(pane.id)) {
        log.info(`[session] ${pane.id}: not in live PTYs, keeping saved cwd=${pane.cwd}`);
        return { ...pane, alert };
      }

      const cwd = await ptyManager.getCwd(pane.id);
      log.info(`[session] ${pane.id}: live PTY cwd=${cwd}`);

      return { ...pane, cwd: cwd ?? pane.cwd ?? null, alert };
    }),
  );

  await saveSessionState(context, {
    ...saved,
    panes,
  });
  log.info(`[session] refreshFromPtys: saved ${panes.length} panes`);
}

/**
 * Recovery is written to a plain file, synchronously — NOT to `workspaceState`.
 *
 * `workspaceState.update()` hands the value to VS Code's storage service, which
 * batches its SQLite flush on its own schedule. By the time `deactivate()` runs
 * that service is already tearing down, so the write never reaches disk however
 * early it is issued: measured on a real machine, detection completed at +276ms
 * and the record still never appeared. A synchronous `writeFileSync` is durable
 * the instant it returns and needs no budget at all.
 */
function recoveryFilePath(context: vscode.ExtensionContext): string | null {
  const dir = context.storageUri?.fsPath ?? context.globalStorageUri?.fsPath;
  return dir ? path.join(dir, 'recovery.json') : null;
}

interface PersistedRecovery {
  createdAt: number;
  /** Surface id -> canonical agent resume invocation. */
  commands: Record<string, string>;
}

// Claude's own words when it wants a second press. This is the ONLY trigger for
// pressing a pane again — a timing window is not good enough, because a second
// press that lands while codex is still printing destroys its hint outright, and
// codex's latency is not a constant (measured 255ms standalone, >400ms in a real
// project inside a pane). Keying on the explicit ask makes double-pressing codex
// impossible by construction instead of merely unlikely.
//
// The coupling to an English UI string is deliberate and no worse than the
// invocation patterns themselves. Note the asymmetry in how it can fail: if the
// wording changes we lose claude's recovery, which is recoverable and visible. A
// timing window that guesses wrong destroys codex's every time.
const ASKS_FOR_SECOND_PRESS = /Press Ctrl-C again/i;

// When to press a silent pane again without having been asked.
//
// Both agents' response to `^C` turns out to be state-dependent. Observed in a
// real pane: codex answered the first press by repainting its TUI (+256 bytes of
// cursor positioning, ending on its footer hint) and simply carried on running.
// It never printed a hint and never asked for another press, so an ask-only gate
// left it stuck there for the whole poll.
const BLIND_SECOND_PRESS_MS = 600;

// ...but a second press that lands while an agent is mid-shutdown destroys its
// hint, so require the pane to have been silent for this long first. Note this is
// quiet used *correctly*: not as evidence that the pane is finished (that mistake
// cost two rounds), but as evidence that pressing again cannot interrupt a print
// already in flight.
const QUIET_BEFORE_RETRY_MS = 200;

// `Press Ctrl-C again` is a live TUI footer, so it is always within a few hundred
// bytes of the tail. Bounding the strip matters: the scrollback buffer runs to
// 1MB, and stripping all of it costs ~3.5ms per pane on every 40ms tick — stolen
// from the same thread that has to deliver the hints being polled for.
const ASK_TAIL_CHARS = 8192;

/**
 * Interrupt the live PTYs, then record each pane's agent resume invocation.
 *
 * The only writer of recovery state (docs/specs/vscode.md -> "Capturing agent
 * recovery"). Two properties earn their complexity:
 *
 * 1. **Runs first in `deactivate()`.** The extension host is killed on a budget
 *    that has never once been generous enough to reach `[deactivate] done`, so
 *    the one step whose data cannot be reconstructed goes before the ones whose
 *    data can (cwd re-reads, alert merges).
 * 2. **Writes its own file, not `PersistedPane.resumeCommand`.** A later
 *    `flushAllSessions` would otherwise overwrite the session blob with the
 *    webview's copy, whose `resumeCommand` is always the stale `null` it last
 *    saw. A separate record makes the write order stop mattering.
 *
 * The scrollback read here never leaves this function — only the detected
 * invocation is stored, so no transcript reaches persisted state.
 */
export async function captureAgentRecoveryCommands(
  context: vscode.ExtensionContext,
  maxWaitMs = 1300,
): Promise<void> {
  const started = Date.now();
  const file = recoveryFilePath(context);
  if (!file) {
    log.error('[recovery] no storage path available; cannot persist');
    return;
  }

  // Clear the previous record before anything below can return early. A record is
  // only ever consumed by a cold activation that actually opens the Dormouse view,
  // so a teardown that captures nothing must not leave the last one sitting there:
  // otherwise a session where the view is never opened carries the record forward,
  // and a much later restore auto-runs a week-old invocation unprompted. The write
  // path below re-creates it the moment anything is detected.
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    log.error('[recovery] could not clear the previous record:', String(err));
  }

  // Exited PTYs are kept in the buffer map until `kill()`, and one can neither
  // receive a `^C` nor ever yield a hint — including them would scan them on every
  // tick and permanently defeat the `pending().length === 0` early exit.
  const liveIds = [...ptyManager.getBufferedPtys()].filter(([, e]) => e.alive).map(([id]) => id);
  if (liveIds.length === 0) {
    log.info('[recovery] no live PTYs to interrupt');
    return;
  }

  // Null-prototype: surface ids are arbitrary strings, and on a plain literal an
  // id of `constructor` or `toString` reads back as an inherited function — the
  // pane would test as already-captured on the very first tick and never be
  // scanned, interrupted again, or waited for.
  const commands: Record<string, string> = noCommands();
  // Marks come from the exact monotonic counter the buffer already maintains, not
  // from its *length*: a pane at the 1MB cap holds its length pinned while output
  // keeps flowing, so a length is neither a usable growth signal nor a usable
  // offset — and that pane is exactly the long-running agent this exists for.
  const startMark = new Map(liveIds.map((id) => [id, ptyManager.getScrollbackReceived(id)]));
  const lastMark = new Map(startMark);
  // Seeded once the interrupt is acked, not here — see `interruptedAt`.
  const lastGrewAt = new Map<string, number>();

  // Persist on every change rather than once at the end. The write is a few
  // hundred bytes and costs well under a millisecond, so there is no reason for
  // it to wait behind a slow agent — and the shutdown budget can end this
  // function at any instant. Writing eagerly makes the settle loop below a pure
  // optimisation for *completeness*: being killed mid-poll now costs at most a
  // late agent's command, never everything detected so far.
  //
  // Temp-then-rename so a kill during the write cannot leave a torn record for
  // the next activation to parse (same durability trick as the standalone store,
  // docs/specs/standalone.md).
  const persist = (): void => {
    const payload: PersistedRecovery = { createdAt: Date.now(), commands };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      log.error('[recovery] write failed:', String(err));
    }
  };
  const pending = () => liveIds.filter((id) => !commands[id]);
  // Panes that asked for a second press during the most recent scan.
  const asked = new Set<string>();
  // One buffer read per pending pane per tick, shared by both things a tick needs
  // to know about that pane: joining the chunks is the expensive part, so asking
  // twice would double the cost of the poll for no new information.
  const scanPending = () => {
    asked.clear();
    let changed = false;
    for (const id of pending()) {
      // Recovery commands are executable state, so only trust bytes that arrived
      // after this teardown started interrupting the pane. Scanning the existing
      // buffer would let an old launch echo or a previous agent hint run on the
      // next restore. If bounded scrollback evicted bytes past the mark in the
      // meantime, this can only return less than the pane printed; it cannot
      // expose stale output as fresh.
      const outputSinceInterrupt = ptyManager.getScrollbackSince(id, startMark.get(id) ?? Infinity);
      if (!outputSinceInterrupt) continue;
      const detected = detectResumeCommand(outputSinceInterrupt);
      if (detected) {
        commands[id] = detected;
        log.info(`[recovery]   ${id} -> ${detected} (+${Date.now() - started}ms)`);
        changed = true;
        continue;
      }
      // Strip presentation controls first — claude renders that prompt inside its
      // TUI, so the raw buffer can carry escapes through the phrase.
      if (ASKS_FOR_SECOND_PRESS.test(stripTerminalControls(outputSinceInterrupt.slice(-ASK_TAIL_CHARS)))) {
        asked.add(id);
      }
    }
    if (changed) persist();
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // One press to everything, then press again only where a pane asks for it.
  // `interrupt` is already bounded and always settles within its own timeout.
  await ptyManager.interrupt(liveIds);
  // The clock the second-press rules run on, taken *after* the ack rather than at
  // entry. `BLIND_SECOND_PRESS_MS` is a statement about the agent ("long enough
  // that a one-press agent would already have spoken"), and the agent's clock
  // starts when the `^C` lands. Measuring from `started` folds the interrupt's own
  // round trip — up to its 400ms timeout — into the window, which at worst leaves
  // a claude 200ms to answer in and fires the blind press while codex is still on
  // its first ~255ms of silence. The wall-clock `deadline` below stays anchored to
  // `started`, because *that* is a shutdown budget rather than an agent timing.
  const interruptedAt = Date.now();
  for (const id of liveIds) lastGrewAt.set(id, interruptedAt);
  const pressedTwice = new Set<string>();

  // Poll to the ceiling. Do NOT try to finish early on quiet: codex says nothing
  // for ~250ms after the interrupt and then prints its whole shutdown at once, so
  // silence is what it looks like *before* it speaks, not after. Two heuristics
  // died on that — settling when detections stopped arriving (exited +219ms) and
  // settling when output stopped arriving (exited +160ms) — both mistaking the
  // gap for completion.
  //
  // Waiting is close to free now that every command is persisted the moment it is
  // found: the only cost is budget taken from the later teardown steps, and those
  // are precisely the ones whose data can be reconstructed. The one early exit
  // that is safe is having nothing left to wait for.
  const deadline = started + maxWaitMs;
  while (Date.now() < deadline) {
    await sleep(40);
    scanPending();
    if (pending().length === 0) break;

    // Press a second time when the pane asks, or — for a claude that never asks —
    // once enough time has passed that a one-press agent would already have
    // spoken. Panes that have yielded are excluded either way, so codex is never
    // the one retried.
    const elapsed = Date.now() - interruptedAt;
    for (const id of pending()) {
      const mark = ptyManager.getScrollbackReceived(id);
      if (mark !== lastMark.get(id)) { lastMark.set(id, mark); lastGrewAt.set(id, Date.now()); }
    }
    const quietFor = (id: string) => Date.now() - (lastGrewAt.get(id) ?? interruptedAt);
    const retry = pending().filter((id) => !pressedTwice.has(id)
      && (asked.has(id)
        || (elapsed >= BLIND_SECOND_PRESS_MS && quietFor(id) >= QUIET_BEFORE_RETRY_MS)));
    if (retry.length > 0) {
      const why = retry.some((id) => asked.has(id)) ? 'asked' : `silent past ${BLIND_SECOND_PRESS_MS}ms`;
      retry.forEach((id) => pressedTwice.add(id));
      log.info(`[recovery] second press for ${retry.length} pane(s) at +${elapsed}ms after ^C (${why})`);
      await ptyManager.interrupt(retry);
    }
  }

  const found = Object.keys(commands).length;
  log.info(`[recovery] settled with ${found} command(s) across ${liveIds.length} live PTY(s) at +${Date.now() - started}ms`);
  // A pane that yielded nothing is worth a line, but only its shape — never its
  // output. Whether the interrupt produced *any* bytes separates "the ^C never
  // landed" from "it ran and kept going", which is the fork that matters, and it
  // is the one piece of this that can be logged forever: dumping the actual tail
  // would write terminal output into a log file, which is precisely the
  // disclosure this whole scope exists to remove.
  for (const id of pending()) {
    const after = ptyManager.getScrollbackReceived(id) - (startMark.get(id) ?? 0);
    log.info(`[recovery]   no hint from ${id}: +${after} bytes since interrupt, asked=${asked.has(id)}, pressedTwice=${pressedTwice.has(id)}`);
  }
  // Nothing to write here: every command was persisted the moment it was found.
}

/** How long a recovery record stays offerable. One cold activation consumes it;
 *  this only bounds a host that never comes back. */
const RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What is left of this activation's record, once the file has been read and
 * removed. `null` until the first `takeRecoveryCommands` call.
 *
 * The record is not the property of any one webview: `captureAgentRecoveryCommands`
 * interrupts every live PTY, and those panes are spread across the Dormouse view
 * and any number of editor panels, each restoring its own pane ids from its own
 * saved state. Holding the remainder here lets every container claim its share of
 * one file read, while entries leave the map as they are claimed so no id is ever
 * handed out twice.
 */
let unclaimedRecovery: Record<string, string> | null = null;

/** Null-prototype throughout, for the same reason the capture side is: these are
 *  keyed by arbitrary surface id, and on a plain literal an id of `constructor` or
 *  `toString` reads back as an inherited function while `__proto__` refuses to be
 *  stored at all. */
const noCommands = (): Record<string, string> => Object.create(null);

/**
 * Claim the recovery commands belonging to `paneIds` — `surfaceId -> invocation`
 * for the boot payload of one cold-starting webview.
 *
 * Exactly-once holds on two levels. The file is read and unlinked on the first
 * call of an activation, so the durable copy is gone before any webview can act
 * on it and a failed activation cannot replay it. Within the activation each
 * entry is removed as it is claimed, so a view that is disposed and re-resolved
 * (moving the panel container, say) restores without re-running the agent.
 *
 * The result never joins the persisted session — it rides its own boot global, so
 * the webview has nothing to write back and no save/restore cycle can resurrect it
 * (docs/specs/transport.md -> "Consuming it").
 */
export function takeRecoveryCommands(
  context: vscode.ExtensionContext,
  paneIds: Iterable<string>,
): Record<string, string> {
  unclaimedRecovery ??= readAndClearRecoveryRecord(context);
  const claimed: Record<string, string> = noCommands();
  for (const id of paneIds) {
    const command = unclaimedRecovery[id];
    if (command === undefined) continue;
    claimed[id] = command;
    delete unclaimedRecovery[id];
    log.info(`[recovery]   ${id} -> ${command}`);
  }
  log.info(`[recovery] handing ${Object.keys(claimed).length} command(s) to a cold restore`
    + ` (${Object.keys(unclaimedRecovery).length} unclaimed)`);
  return claimed;
}

function readAndClearRecoveryRecord(
  context: vscode.ExtensionContext,
): Record<string, string> {
  const file = recoveryFilePath(context);
  if (!file || !fs.existsSync(file)) return noCommands();

  let recovery: PersistedRecovery | null = null;
  try {
    recovery = JSON.parse(fs.readFileSync(file, 'utf8')) as PersistedRecovery;
  } catch (err) {
    log.error('[recovery] unreadable record; discarding:', String(err));
  }
  // Destructive read, and destructive even on a parse failure: a record that
  // cannot be understood must not sit on disk waiting to be retried forever.
  try {
    fs.unlinkSync(file);
  } catch {
    // If it cannot be removed, do not use it — better to lose one recovery than
    // to re-run an agent on every activation from a record we cannot clear.
    log.error('[recovery] could not clear record; ignoring it');
    return noCommands();
  }
  if (!recovery) return noCommands();

  const age = Date.now() - (recovery.createdAt ?? 0);
  if (age > RECOVERY_MAX_AGE_MS) {
    log.info(`[recovery] discarding record ${Math.round(age / 86_400_000)}d old`);
    return noCommands();
  }

  // Shape-guard every entry, the way every other persisted blob here is guarded.
  // This file is plain JSON on disk and its values end up typed into a shell, so
  // a torn or hand-edited record must fail as one dropped entry rather than as
  // something later code has to survive. `readInjectedRecoveryCommands` guards
  // again on the webview side — this one keeps the bad value out of the boot
  // payload in the first place, and says so in the log where it can be seen.
  const raw: unknown = recovery.commands;
  const commands: Record<string, string> = noCommands();
  if (raw && typeof raw === 'object') {
    for (const [id, command] of Object.entries(raw)) {
      if (typeof command !== 'string') {
        log.error(`[recovery] dropping ${id}: expected a string, got ${typeof command}`);
        continue;
      }
      commands[id] = command;
    }
  }
  log.info(`[recovery] read ${Object.keys(commands).length} command(s) from the record`);
  return commands;
}
