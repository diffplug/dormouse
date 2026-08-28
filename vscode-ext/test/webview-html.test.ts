import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getWebviewHtml } from '../src/webview-html';

/**
 * `getWebviewHtml` post-processes whatever HTML Vite built into `media/`, so
 * these tests feed it that file's real shape from a temp directory rather than
 * mocking the read. The shape below is Vite 8 output: rolldown splits its shared
 * runtime into its own chunk, and the entry both statically imports it *and*
 * carries a `<link rel="modulepreload">` for it.
 */
const VITE_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Dormouse</title>
    <script type="module" crossorigin src="./assets/index-AAAAAAAA.js"></script>
    <link rel="modulepreload" crossorigin href="./assets/rolldown-runtime-BBBBBBBB.js">
    <link rel="modulepreload" crossorigin href="./assets/alert-ring-watch-CCCCCCCC.js">
    <link rel="stylesheet" crossorigin href="./assets/index-DDDDDDDD.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

const CSP_SOURCE = 'https://file+.vscode-resource.vscode-cdn.net';

const webview = {
  cspSource: CSP_SOURCE,
  asWebviewUri: (uri: { fsPath: string }) => `${CSP_SOURCE}${uri.fsPath}`,
} as never;

let mediaPath: string;

beforeEach(() => {
  mediaPath = mkdtempSync(join(tmpdir(), 'dormouse-webview-html-'));
  writeFileSync(join(mediaPath, 'index.html'), VITE_INDEX_HTML);
});

afterEach(() => {
  rmSync(mediaPath, { recursive: true, force: true });
});

/** The single nonce the document was served with, read back off its CSP. */
function nonceOf(html: string): string {
  const match = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(html);
  if (!match) throw new Error('no script-src nonce in the CSP');
  return match[1];
}

describe('getWebviewHtml', () => {
  it("pairs the nonce with 'strict-dynamic' so split chunks can load", () => {
    const { html } = getWebviewHtml(webview, mediaPath);
    // Vite code-splits, and neither a static import of a shared chunk nor a lazy
    // `import()` carries the nonce. Without `strict-dynamic` both are blocked:
    // the first blanks the panel, the second surfaces as a render error naming a
    // chunk that is present on disk.
    expect(html).toContain(`script-src 'nonce-${nonceOf(html)}' 'strict-dynamic'`);
    // Inline scripts must stay blocked — `strict-dynamic` widens what a trusted
    // script may load, not what may be written into the document.
    expect(/script-src[^;]*'unsafe-inline'/.test(html)).toBe(false);
  });

  it('nonces every tag that loads a script, links included', () => {
    const { html } = getWebviewHtml(webview, mediaPath);
    const nonce = nonceOf(html);

    // The regression that shipped a blank panel: `script-src` gates a preload
    // too, and `strict-dynamic` does not reach it — a parser-started fetch is
    // not a script the nonce vouched for. A blocked modulepreload errors the
    // module map entry that the entry chunk's own static import then resolves
    // to, so nothing mounts.
    for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
      const loadsScript = /<script\b/.test(tag) || /\brel="(?:modulepreload|preload)"/.test(tag);
      if (!loadsScript) continue;
      expect(tag, `un-nonced script-loading tag: ${tag}`).toContain(`nonce="${nonce}"`);
    }
  });

  it('leaves the stylesheet link alone — style-src carries no nonce to satisfy', () => {
    const { html } = getWebviewHtml(webview, mediaPath);
    const stylesheet = /<link\b[^>]*rel="stylesheet"[^>]*>/.exec(html)?.[0] ?? '';
    expect(stylesheet).not.toContain('nonce=');
  });

  it('gives each tag exactly one nonce', () => {
    const { html } = getWebviewHtml(webview, mediaPath);
    for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
      expect((tag.match(/nonce=/g) ?? []).length, `duplicate nonce: ${tag}`).toBeLessThanOrEqual(1);
    }
  });

  it('rewrites asset paths onto the webview URI', () => {
    const { html } = getWebviewHtml(webview, mediaPath);
    expect(html).not.toContain('"./assets/');
    expect(html).toContain(`${CSP_SOURCE}${mediaPath}/assets/index-AAAAAAAA.js`);
    expect(html).toContain(`${CSP_SOURCE}${mediaPath}/assets/rolldown-runtime-BBBBBBBB.js`);
  });

  it('mints a fresh nonce and message token per document', () => {
    const first = getWebviewHtml(webview, mediaPath);
    const second = getWebviewHtml(webview, mediaPath);
    expect(nonceOf(first.html)).not.toBe(nonceOf(second.html));
    expect(first.messageToken).not.toBe(second.messageToken);
    // The two secrets are deliberately distinct: one authorizes script
    // execution, the other authenticates a message sender.
    expect(first.messageToken).not.toBe(nonceOf(first.html));
  });
});
