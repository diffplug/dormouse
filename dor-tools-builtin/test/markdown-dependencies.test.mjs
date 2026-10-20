import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const viewer = createRequire(new URL('../viewer/markdown.tsx', import.meta.url));
const editor = createRequire(viewer.resolve('@mdxeditor/editor'));

// Compare installed module identities, not just declared ranges or versions:
// the editor state, node classes, and LinkNode prototype patch must be shared.
// When MDXEditor moves to another Lexical release, update our direct pins in
// that same PR. This runs in the package's normal test suite and root CI.
for (const name of ['lexical', '@lexical/link']) {
  test(`the Markdown viewer and MDXEditor share ${name}`, () => {
    assert.equal(viewer.resolve(name), editor.resolve(name),
      `Update the direct ${name} pin with @mdxeditor/editor; separate copies break the Markdown editor`);
  });
}

test('the viewer LinkNode uses the editor’s Lexical state', () => {
  const link = createRequire(viewer.resolve('@lexical/link'));
  assert.equal(link.resolve('lexical'), editor.resolve('lexical'));
});
