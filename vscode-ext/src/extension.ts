import * as vscode from 'vscode';
import * as path from 'path';
import * as ptyManager from './pty-manager';
import { DormouseViewProvider } from './webview-view-provider';
import { attachRouter, flushAllSessions, getAlertStates } from './message-router';
import { closePoppedOutSessions } from './agent-browser-host';
import { serveWebview } from './webview-messaging';
import { log } from './log';
import { forgetRetiredState } from './retired-state';
import { captureAgentRecoveryCommands, mergeAlertStates, refreshSavedSessionStateFromPtys, takeRecoveryCommands } from './session-state';
import { readPersistedSession } from '../../lib/src/lib/session-types';
import { workspaceTitle } from './workspace-chrome';
import { resolveSelectedShell, setSelectedShellPath, getSelectedShellPath } from './shell-selection';
import type { ExtensionMessage } from './message-types';
import { initBurrow } from './burrow';
import { disposePeerLink, initPeerLink } from './peer-link';

type NewTerminalMessage = Extract<ExtensionMessage, { type: 'dormouse:newTerminal' }>;

let extensionContext: vscode.ExtensionContext | null = null;

/**
 * Wire up a WebviewPanel with session state, routing, and alert persistence.
 *
 * @param savedState Per-panel state. For `deserializeWebviewPanel` this is the
 *   state VS Code preserved from the panel's `vscode.setState()`; for a fresh
 *   panel opened via `dormouse.open` this is `undefined`.
 */
function setupPanel(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  savedState?: unknown,
  getSelectedShell?: () => { shell?: string; args?: string[] } | null,
) {
  const mediaPath = path.join(context.extensionPath, 'media');

  // Ensure webview options are set — critical for deserialized panels where
  // VS Code recreates the panel shell but we must configure the webview.
  panel.webview.options = {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(mediaPath)],
  };

  const initialState = savedState
    ? mergeAlertStates(savedState, getAlertStates())
    : undefined;

  panel.iconPath = {
    light: vscode.Uri.file(path.join(context.extensionPath, 'icon-tiny-light.png')),
    dark: vscode.Uri.file(path.join(context.extensionPath, 'icon-tiny-dark.png')),
  };
  const savedSession = readPersistedSession(initialState);
  // A panel's panes are interrupted by the teardown capture along with every
  // other live PTY, so they have a recovery command waiting too — claimed by
  // pane id, since the Dormouse view is claiming its own share of the same
  // record (docs/specs/transport.md -> "Consuming it").
  const recoveryCommands = takeRecoveryCommands(
    context,
    (savedSession?.panes ?? []).map((pane) => pane.id),
  );
  const channel = serveWebview(panel.webview, mediaPath, initialState, getSelectedShell?.(), recoveryCommands);

  const router = attachRouter(channel, {
    reconnect: !!savedState,
    killOnDispose: true,
    savedSession,
    getSelectedShell,
    // Reflect this panel's Workspace union onto the editor-tab title
    // (`<title> 🔔 [TODO]`). Icon stays the Dormouse mascot.
    onUnion: (union) => { panel.title = workspaceTitle(union); },
    // Panels persist via vscode.setState() (per-panel, managed by VS Code).
    // Don't write to workspaceState — that's for the WebviewView only.
  });
  panel.onDidDispose(() => router.dispose());
}

