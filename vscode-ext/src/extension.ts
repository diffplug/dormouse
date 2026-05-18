import * as vscode from 'vscode';
import * as path from 'path';
import * as ptyManager from './pty-manager';
import { DormouseViewProvider } from './webview-view-provider';
import { attachRouter, flushAllSessions, getAlertStates } from './message-router';
import { getWebviewHtml } from './webview-html';
import { log } from './log';
import { mergeAlertStates, refreshSavedSessionStateFromPtys } from './session-state';
import { readPersistedSession } from '../../lib/src/lib/session-types';
import { resolveSelectedShell, setSelectedShellPath, getSelectedShellPath } from './shell-selection';
import type { ExtensionMessage } from './message-types';

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

  // Merge in current alert states so the webview starts with correct alert data
  const initialState = savedState
    ? mergeAlertStates(savedState, getAlertStates())
    : undefined;

  panel.iconPath = {
    light: vscode.Uri.file(path.join(context.extensionPath, 'icon-tiny-light.png')),
    dark: vscode.Uri.file(path.join(context.extensionPath, 'icon-tiny-dark.png')),
  };
  panel.webview.html = getWebviewHtml(panel.webview, mediaPath, initialState, getSelectedShell?.());

  const router = attachRouter(panel.webview, {
    reconnect: !!savedState,
    killOnDispose: true,
    savedSession: readPersistedSession(initialState),
    getSelectedShell,
    // Panels persist via vscode.setState() (per-panel, managed by VS Code).
    // Don't write to workspaceState — that's for the WebviewView only.
  });
  panel.onDidDispose(() => router.dispose());
}

export function activate(context: vscode.ExtensionContext) {
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
  log.info('[deactivate] starting');
  // Save session state while PTYs are still alive — CWD and scrollback
  // queries need live processes. Must happen before gracefulKillAll.
  log.info('[deactivate] flushing sessions from webview');
  await flushAllSessions(1000);
  log.info('[deactivate] refreshing session state from live PTYs');
  await refreshSavedSessionStateFromPtys(extensionContext, getAlertStates());
  log.info('[deactivate] graceful kill');
  // Now give PTYs time to print resume commands (SIGTERM instead of SIGHUP)
  await ptyManager.gracefulKillAll(2000);
  // Force kill anything still alive and clean up
  ptyManager.killAll();
  log.info('[deactivate] done');
}
