import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { HOST_MESSAGE_TOKEN_FIELD } from '../../lib/src/lib/vscode-message-token';
import type { ExtensionMessage } from './message-types';
import { log } from './log';

/**
 * Per-boot message tokens, keyed by the webview they were minted for.
 *
 * Minted by `getWebviewHtml` (the one place that builds a webview document) and
 * read back here, so a token can never drift from the document that carries it:
 * re-serving a webview's HTML mints a new token and replaces the old entry, and
 * a disposed webview drops out on its own. See `docs/specs/vscode.md` →
 * "Webview message authentication" and `lib/src/lib/vscode-message-token.ts`
 * for the trust model.
 */
const tokens = new WeakMap<vscode.Webview, string>();

/**
 * Mint and record this webview's message token. Called once per document, from
 * `getWebviewHtml`, which injects the returned value into the page.
 *
 * Same reasoning as the CSP nonce next to it: a guessable token is not a token,
 * so it comes from the OS CSPRNG. 24 bytes of base64url is 32 characters.
 */
export function mintWebviewMessageToken(webview: vscode.Webview): string {
  const token = randomBytes(24).toString('base64url');
  tokens.set(webview, token);
  return token;
}

/**
 * Post a message to a webview, stamped with its token.
 *
 * Every host → webview send must go through here; the webview drops anything
 * unstamped. A send to a webview that was never served through `getWebviewHtml`
 * has no token to stamp, so it is dropped with a log line and reported as
 * undelivered — the same `false` the VS Code API returns for a dead webview,
 * which the retry/reject paths in `extension.ts` and `forwardDorControlRequest`
 * already handle.
 */
export function postToWebview(webview: vscode.Webview, message: ExtensionMessage): Thenable<boolean> {
  const token = tokens.get(webview);
  if (!token) {
    log.error(`[messaging] dropping ${message.type}: webview has no message token`);
    return Promise.resolve(false);
  }
  return webview.postMessage({ ...message, [HOST_MESSAGE_TOKEN_FIELD]: token });
}