export function activate(context: vscode.ExtensionContext) {
  // Storage location only; nothing binds a socket until there is a Burrow to run
  // (burrow.ts).
  initPeerLink(context);
  // Whatever the Host→Burrow rename stranded, deleted unread and once
  // (`retired-state.ts`).
  void forgetRetiredState(context);
  context.subscriptions.push({ dispose: () => void disposePeerLink() });
  // The Burrow runs here, in the extension host that owns the PTYs — in
  // whichever window wins the bind (burrow.ts).
  context.subscriptions.push(initBurrow(context));
  log.init();
  extensionContext = context;
  ptyManager.setExtensionPath(context.extensionPath);

  const provider = new DormouseViewProvider(context);

  // Updates the shell-derived state in one place: the view header (shell
  // name appears next to the title via description) and the webview's
  // default-shell slot that split-spawns read from.
  const applyShell = (shell: { name: string; path: string; args: string[] } | undefined) => {
    provider.setDescription(shell?.name);
    provider.setSelectedShell(shell ? { shell: shell.path, args: shell.args } : null);
  };

  const postNewTerminal = async (message: Omit<NewTerminalMessage, 'type'>) => {
    await vscode.commands.executeCommand('dormouse.view.focus');
    for (const delay of [0, 50, 200]) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      const posted = await provider.postMessage({
        type: 'dormouse:newTerminal',
        ...message,
      });
      if (posted) return true;
    }
    return false;
  };

  // Warm up shell detection in the background so the picker/+ buttons
  // don't pay the cold-start cost (child fork + WSL probe) when the user
  // first clicks them. Also seeds the view description / webview state
  // with the current shell.
  void ptyManager.getAvailableShells().then((shells) => {
    applyShell(resolveSelectedShell(context, shells));
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dormouse.view', provider, {
      // Keep the webview script + xterm DOM alive when the Panel is hidden
      // (close/toggle), so PTYs and scrollback are preserved across re-show
      // without going through the reconnect dance.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewPanelSerializer('dormouse', {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        setupPanel(context, panel, state, () => provider.getSelectedShell());
      },
    }),
    vscode.commands.registerCommand('dormouse.focus', () => {
      vscode.commands.executeCommand('dormouse.view.focus');
    }),
    vscode.commands.registerCommand('dormouse.open', () => {
      const mediaPath = path.join(context.extensionPath, 'media');
      const panel = vscode.window.createWebviewPanel(
        'dormouse',
        'Dormouse',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.file(mediaPath)],
        },
      );
      setupPanel(context, panel, undefined, () => provider.getSelectedShell());
    }),
    vscode.commands.registerCommand('dormouse.debugTheme', async () => {
      await vscode.commands.executeCommand('dormouse.view.focus');
      for (const delay of [0, 50, 200]) {
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        const posted = await provider.postMessage({ type: 'dormouse:openThemeDebugger' });
        if (posted) return;
      }
      void vscode.window.showWarningMessage('Dormouse: open the Dormouse view before debugging the theme.');
    }),
    vscode.commands.registerCommand('dormouse.newTerminal', async () => {
      const shells = await ptyManager.getAvailableShells();
      const shell = resolveSelectedShell(context, shells);
      const posted = await postNewTerminal({
        shell: shell?.path,
        args: shell?.args,
        name: shell?.name,
      });
      if (!posted) {
        void vscode.window.showWarningMessage('Dormouse: open the Dormouse view before creating a terminal.');
      }
    }),
    vscode.commands.registerCommand('dormouse.selectShell', async () => {
      const shells = await ptyManager.getAvailableShells();
      if (shells.length === 0) {
        void vscode.window.showWarningMessage('Dormouse: no shells detected.');
        return;
      }
      const currentPath = getSelectedShellPath(context) ?? shells[0].path;
      const items: (vscode.QuickPickItem & { path: string; args: string[] })[] = shells.map((s) => ({
        label: s.name,
        description: s.path,
        picked: s.path === currentPath,
        path: s.path,
        args: s.args,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Select default shell for Dormouse',
        placeHolder: 'Changing this opens a matching terminal; new panes reuse it.',
      });
      if (!picked) return;
      const changed = picked.path !== currentPath;

      const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
      let scope: 'workspace' | 'global' = 'global';
      if (hasWorkspace) {
        const scopeChoice = await vscode.window.showQuickPick(
          [
            { label: 'Apply globally (default)', value: 'global' as const },
            { label: 'Apply to this workspace only', value: 'workspace' as const },
          ],
          { title: 'Where should this apply?' },
        );
        if (!scopeChoice) return;
        scope = scopeChoice.value;
      }
      await setSelectedShellPath(context, picked.path, scope);
      applyShell({ name: picked.label, path: picked.path, args: picked.args });
      if (changed) {
        const posted = await postNewTerminal({
          shell: picked.path,
          args: picked.args,
          name: picked.label,
          replaceUntouched: true,
          announce: true,
        });
        if (!posted) {
          void vscode.window.showWarningMessage('Dormouse: open the Dormouse view before changing the active terminal type.');
        }
      }
    }),
  );
}

export async function deactivate() {
  if (!extensionContext) return;
  const t0 = Date.now();
  const step = (name: string) => log.info(`[deactivate] ${name} (+${Date.now() - t0}ms)`);
  step('starting');
  // Recovery gets the budget FIRST, and this ordering is load-bearing rather than
  // tidy. `[deactivate] done` has never once been reached in a real shutdown — VS
  // Code kills the extension host on a budget we do not control — so the single
  // step whose data cannot be reconstructed afterwards runs before the steps whose
  // data can (cwd re-reads, alert merges). The resume hint exists only between the
  // interrupt and the kill; miss that window and it is gone
  // (docs/specs/vscode.md -> "Serialization and restore").
  //
  // Closing any headed pop-out window (so quitting never orphans a real Chrome
  // window — spec → "Pop-Out" lifecycle) is the one step that does not have
  // to queue behind it: it shares no state with the PTY interrupt and spends its
  // time in external processes rather than on this thread. Kicked off first but
  // joined after, so it overlaps the capture poll instead of adding its own round
  // trips to the serial teardown.
  step('closing popped-out browser windows');
  // Absorbed rather than propagated. Two reasons it must not throw out of the
  // join below: it would surface as an unhandledRejection while capture is
  // awaited, and — because it is joined *after* the capture rather than before —
  // it would skip the session flush, the live-PTY refresh, and both kills,
  // leaking the pty host and every PTY under it. An orphaned Chrome window is a
  // far smaller failure than an unkilled pty host.
  const poppedOutClosed = closePoppedOutSessions().catch((err) => {
    log.error('[deactivate] could not close popped-out browser windows:', String(err));
  });
  step('capturing agent recovery commands');
  await captureAgentRecoveryCommands(extensionContext, 1200);
  await poppedOutClosed;
  // Save session state while PTYs are still alive — CWD queries need live
  // processes. Must happen before gracefulKillAll.
  step('flushing sessions from webview');
  await flushAllSessions(1000);
  step('refreshing session state from live PTYs');
  await refreshSavedSessionStateFromPtys(extensionContext, getAlertStates());
  step('graceful kill');
  await ptyManager.gracefulKillAll(2000);
  ptyManager.killAll();
  step('done');
}
