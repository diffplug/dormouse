import * as vscode from 'vscode';

import * as path from 'path';
import * as fs from 'fs';

import { randomBytes } from 'crypto';
import { CSP_NONCE_PLACEHOLDER } from './csp-nonce-placeholder';
import { HOST_MESSAGE_TOKEN_GLOBAL } from '../../lib/src/lib/vscode-message-token';
import { NOTEPAD_VOLATILE_GLOBAL } from '../../lib/src/lib/vscode-notepad-global';
import { RECOVERY_COMMANDS_GLOBAL } from '../../lib/src/lib/vscode-recovery-global';
import type { VolatileNotepadSnapshot } from '../../lib/src/lib/notepad/types';

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
  /**
   * The extension host's volatile notepad mirror for this webview's live PTYs.
   * Rides the boot payload for the same reason the recovery commands do — it is
   * host-owned and must never enter a save/restore cycle — and is non-null on
   * exactly one path, a live resume (docs/specs/notepad.md → Archive and
   * Lifecycle). An editor panel always gets `null`: its own disposal archived
   * whatever it had mirrored.
   */
  notepadVolatile?: VolatileNotepadSnapshot | null,
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
    // The nonce is the root of trust; `strict-dynamic` extends it to what the
    // entry chunk then loads. A nonce is not inherited through the module graph,
    // so without it Vite's split chunks — a static import of the shared runtime,
    // a lazy `import()` — are blocked. `strict-dynamic` also makes host-source
    // expressions inert, so `webview.cspSource` beside it would be dead weight;
    // inline scripts stay blocked, since nothing here grants `unsafe-inline`.
    //
    // `wasm-unsafe-eval` is what `@xterm/addon-image` needs to compile the SIXEL
    // decoder it vendors, at Session creation. It permits WebAssembly
    // compilation and nothing else — `eval` and friends stay blocked, which
    // `unsafe-eval` would not have done (docs/specs/vscode.md → "CSP policy").
    `script-src 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data: blob:`,
    // ws: entries cover the agent-browser stream relay (frames + input for
    // browser surfaces; see docs/specs/dor-browser.md). No relay origin here:
    // the Burrow holds its `/ws/burrow` socket from the extension host, so
    // the origin allowlist is enforced there instead (burrow.ts).
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

  // Vite marks its own output — every script/style tag plus the
  // `<meta property="csp-nonce">` its runtime preload helper reads — with the
  // placeholder, using a real HTML parser. So there is no tag-matching to do
  // here, and nonce coverage tracks whatever shape the bundler emits instead of
  // a regex's guess at it (docs/specs/vscode.md → "CSP policy").
  //
  // Serving an unmarked document would leave every script un-nonced against a
  // nonce-gated policy, and the only symptom is a blank panel — the silent
  // failure this placeholder exists to end. Same reasoning as
  // `assertConnectSrcBaked` in `scripts/esbuild.mjs`: a lost build-time
  // substitution must not look recoverable at runtime.
  if (!html.includes(CSP_NONCE_PLACEHOLDER)) {
    throw new Error(
      `Webview HTML at ${indexPath} carries no ${CSP_NONCE_PLACEHOLDER}. ` +
        'The build dropped `html.cspNonce` (vscode-ext/vite.config.ts); rebuild with `pnpm build:vscode`.',
    );
  }
  html = html.replaceAll(CSP_NONCE_PLACEHOLDER, nonce);

  // The inline state script is ours, not Vite's, so it carries no placeholder —
  // nonce it directly. Injected AFTER the swap so its nonce cannot be
  // substituted a second time.
  html = html.replace(
    '</head>',
    `    <script nonce="${nonce}">globalThis.${HOST_MESSAGE_TOKEN_GLOBAL} = ${serializeForInlineScript(messageToken)};\nglobalThis.__DORMOUSE_HOST_STATE__ = ${serializeForInlineScript(initialState)};\nglobalThis.__DORMOUSE_SELECTED_SHELL__ = ${serializeForInlineScript(selectedShell ?? null)};\nglobalThis.${RECOVERY_COMMANDS_GLOBAL} = ${serializeForInlineScript(recoveryCommands ?? null)};\nglobalThis.${NOTEPAD_VOLATILE_GLOBAL} = ${serializeForInlineScript(notepadVolatile ?? null)};</script>\n  </head>`,
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
