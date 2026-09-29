import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CSP_NONCE_PLACEHOLDER } from '../src/csp-nonce-placeholder';
import { getWebviewHtml } from '../src/webview-html';
import { removeDir, tempStorageDir } from './helpers';

/**
 * `getWebviewHtml` post-processes whatever Vite built into `media/`, so these
 * tests feed it that file's real shape from a temp directory rather than mocking
 * the read. Below is verbatim Vite 8 output with `html.cspNonce` set: rolldown
 * splits its shared runtime into its own chunk and the entry both imports it and
 * carries a `<link rel="modulepreload">` for it, and Vite marks every tag plus
 * the `<meta property="csp-nonce">` that its runtime preload helper reads.
 */
const VITE_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Dormouse</title>
    <meta property="csp-nonce" nonce="${CSP_NONCE_PLACEHOLDER}">
    <script type="module" crossorigin src="./assets/index-AAAAAAAA.js" nonce="${CSP_NONCE_PLACEHOLDER}"></script>
    <link rel="modulepreload" crossorigin href="./assets/rolldown-runtime-BBBBBBBB.js" nonce="${CSP_NONCE_PLACEHOLDER}">
    <link rel="modulepreload" crossorigin href="./assets/alert-ring-watch-CCCCCCCC.js" nonce="${CSP_NONCE_PLACEHOLDER}">
    <link rel="stylesheet" crossorigin href="./assets/index-DDDDDDDD.css" nonce="${CSP_NONCE_PLACEHOLDER}">
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

/** Shared across the suite: every test only reads through `getWebviewHtml`. */
let mediaPath: string;

beforeAll(async () => {
  mediaPath = await tempStorageDir();
  await writeFile(join(mediaPath, 'index.html'), VITE_INDEX_HTML);
});

afterAll(async () => {
  await removeDir(mediaPath);
});

/** The single nonce the document was served with, read back off its CSP. */
function nonceOf(html: string): string {
  const match = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(html);
  if (!match) throw new Error('no script-src nonce in the CSP');
  return match[1];
}

/**
 * One CSP directive's sources, as a list. Split rather than substring-matched:
 * `'unsafe-eval'` is a suffix of `'wasm-unsafe-eval'`, so a `toContain` check
 * for the dangerous one would read the safe one as a hit — or, worse, miss a
 * real widening that happened to sit next to it.
 */
function cspSources(html: string, directive: string): string[] {
  const csp = /content="([^"]*)"/.exec(html)?.[1] ?? '';
  const found = csp
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find((parts) => parts[0] === directive);
  if (!found) throw new Error(`no ${directive} in the CSP`);
  return found.slice(1);
}

