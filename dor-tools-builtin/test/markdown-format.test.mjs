import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { load } from './bundle.mjs';

// Exercise the exact parser/serializer versions used by the installed editor.
const viewer = createRequire(new URL('../viewer/markdown.tsx', import.meta.url));
const editor = createRequire(viewer.resolve('@mdxeditor/editor'));
const dependency = name => import(editor.resolve(name));
const { fromMarkdown } = await dependency('mdast-util-from-markdown');
const { toMarkdown } = await dependency('mdast-util-to-markdown');
const { mdxJsx } = await dependency('micromark-extension-mdx-jsx');
const { mdxJsxFromMarkdown, mdxJsxToMarkdown } = await dependency('mdast-util-mdx-jsx');
const { markdownFormat } = await load('../viewer/markdown-format.ts');
const parse = text => fromMarkdown(text, { extensions: [mdxJsx()], mdastExtensions: [mdxJsxFromMarkdown()] });
const serialize = (tree, original) => toMarkdown(tree, { extensions: [mdxJsxToMarkdown()], ...markdownFormat(original) });
const roundtrip = text => serialize(parse(text), text);
const semantic = tree => JSON.parse(JSON.stringify(tree, (key, value) => key === 'position' ? undefined : value));

for (const source of [
  '## [Unreleased]\n\n## [1.3.0] - 2026-10-20\n',
  'Use &lt;your relay&gt; here.\n',
  '## Tight\nbody\n\n## Loose\n\nbody\n',
  '## First\n## Second\nbody\n',
]) {
  test(`preserves issue 1254 formatting: ${JSON.stringify(source)}`, () => {
    assert.equal(roundtrip(source), source);
  });
}

test('a real edit keeps surrounding labels, entities, and heading spacing', () => {
  const source = '## [Unreleased]\nold &lt;your relay&gt;\n\n## [1.3.0] - 2026-10-20\n\nprevious\n';
  const tree = parse(source);
  tree.children[1].children[0].value = 'new <your relay>';
  const saved = serialize(tree, source);
  assert.equal(saved, source.replace('old', 'new'));
  assert.deepEqual(semantic(parse(saved)), semantic(tree));
});

for (const source of [
  '\\[literal](url)\n',
  '\\[literal][ref]\n\n[ref]: /target\n',
  '\\[literal]\n\n[literal]: /target\n',
  '\\[literal]: /target\n',
  '[link \\[label\\]](/target)\n',
  '- \\[x] plain list text\n',
  '\\[outer \\[inner] end]\n',
  '\\\\[path]\n',
  '![image](image.png)\n',
  '`<your relay> [literal]`\n',
  '```md\n## Example\nbody [literal] <your relay>\n```\n',
  '<span title="<literal>">safe</span>\n',
  'Use \\<your relay> and &lt;https://example.com&gt;.\n',
  '\\<script>alert(1)\\</script>\n',
  'Write \\&#x3C; and \\&#x3E; literally, but \\\\&lt;.\n',
  'A \\[label] **bold** and \\[label]\\(url).\n',
]) {
  test(`retains semantics: ${JSON.stringify(source)}`, () => {
    const before = parse(source);
    const saved = serialize(before, source);
    assert.deepEqual(semantic(parse(saved)), semantic(before));
    assert.equal(roundtrip(saved), saved);
  });
}

test('new headings follow the majority spacing, ignoring fenced examples', () => {
  const source = '## One\ntext\n\n```md\n## Example\n\ntext\n```\n';
  assert.equal(serialize(parse('## New\n\ntext\n'), source), '## New\ntext\n');
});
