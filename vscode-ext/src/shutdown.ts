import type * as vscode from 'vscode';
import * as ptyManager from './pty-manager';
import { closeBrowserSessions } from './agent-browser-host';
import { flushAllSessions, getAlertStates } from './message-router';
import { captureAgentRecoveryCommands, refreshSavedSessionStateFromPtys } from './session-state';
import { log } from './log';

/** Each teardown service can fail independently as VS Code itself shuts down. */
export async function shutdown(context: vscode.ExtensionContext): Promise<void> {
  const started = Date.now();
  const attempt = async (name: string, run: () => void | PromiseLike<void>, timeoutMs?: number): Promise<void> => {
    log.info(`[deactivate] ${name} (+${Date.now() - started}ms)`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const task = run();
      await (timeoutMs === undefined ? task : Promise.race([
        task,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('shutdown step timed out')), timeoutMs);
        }),
      ]));
    } catch (error) {
      log.error(`[deactivate] ${name} failed: ${String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  };

  // Browser cleanup shares no PTY state, so it overlaps recovery's scarce budget.
  // Attach its rejection handler immediately, before awaiting capture.
  const browsersClosed = attempt('closing browser sessions', closeBrowserSessions);
  // Recovery must precede persistence and kills: an agent's exit hint cannot be
  // reconstructed after its PTY is gone. Other steps only refresh existing state.
  await attempt('capturing agent recovery commands', () => captureAgentRecoveryCommands(context, 1200));
  await browsersClosed;
  await attempt('flushing sessions from webview', () => flushAllSessions(1000));
  // workspaceState.update depends on VS Code's storage service, which may already
  // be stopping. A hung save must not keep the PTY child and its processes alive.
  await attempt('refreshing session state from live PTYs', () => refreshSavedSessionStateFromPtys(context, getAlertStates()), 1500);
  await attempt('graceful kill', () => ptyManager.gracefulKillLive(2000));
  await attempt('force kill', () => ptyManager.killAll());
  log.info(`[deactivate] done (+${Date.now() - started}ms)`);
}