describe('getWebviewHtml', () => {
  it("pairs the nonce with 'strict-dynamic' so split chunks can load", () => {
    const { html } = getWebviewHtml(webview, mediaPath);
    // A lazy `import()` carries no nonce — a nonce is not inherited through the
    // module graph — so without `strict-dynamic` it is blocked, surfacing as a
    // render error naming a chunk that is present on disk.
    // The whole source list, not a substring: `strict-dynamic` widens what a
    // trusted script may load and `wasm-unsafe-eval` permits WebAssembly
    // compilation, but neither is a way to run injected script text — and an
    // exact list is what makes `'unsafe-inline'` or `'unsafe-eval'` appearing
    // beside them a failure rather than an unnoticed addition.
    expect(cspSources(html, 'script-src')).toEqual([
      `'nonce-${nonceOf(html)}'`,
      `'strict-dynamic'`,
      `'wasm-unsafe-eval'`,
    ]);
  });

  it('carries the real nonce on every tag Vite marked, and leaves no placeholder', () => {
    const { html } = getWebviewHtml(webview, mediaPath);
    const nonce = nonceOf(html);

    // Named rather than derived from a predicate: a test that recomputes the
    // source's own tag-matching rule agrees with it by construction and would
    // pass even if that rule were wrong. These are the tags whose fetches
    // `script-src` gates — the entry, the two preloads for the entry's static
    // imports, and the meta tag Vite's runtime helper reads before injecting a
    // preload for a lazy chunk.
    for (const marker of [
      'index-AAAAAAAA.js',
      'rolldown-runtime-BBBBBBBB.js',
      'alert-ring-watch-CCCCCCCC.js',
      'property="csp-nonce"',
    ]) {
      const tag = new RegExp(`<[^>]*${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>`).exec(html)?.[0];
      expect(tag, `no tag found for ${marker}`).toBeDefined();
      expect(tag, `un-nonced: ${tag}`).toContain(`nonce="${nonce}"`);
    }

    // The placeholder is a build artifact; letting one reach a browser would
    // mean a tag whose nonce matches nothing.
    expect(html).not.toContain(CSP_NONCE_PLACEHOLDER);
  });

  it('gives each tag exactly one nonce', () => {
    const { html } = getWebviewHtml(webview, mediaPath);
    for (const tag of html.match(/<(?:script|link|meta)\b[^>]*>/g) ?? []) {
      expect((tag.match(/nonce=/g) ?? []).length, `duplicate nonce: ${tag}`).toBeLessThanOrEqual(1);
    }
  });

  it('refuses to serve HTML the build never marked', async () => {
    // A dropped `html.cspNonce` would otherwise yield a document whose every
    // script is un-nonced against a nonce-gated policy — a blank panel with no
    // error outside the webview console.
    const unmarked = await tempStorageDir();
    try {
      await writeFile(
        join(unmarked, 'index.html'),
        VITE_INDEX_HTML.replaceAll(CSP_NONCE_PLACEHOLDER, ''),
      );
      expect(() => getWebviewHtml(webview, unmarked)).toThrow(/cspNonce/);
    } finally {
      await removeDir(unmarked);
    }
  });

  it('refuses a document whose splice marker was edited away', async () => {
    // `<head>` is matched as a literal, so an attribute added to it in
    // `lib/index.html` would stop the match. Splicing nothing serves a document
    // with no CSP at all, which the boot smoketest reads as zero violations —
    // so the throw is the only thing standing between that edit and an
    // unpoliced webview.
    const editedPath = await tempStorageDir();
    try {
      await writeFile(
        join(editedPath, 'index.html'),
        VITE_INDEX_HTML.replace('<head>', '<head class="dormouse">'),
      );
      expect(() => getWebviewHtml(webview, editedPath)).toThrow(/carries no `<head>`/);
    } finally {
      await removeDir(editedPath);
    }
  });

  it('rewrites asset paths onto the webview URI', () => {
    const { html } = getWebviewHtml(webview, mediaPath);
    expect(html).not.toContain('"./assets/');
    expect(html).toContain(`${CSP_SOURCE}${mediaPath}/assets/index-AAAAAAAA.js`);
    expect(html).toContain(`${CSP_SOURCE}${mediaPath}/assets/rolldown-runtime-BBBBBBBB.js`);
  });

  it('treats a `$` in the media path as data while rewriting assets', async () => {
    // A `$&` in a Windows extension install path expands to the matched asset
    // attribute with replace's string form, quietly corrupting every asset URI.
    const dollarMediaPath = `${mediaPath}$&`;
    await mkdir(dollarMediaPath);
    try {
      await writeFile(join(dollarMediaPath, 'index.html'), VITE_INDEX_HTML);
      const { html } = getWebviewHtml(webview, dollarMediaPath);
      expect(html).toContain(`${CSP_SOURCE}${dollarMediaPath}/assets/index-AAAAAAAA.js`);
      expect(html).toContain(`${CSP_SOURCE}${dollarMediaPath}/assets/rolldown-runtime-BBBBBBBB.js`);
    } finally {
      await removeDir(dollarMediaPath);
    }
  });

  it('treats a `$` in serialized state as data, not a substitution pattern', () => {
    // A pane title is raw terminal output: OSC 0/2/9/99/777 set it, and the
    // protocol parser strips only control characters, so `$` and a backtick
    // survive into `workspaceState` and come back as `initialState`. Built with
    // `replace`'s string form, `` $` `` would expand to the document prefix
    // already emitted — Vite's own `</script>` included — closing the boot
    // script so none of its globals are ever set, on every launch until the
    // workspace state is cleared.
    const title = '$`$&' + "$'" + '$$PWNED';
    const { html } = getWebviewHtml(webview, mediaPath, { panes: [{ id: 'p1', title }] });

    const inline = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html);
    expect(inline, 'the boot payload script was cut short').not.toBeNull();
    // The title reaches the document exactly as written, and nothing else does.
    expect(inline![1]).toContain(JSON.stringify(title));
    expect(html.indexOf('<!DOCTYPE html>')).toBe(html.lastIndexOf('<!DOCTYPE html>'));
    expect(inline![1]).not.toContain('<meta http-equiv="Content-Security-Policy"');
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
