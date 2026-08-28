import * as vscode from 'vscode';

import * as path from 'path';
import * as fs from 'fs';

import { randomBytes } from 'crypto';
import { HOST_MESSAGE_TOKEN_GLOBAL } from '../../lib/src/lib/vscode-message-token';
import { RECOVERY_COMMANDS_GLOBAL } from '../../lib/src/lib/vscode-recovery-global';

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Build a webview document. Returns the message token minted for it alongside
 * the HTML, because the two are only meaningful together — `serveWebview` in
 * `webview-messaging.ts` is what pairs them.
 */
export function getWebviewHtml(
  webview: vscode.Webview,
  mediaPath: string,
  initialState?: unknown,
  selectedShell?: { shell?: string; args?: string[] } | null,
  /**
   * Surface id -> agent resume invocation, captured by the last teardown. Rides
   * the boot payload rather than `initialState` because it is host-owned and
   * single-use: the webview never writes it back, so no save/restore cycle can
   * replay it (docs/specs/transport.md -> "Consuming it").
   */
  recoveryCommands?: Record<string, string> | null,
): { html: string; messageToken: string } {
  const indexPath = path.join(mediaPath, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf-8');

  const mediaUri = webview.asWebviewUri(vscode.Uri.file(mediaPath));
  const nonce = randomSecret();
  // A separate secret from the nonce above, deliberately: the nonce authorizes
  // script execution, this authenticates the sender of every host → webview
  // message so framed content can't forge one. See
  // lib/src/lib/vscode-message-token.ts.
  const messageToken = randomSecret();

  html = html.replace(/(href|src)="\.?\/?assets\//g, `$1="${mediaUri}/assets/`);

  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    // The nonce is the root of trust; `strict-dynamic` extends it to whatever
    // the nonced entry chunk goes on to load. Vite code-splits, and a split
    // bundle loads scripts two ways a bare nonce does not reach: a static import
    // of a shared chunk, and a lazy `import()` of a route/feature chunk. Neither
    // fetch carries the nonce — it is not inherited through the module graph —
    // so a nonce-only policy blocks them, and the symptom is remote: a blank
    // panel, or a render error naming a chunk that is present on disk.
    // `strict-dynamic` is the mechanism for this: a script the nonce already
    // vouched for may load more. It ignores host-source expressions, so adding
    // `webview.cspSource` beside it would be dead weight; inline scripts stay
    // blocked, since nothing here grants `unsafe-inline`.
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data: blob:`,
    // ws: entries cover the agent-browser stream relay (frames + input for
    // browser surfaces; see docs/specs/dor-browser.md). No relay origin here:
    // the remote Host holds its `/ws/host` socket from the extension host, so
    // the origin allowlist is enforced there instead (remote-host.ts).
    `connect-src ${webview.cspSource} ws://127.0.0.1:* ws://localhost:*`,
    // `dor iframe` frames its target through a loopback transparent proxy that
    // the extension host stands up (iframe-proxy-host.ts), so the only origin we
    // ever embed is 127.0.0.1/localhost on an OS-assigned port. Without a
    // frame-src override the `default-src 'none'` fallback blocks the frame
    // outright, leaving a blank (white) pane. See docs/specs/dor-browser.md.
    `frame-src http://127.0.0.1:* http://localhost:*`,
  ].join('; ');

  html = html.replace(
    '<head>',
    `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
  );

  // Add nonce to existing script tags (from the built index.html)
  html = html.replace(/<script /g, `<script nonce="${nonce}" `);
  html = html.replace(/<script>/g, `<script nonce="${nonce}">`);

  // ...and to the preload links Vite emits beside them. A preload is fetched as
  // a script, so `script-src` gates it, and `strict-dynamic` does not cover it:
  // the fetch is started by the parser, not by a script that the nonce already
  // vouched for. The element's own nonce is the only thing that can satisfy the
  // policy. Blocking one is not a lost optimization — the failed preload lands
  // an errored entry in the module map, and the entry chunk's own import of that
  // same URL then resolves to the failure, so nothing mounts and the panel is
  // blank with no error outside the webview console. Vite only started emitting
  // these for the entry's static imports when rolldown began splitting out its
  // shared runtime chunk. A nonce on a non-script preload (a font, say) is inert
  // — `font-src` carries no nonce — so match the whole preload family rather
  // than guess which ones load scripts.
  html = html.replace(
    /<link (?=[^>]*\brel="(?:modulepreload|preload)")/g,
    `<link nonce="${nonce}" `,
  );

  // Inject the inline state script AFTER the nonce replacements so it doesn't
  // get a duplicate nonce attribute from the regex above.
  html = html.replace(
    '</head>',
    `    <script nonce="${nonce}">globalThis.${HOST_MESSAGE_TOKEN_GLOBAL} = ${serializeForInlineScript(messageToken)};\nglobalThis.__DORMOUSE_HOST_STATE__ = ${serializeForInlineScript(initialState)};\nglobalThis.__DORMOUSE_SELECTED_SHELL__ = ${serializeForInlineScript(selectedShell ?? null)};\nglobalThis.${RECOVERY_COMMANDS_GLOBAL} = ${serializeForInlineScript(recoveryCommands ?? null)};</script>\n  </head>`,
  );

  return { html, messageToken };
}

/**
 * One per-document secret: a CSP nonce or a message token. Either is only as
 * good as its unpredictability, so both come from the OS CSPRNG — never
 * `Math.random()`. 24 bytes of base64url is 32 characters.
 */
function randomSecret(): string {
  return randomBytes(24).toString('base64url');
}
