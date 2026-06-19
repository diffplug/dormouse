import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function getWebviewHtml(
  webview: vscode.Webview,
  mediaPath: string,
  initialState?: unknown,
  selectedShell?: { shell?: string; args?: string[] } | null,
): string {
  const indexPath = path.join(mediaPath, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf-8');

  const mediaUri = webview.asWebviewUri(vscode.Uri.file(mediaPath));
  const nonce = getNonce();

  html = html.replace(/(href|src)="\.?\/?assets\//g, `$1="${mediaUri}/assets/`);

  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data: blob:`,
    // ws: entries cover the agent-browser stream relay (frames + input for
    // browser surfaces; see docs/specs/dor-browser.md).
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

  // Inject the inline state script AFTER the nonce replacements so it doesn't
  // get a duplicate nonce attribute from the regex above.
  html = html.replace(
    '</head>',
    `    <script nonce="${nonce}">globalThis.__DORMOUSE_HOST_STATE__ = ${serializeForInlineScript(initialState)};\nglobalThis.__DORMOUSE_SELECTED_SHELL__ = ${serializeForInlineScript(selectedShell ?? null)};</script>\n  </head>`,
  );

  return html;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
