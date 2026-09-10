import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as ptyManager from './pty-manager';
import type { AlertState } from '../../lib/src/lib/alert-manager';
import { browserPersistedPane, readPersistedSession, toPersistedAlertState, type PersistedAlertState, type PersistedPane, type PersistedSession } from '../../lib/src/lib/session-types';
import {
  captureAgentRecovery,
  DEFAULT_RECOVERY_WAIT_MS,
  noCommands,
} from '../../lib/src/host/recovery-capture';
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
  const current = alert ?? fallback;
  return current ? toPersistedAlertState(current) : null;
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
        return browserPersistedPane(pane, toPersistedAlert(undefined, pane.alert));
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

/**
 * Interrupt the live PTYs, then record each pane's agent resume invocation.
 *
 * The only writer of recovery state (docs/specs/vscode.md -> "Capturing agent
 * recovery"). The press-wait-press machine itself is shared with the Tauri
 * sidecar (`lib/src/host/recovery-capture.ts`); what stays here is the extension
 * host's half — where the record lives and how it is written.
 *
 * Two properties earn their complexity:
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
 * The scrollback the capture reads never leaves it — only the detected
 * invocation is stored, so no transcript reaches persisted state.
 */
export async function captureAgentRecoveryCommands(
  context: vscode.ExtensionContext,
  maxWaitMs = DEFAULT_RECOVERY_WAIT_MS,
): Promise<void> {
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
    log.error('[recovery] could not clear the previous record: ' + String(err));
  }

  const commands: Record<string, string> = noCommands();

  // Persist on every change rather than once at the end. The write is a few
  // hundred bytes and costs well under a millisecond, so there is no reason for
  // it to wait behind a slow agent — and the shutdown budget can end this
  // function at any instant. Writing eagerly makes the capture's settle loop a
  // pure optimisation for *completeness*: being killed mid-poll now costs at most
  // a late agent's command, never everything detected so far.
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
      log.error('[recovery] write failed: ' + String(err));
    }
  };

  await captureAgentRecovery({
    // Exited PTYs are kept in the buffer map until `kill()`, and one can neither
    // receive a `^C` nor ever yield a hint — including them would scan them on
    // every tick and permanently defeat the capture's early exit.
    liveIds: () => [...ptyManager.getBufferedPtys()].filter(([, e]) => e.alive).map(([id]) => id),
    interrupt: (ids) => ptyManager.interrupt(ids),
    receivedChars: (id) => ptyManager.getScrollbackReceived(id),
    outputSince: (id, mark) => ptyManager.getScrollbackSince(id, mark),
    onCommand: (id, command) => { commands[id] = command; persist(); },
    log: { info: (message) => log.info(message), error: (message) => log.error(message) },
  }, { maxWaitMs });
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
