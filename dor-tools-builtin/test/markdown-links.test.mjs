import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownLink, headingIds } from '../dist/markdown-links.js';

test('relative document references separate URL syntax before percent decoding', () => {
  for (const [href, expected] of [
    ['../a%20b.md?mode=1#more%20detail', { path: '../a b.md', fragment: 'more detail' }],
    ['./a%23b%3Fc.md', { path: './a#b?c.md' }],
    ['#heading', { path: '', fragment: 'heading' }],
    ['#', { path: '', fragment: '' }],
    ['docs/', { path: 'docs/' }],
    ['picture.png', { path: 'picture.png' }],
  ]) assert.deepEqual(markdownLink(href), expected);
  for (const href of ['', '/a.md', '//host/a', 'file:///a', 'https://example.test/a', 'mailto:a@b', 'javascript:alert(1)', 'C:/a', 'C:a', 'a\\b', '%2Fa', '%5Ca', '%6Aavascript:alert(1)', 'a%00b', 'a#bad%0Aheading', 'a%zz', 'a'.repeat(4097)]) {
    assert.equal(markdownLink(href), null, href);
  }
});

test('heading anchors keep Unicode and disambiguate repeated and naturally suffixed titles', () => {
  assert.deepEqual(headingIds(['Hello, World!', 'Hello, World!', 'hello-world-1', '日本語', 'A *bold* idea']),
    ['hello-world', 'hello-world-1', 'hello-world-1-1', '日本語', 'a-bold-idea']);
});

test('Lexical renders document references unchanged without accepting executable URLs', async () => {
  const { build } = await import('esbuild');
  const { fileURLToPath } = await import('node:url');
  const result = await build({ entryPoints: [fileURLToPath(new URL('../viewer/markdown-link-url.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
  const { sanitizeLinkUrl } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  for (const href of ['b.md', '../a%20b.md#heading', '#top', 'https://example.com/']) assert.equal(sanitizeLinkUrl(href), href);
  for (const href of ['javascript:alert(1)', 'java\u0000script:alert(1)', 'data:text/html,boom']) assert.equal(sanitizeLinkUrl(href), 'about:blank');
});
