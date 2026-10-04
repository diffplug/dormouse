import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findings, unwrap } from './md-unwrap.mjs';

const md = (...lines) => lines.join('\n');

/** `input` unwraps to `expected`, which is itself clean and a fixed point. */
function assertUnwraps(input, expected) {
  assert.notDeepEqual(findings(input), [], 'input should be flagged');
  const output = unwrap(input);
  assert.equal(output, expected);
  assert.deepEqual(findings(output), []);
  assert.equal(unwrap(output), output);
}

/** `input` is already clean and `unwrap` leaves it byte-identical. */
function assertClean(input) {
  assert.deepEqual(findings(input), []);
  assert.equal(unwrap(input), input);
}

test('a wrapped paragraph joins with single spaces', () => {
  assertUnwraps(
    md('# Title', '', 'One sentence that', 'wraps twice ', 'and ends.', '', 'Next paragraph.', ''),
    md('# Title', '', 'One sentence that wraps twice and ends.', '', 'Next paragraph.', ''),
  );
});

test('list item continuations lose their indent, nested lists stay', () => {
  assertUnwraps(
    md('- first item', '  continues here', '  - nested item', '    continues too', '- second item', '', '1. numbered', '   continues'),
    md('- first item continues here', '  - nested item continues too', '- second item', '', '1. numbered continues'),
  );
});

test('blockquote continuations lose their markers; lazy lines join too', () => {
  assertUnwraps(
    md('> quoted text', '> keeps going', 'lazily', '', '> > nested', '> > quote', '', '> - quoted list', '>   item'),
    md('> quoted text keeps going lazily', '', '> > nested quote', '', '> - quoted list item'),
  );
});

test('a continuation that only looks like a block start is still prose', () => {
  // `2.` cannot interrupt a paragraph, and an autolink is not an HTML block.
  assertUnwraps(
    md('Released in version', '2. Then', '<https://example.com> follows.'),
    md('Released in version 2. Then <https://example.com> follows.'),
  );
});

test('code, tables, HTML blocks, and front matter are untouched', () => {
  assertClean(md(
    '---',
    'name: x',
    'description: y',
    '---',
    '',
    '# Title',
    '',
    '```text',
    'fenced line one',
    'fenced line two',
    '```',
    '',
    '    indented code',
    '    second line',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '<!-- begin -->',
    'Managed paragraph.',
    '<!-- end -->',
    '',
  ));
});

test('a hard break is reported, never joined', () => {
  for (const input of [md('first line  ', 'second line'), md('first line\\', 'second line')]) {
    assert.deepEqual(findings(input).map((f) => f.message), ['hard line break; split into paragraphs or list items']);
    assert.equal(unwrap(input), input);
  }
});

test('a setext heading is reported', () => {
  const input = md('Title', '=====', '', 'Body.');
  assert.deepEqual(findings(input), [{ line: 1, message: 'setext heading; use an ATX `#` heading on one line' }]);
});

test('MDX: ESM and JSX lines stay, prose inside and around them joins', () => {
  const mdx = { mdx: true };
  const input = md(
    "import { Canvas } from './blocks';",
    "import * as Story from './x.stories';",
    '',
    'Prose that',
    'wraps.',
    '',
    '<Canvas',
    '  of={Story.Default}',
    '/>',
    '',
    '<Note>',
    '  Inside a',
    '  component.',
    '</Note>',
  );
  const expected = md(
    "import { Canvas } from './blocks';",
    "import * as Story from './x.stories';",
    '',
    'Prose that wraps.',
    '',
    '<Canvas',
    '  of={Story.Default}',
    '/>',
    '',
    '<Note>',
    '  Inside a component.',
    '</Note>',
  );
  assert.equal(findings(input, mdx).length, 2);
  const output = unwrap(input, mdx);
  assert.equal(output, expected);
  assert.deepEqual(findings(output, mdx), []);
});

test('run through a symlink, the lint still checks and fails', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'md-unwrap-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(fileURLToPath(new URL('./md-unwrap.mjs', import.meta.url)), join(dir, 'md-unwrap.mjs'));
  writeFileSync(join(dir, 'wrapped.md'), md('One', 'paragraph.'));
  const run = spawnSync(process.execPath, [join(dir, 'md-unwrap.mjs'), join(dir, 'wrapped.md')], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /wrapped\.md:1: paragraph wrapped across 2 lines/);
});
