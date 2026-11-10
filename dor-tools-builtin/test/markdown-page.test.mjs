import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { workspaceSourceAliases } from '../../scripts/workspace-sources.mjs';
import { markdownPage } from '../dist/editor-page.js';

// The real Markdown page, bundled as one classic script and mounted in jsdom
// against a stubbed viewer server: what it shows, and every POST it makes.
const page = (await build({
  entryPoints: [fileURLToPath(new URL('../viewer/markdown.tsx', import.meta.url))],
  bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', target: 'es2022',
  alias: workspaceSourceAliases(), jsx: 'automatic', loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' }, external: ['mermaid'],
})).outputFiles[0].text;

/** Opens `text` (or a `source` that fails with `sourceError`) and lets the editor settle. */
async function open(text, { sourceError } = {}) {
  const html = markdownPage('doc.md').replace(/<script[^>]*><\/script>/, '').replace(/<link[^>]*>/, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:1/cap/view' });
  const w = dom.window, posts = [];
  w.fetch = async (url, init) => {
    if (init?.method === 'POST') posts.push({ url, body: JSON.parse(init.body) });
    if (url === 'source' && sourceError) return { ok: false, status: 415, text: async () => sourceError };
    const answer = url === 'source' ? { text, version: 'v1', name: 'doc.md' } : url === 'save' ? { version: 'v2' } : {};
    return { ok: true, status: 200, json: async () => answer };
  };
  w.eval(`window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
    class Observer { observe() {} unobserve() {} disconnect() {} } window.ResizeObserver = Observer; window.IntersectionObserver = Observer;
    const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
    Range.prototype.getBoundingClientRect = rect; Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });
    Element.prototype.scrollIntoView = function () {}; document.elementFromPoint = () => null;`);
  w.eval(page);
  // The editor's effects (its transforms among them) run after its first export.
  await new Promise(done => setTimeout(done, 500));
  const result = {
    label: w.document.querySelector('.controls .state')?.textContent ?? null,
    error: w.document.querySelector('.error')?.textContent ?? null,
    styled: [...w.document.querySelectorAll('.prose [style]')].map(element => element.outerHTML),
    posts,
  };
  w.close();
  return result;
}

test('opening a document with bare URLs and addresses is not an edit', async () => {
  const { label, posts } = await open('See https://example.com/a_b_c, `curl https://example.com/x`, www.example.com. and me@example.com.\n');
  assert.equal(label, 'Saved');
  assert.deepEqual(posts, [{ url: 'state', body: { dirty: false } }]);
});

test('a styled span renders through the HTML allowlist, and opening it is not an edit', async () => {
  for (const text of ['before <span style="position:fixed;inset:0">overlay</span> after\n', '<span style="position:fixed;opacity:0">[click](other.md)</span>\n']) {
    const { styled, label } = await open(text);
    assert.deepEqual(styled, [], text);
    assert.equal(label, 'Saved', text);
  }
});
