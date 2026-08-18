import * as vscode from 'vscode';
import { HOST_MESSAGE_TOKEN_FIELD } from '../../lib/src/lib/vscode-message-token';
import { getWebviewHtml } from './webview-html';
import type { ExtensionMessage } from './message-types';

/**
 * The host's handle on a served webview. `serveWebview` returns one of these
 * *instead of* the `vscode.Webview`, so `post` is the only send path a caller
 * has — the "every send carries the token" rule is a type error to break rather
 * than a convention to remember. See `docs/specs/vscode.md` → "Webview message
 * authentication" and `lib/src/lib/vscode-message-token.ts` for the trust model.
 */
export interface WebviewChannel {
  /** Send to the webview, stamped with the token its document was served with. */
  post(message: ExtensionMessage): Thenable<boolean>;
  onDidReceiveMessage: vscode.Webview['onDidReceiveMessage'];
}

/**
 * Serve a webview its document and return the channel for talking to it.
 *
 * Minting, injecting, and assigning the HTML happen together here so a token
 * can never drift from the document that carries it: re-serving mints a new
 * token and yields a new channel, and there is no way to obtain a sender for a
 * webview that was never served.
 */
export function serveWebview(
  webview: vscode.Webview,
  mediaPath: string,
  initialState?: unknown,
  selectedShell?: { shell?: string; args?: string[] } | null,
  recoveryCommands?: Record<string, string> | null,
): WebviewChannel {
  const { html, messageToken } = getWebviewHtml(webview, mediaPath, initialState, selectedShell, recoveryCommands);
  webview.html = html;

  return {
    // Spread rather than mutate: callers own the message they passed in.
    post: (message) => webview.postMessage({ ...message, [HOST_MESSAGE_TOKEN_FIELD]: messageToken }),
    onDidReceiveMessage: webview.onDidReceiveMessage.bind(webview),
  };
}
