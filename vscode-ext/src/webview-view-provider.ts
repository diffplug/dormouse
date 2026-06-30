import * as vscode from 'vscode';
import * as path from 'path';
import { attachRouter, getAlertStates } from './message-router';
import { getWebviewHtml } from './webview-html';
import { getSavedSessionState, saveSessionState, mergeAlertStates } from './session-state';
import type { ExtensionMessage } from './message-types';
import * as ptyManager from './pty-manager';
import { resolveSelectedShell } from './shell-selection';
import { workspaceBadge } from './workspace-chrome';
import { log } from './log';

export class DormouseViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private routerDisposable: vscode.Disposable | undefined;
  private description: string | undefined;
  private selectedShell: { shell?: string; args?: string[] } | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  postMessage(msg: ExtensionMessage): Thenable<boolean> {
    return this.view?.webview.postMessage(msg) ?? Promise.resolve(false);
  }

  setDescription(text: string | undefined): void {
    this.description = text;
    if (this.view) this.view.description = text;
  }

  setSelectedShell(opts: { shell?: string; args?: string[] } | null): void {
    this.selectedShell = opts;
    void this.postMessage({
      type: 'dormouse:selectedShell',
      shell: opts?.shell,
      args: opts?.args,
    });
  }

  getSelectedShell(): { shell?: string; args?: string[] } | null {
    return this.selectedShell;
  }

  async resolveWebviewView(
    view: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this.view = view;
    if (this.description !== undefined) view.description = this.description;

    const mediaPath = path.join(this.context.extensionPath, 'media');

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(mediaPath)],
    };

    // Resolve the selected shell before serving the HTML so Wall's
    // first-terminal spawn on mount uses the right shell. getAvailableShells
    // is cached; this blocks only on a true cold start.
    if (!this.selectedShell) {
      const shells = await ptyManager.getAvailableShells();
      const shell = resolveSelectedShell(this.context, shells);
      this.selectedShell = shell ? { shell: shell.path, args: shell.args } : null;
      if (shell) {
        this.description = shell.name;
        view.description = shell.name;
      }
    }

    const savedSession = getSavedSessionState(this.context);
    view.webview.html = getWebviewHtml(view.webview, mediaPath, savedSession, this.selectedShell);

    this.routerDisposable?.dispose();
    this.routerDisposable = attachRouter(view.webview, {
      reconnect: true,
      savedSession,
      onSaveState: (state) => {
        void saveSessionState(this.context, mergeAlertStates(state, getAlertStates()));
      },
      getSelectedShell: () => this.selectedShell,
      // Reflect this view's Workspace union onto the panel container's badge.
      // On a single-view panel container VS Code shows the static container
      // title, so view.title can't carry the status (docs/specs/vscode.md); the
      // badge is the only runtime indicator that surfaces here. It's a presence
      // flag (1 when anything owes attention). Description stays the shell name.
      onUnion: (union) => {
        if (this.view) this.view.badge = workspaceBadge(union);
      },
    });

    view.onDidDispose(() => {
      log.info('[view] onDidDispose fired — releasing router (PTYs remain alive)');
      this.routerDisposable?.dispose();
      this.routerDisposable = undefined;
      this.view = undefined;
    });
  }

  focus(): void {
    this.view?.show?.(true);
  }
}
