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
 * The only writer of recovery state (docs/specs/transport.md -> "Capturing the
 * recovery command"). Two properties earn their complexity:
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
  // Exited PTYs are kept in the buffer map until `kill()`, and one can neither
  // receive a `^C` nor ever yield a hint — including them would scan them on every
  // tick and permanently defeat the `pending().length === 0` early exit.
  const liveIds = [...ptyManager.getBufferedPtys()].filter(([, e]) => e.alive).map(([id]) => id);
  if (liveIds.length === 0) {
    log.info('[recovery] no live PTYs to interrupt');
    return;
  }

  const file = recoveryFilePath(context);
  if (!file) {
    log.error('[recovery] no storage path available; cannot persist');
    return;
  }

  const commands: Record<string, string> = {};
  // Lengths come from the exact counter the buffer already maintains — watching a
  // pane for growth must not cost a ~1MB join per pane per tick.
  const startLen = new Map(liveIds.map((id) => [id, ptyManager.getScrollbackLength(id)]));
  const lastLen = new Map(startLen);
  const lastGrewAt = new Map(liveIds.map((id) => [id, Date.now()]));

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
      const scrollback = ptyManager.getScrollback(id);
      if (!scrollback) continue;
      const detected = detectResumeCommand(scrollback);
      if (detected) {
        commands[id] = detected;
        log.info(`[recovery]   ${id} -> ${detected} (+${Date.now() - started}ms)`);
        changed = true;
        continue;
      }
      // Strip presentation controls first — claude renders that prompt inside its
      // TUI, so the raw buffer can carry escapes through the phrase.
      if (ASKS_FOR_SECOND_PRESS.test(stripTerminalControls(scrollback.slice(-ASK_TAIL_CHARS)))) {
        asked.add(id);
      }
    }
    if (changed) persist();
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // One press to everything, then press again only where a pane asks for it.
  // `interrupt` is already bounded and always settles within its own timeout.
  await ptyManager.interrupt(liveIds);
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
    const elapsed = Date.now() - started;
    for (const id of pending()) {
      const len = ptyManager.getScrollbackLength(id);
      if (len !== lastLen.get(id)) { lastLen.set(id, len); lastGrewAt.set(id, Date.now()); }
    }
    const quietFor = (id: string) => Date.now() - (lastGrewAt.get(id) ?? started);
    const retry = pending().filter((id) => !pressedTwice.has(id)
      && (asked.has(id)
        || (elapsed >= BLIND_SECOND_PRESS_MS && quietFor(id) >= QUIET_BEFORE_RETRY_MS)));
    if (retry.length > 0) {
      const why = retry.some((id) => asked.has(id)) ? 'asked' : `silent past ${BLIND_SECOND_PRESS_MS}ms`;
      retry.forEach((id) => pressedTwice.add(id));
      log.info(`[recovery] second press for ${retry.length} pane(s) at +${elapsed}ms (${why})`);
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
    const after = ((ptyManager.getScrollback(id) ?? '').length) - (startLen.get(id) ?? 0);
    log.info(`[recovery]   no hint from ${id}: +${after} bytes since interrupt, asked=${asksAgain(id)}, pressedTwice=${pressedTwice.has(id)}`);
  }
  // Nothing to write here: every command was persisted the moment it was found.
}

/** How long a recovery record stays offerable. One cold activation consumes it;
 *  this only bounds a host that never comes back. */
const RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Read and clear the recovery record, returning `surfaceId -> invocation` for the
 * boot payload of a cold-starting webview.
 *
 * A destructive read: the durable copy is gone before the webview can act on it,
 * so a resume happens exactly once and a failed activation does not replay it.
 * The result never joins the persisted session — it rides its own boot global, so
 * the webview has nothing to write back and no save/restore cycle can resurrect it
 * (docs/specs/transport.md -> "Consuming it").
 */
export function consumeRecoveryCommands(
  context: vscode.ExtensionContext,
): Record<string, string> {
  const file = recoveryFilePath(context);
  if (!file || !fs.existsSync(file)) return {};

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
    return {};
  }
  if (!recovery) return {};

  const age = Date.now() - (recovery.createdAt ?? 0);
  if (age > RECOVERY_MAX_AGE_MS) {
    log.info(`[recovery] discarding record ${Math.round(age / 86_400_000)}d old`);
    return {};
  }

  const commands = recovery.commands ?? {};
  for (const [id, command] of Object.entries(commands)) log.info(`[recovery]   ${id} -> ${command}`);
  log.info(`[recovery] handing ${Object.keys(commands).length} command(s) to the cold restore`);
  return commands;
}
