import * as vscode from 'vscode';
import * as ptyManager from './pty-manager';
import type { AlertState } from '../../lib/src/lib/alert-manager';
import { browserPersistedPane, readPersistedSession, toPersistedAlertState, type PersistedAlertState, type PersistedPane, type PersistedSession } from '../../lib/src/lib/session-types';
import {
  captureAgentRecovery,
  DEFAULT_RECOVERY_WAIT_MS,
} from '../../lib/src/host/recovery-capture';
import { createRecoveryStore, type RecoveryStore } from '../../lib/src/host/recovery-store';
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
 * This activation's recovery record, in extension storage.
 *
 * A plain file, written synchronously — NOT `workspaceState`.
 * `workspaceState.update()` hands the value to VS Code's storage service, which
 * batches its SQLite flush on its own schedule. By the time `deactivate()` runs
 * that service is already tearing down, so the write never reaches disk however
 * early it is issued: measured on a real machine, detection completed at +276ms
 * and the record still never appeared. A synchronous `writeFileSync` is durable
 * the instant it returns and needs no budget at all.
 *
 * The store itself is the Tauri sidecar's (`lib/src/host/recovery-store.ts`) —
 * one record format, one destructive read, one set of file modes for both hosts.
 * Created once per activation, because the remainder of a claimed record lives in
 * it: `captureAgentRecoveryCommands` interrupts every live PTY, and those panes
 * are spread across the Dormouse view and any number of editor panels, each
 * restoring its own pane ids from its own saved state.
 */
let store: RecoveryStore | null = null;
function recoveryStore(context: vscode.ExtensionContext): RecoveryStore {
  store ??= createRecoveryStore(
    context.storageUri?.fsPath ?? context.globalStorageUri?.fsPath,
    { log: { info: (message) => log.info(message), error: (message) => log.error(message) } },
  );
  return store;
}

/**
 * Interrupt the live PTYs, then record each pane's agent resume invocation.
 *
 * The only writer of recovery state (docs/specs/vscode.md -> "Capturing agent
 * recovery"). Both halves are shared with the Tauri sidecar — the press-wait-press
 * machine and the record store — so what stays here is which PTYs the extension
 * host offers them.
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
  const recovery = recoveryStore(context);
  // The store logs the reason; nothing here can persist without a directory.
  if (!recovery.persistent) return;
  recovery.beginCapture();

  await captureAgentRecovery({
    // Exited PTYs are kept in the buffer map until `kill()`, and one can neither
    // receive a `^C` nor ever yield a hint — including them would scan them on
    // every tick and permanently defeat the capture's early exit.
    liveIds: () => [...ptyManager.getBufferedPtys()].filter(([, e]) => e.alive).map(([id]) => id),
    interrupt: (ids) => ptyManager.interrupt(ids),
    receivedChars: (id) => ptyManager.getScrollbackReceived(id),
    outputSince: (id, mark) => ptyManager.getScrollbackSince(id, mark),
    onCommand: (id, command) => recovery.record(id, command),
    log: { info: (message) => log.info(message), error: (message) => log.error(message) },
  }, { maxWaitMs });
  // Nothing to write here: the store persisted every command as it was found.
}

/**
 * Claim the recovery commands belonging to `paneIds` — `surfaceId -> invocation`
 * for the boot payload of one cold-starting webview.
 *
 * Exactly-once holds on two levels, both the store's: the file is read and
 * unlinked on the first call of an activation, and each entry leaves the
 * remainder as it is claimed, so a view that is disposed and re-resolved (moving
 * the panel container, say) restores without re-running the agent.
 *
 * The result never joins the persisted session — it rides its own boot global, so
 * the webview has nothing to write back and no save/restore cycle can resurrect it
 * (docs/specs/transport.md -> "Consuming it").
 */
export function takeRecoveryCommands(
  context: vscode.ExtensionContext,
  paneIds: Iterable<string>,
): Record<string, string> {
  return recoveryStore(context).take(paneIds);
}
