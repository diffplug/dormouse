import * as vscode from 'vscode';
import * as path from 'path';
import { attachRouter, getAlertStates } from './message-router';
import { serveWebview, type WebviewChannel } from './webview-messaging';
import { takeRecoveryCommands, getSavedSessionState, saveSessionState, mergeAlertStates } from './session-state';
import { snapshotForLiveResume } from './notepad-volatile';
import type { ExtensionMessage } from './message-types';
import * as ptyManager from './pty-manager';
import { resolveSelectedShell } from './shell-selection';
import { workspaceBadge } from './workspace-chrome';
import { log } from './log';

export class DormouseViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  // Set once the view has been served a document; until then there is nothing
  // to talk to, and `postMessage` reports undelivered like a disposed view.
  private channel: WebviewChannel | undefined;
  private routerDisposable: vscode.Disposable | undefined;
  private description: string | undefined;
  private selectedShell: { shell?: string; args?: string[] } | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  postMessage(msg: ExtensionMessage): Thenable<boolean> {
    return this.channel?.post(msg) ?? Promise.resolve(false);
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
    // The pane ids both boot globals below are claimed under. One list, because
    // the recovery claim and the notepad mirror must scope to the same panes.
    const savedPaneIds = (savedSession?.panes ?? []).map((pane) => pane.id);
    // Claimed by pane id, and deliberately separate from the session: the commands
    // ride their own boot global, so the webview cannot save them back and a
    // resume happens exactly once (docs/specs/transport.md -> "Consuming it").
    // Scoped to *this* view's panes because the capture interrupts every live PTY,
    // including any owned by an editor panel — taking the record whole would delete
    // their commands before the panel ever resolved.
    const recoveryCommands = takeRecoveryCommands(this.context, savedPaneIds);
    // The one path that hydrates the notepad mirror: this view's `onDidDispose`
    // leaves its PTYs alive, so a re-resolve (a move between panel containers) is
    // a live resume and the notes for those panes are still in extension-host
    // memory. A cold restore finds nothing mirrored and gets `null`
    // (docs/specs/notepad.md).
    const notepadVolatile = snapshotForLiveResume(savedPaneIds);
    this.channel = serveWebview(
      view.webview, mediaPath, savedSession, this.selectedShell, recoveryCommands, notepadVolatile,
    );

    this.routerDisposable?.dispose();
    this.routerDisposable = attachRouter(this.channel, {
      reconnect: true,
      savedSession,
      context: this.context,
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
      this.channel = undefined;
      this.view = undefined;
    });
  }

  focus(): void {
    this.view?.show?.(true);
  }
}
