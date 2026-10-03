import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeMarkdown, mergeSentences, MORE } from './md-merge.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DRIVER = fileURLToPath(new URL('./md-merge.mjs', import.meta.url));
const md = (...lines) => lines.join('\n') + '\n';
const BASE = md('# Title', '', 'Alpha one. Bravo two. Charlie three. Delta four.', '', '- Item one. Item two.', '');

async function clean(base, ours, theirs, options) {
  const result = await mergeMarkdown({ base, ours, theirs, ...options });
  assert.equal(result.sentences, true);
  assert.equal(result.conflicts, 0, result.text);
  return result.text;
}

test('edits to different sentences of one paragraph merge', async () => {
  assert.equal(
    await clean(BASE, BASE.replace('Alpha one.', 'Alpha ONE.'), BASE.replace('Delta four.', 'Delta FOUR.')),
    BASE.replace('Alpha one.', 'Alpha ONE.').replace('Delta four.', 'Delta FOUR.'),
  );
});

test('edits to adjacent sentences merge, which a line merge of one sentence per line would not', async () => {
  const ours = BASE.replace('Bravo two.', 'Bravo TWO.');
  const theirs = BASE.replace('Charlie three.', 'Charlie THREE.');
  assert.equal(await clean(BASE, ours, theirs), BASE.replace('Bravo two.', 'Bravo TWO.').replace('Charlie three.', 'Charlie THREE.'));
});

test('deleting, inserting, and appending sentences merge with edits beside them', async () => {
  assert.equal(
    await clean(BASE, BASE.replace(' Delta four.', ''), BASE.replace('Charlie three.', 'Charlie THREE.')),
    BASE.replace(' Delta four.', '').replace('Charlie three.', 'Charlie THREE.'),
  );
  assert.equal(
    await clean(BASE, BASE.replace('Delta four.', 'Delta four. Echo five.'), BASE.replace('Delta four.', 'Delta FOUR.')),
    BASE.replace('Delta four.', 'Delta FOUR. Echo five.'),
  );
  assert.equal(
    await clean(BASE, BASE.replace('Alpha one. ', 'Alpha one. Inserted. '), BASE.replace('Bravo two.', 'Bravo TWO.')),
    BASE.replace('Alpha one. ', 'Alpha one. Inserted. ').replace('Bravo two.', 'Bravo TWO.'),
  );
});

test('list items keep their marker while their sentences merge', async () => {
  assert.equal(
    await clean(BASE, BASE.replace('Item one.', 'Item ONE.'), BASE.replace('Item two.', 'Item TWO.')),
    BASE.replace('Item one.', 'Item ONE.').replace('Item two.', 'Item TWO.'),
  );
});

test('a wrapped side merges against a reflowed one', async () => {
  const wrapped = md('# Title', '', 'Alpha one. Bravo two.', 'Charlie three. Delta four.', '', '- Item one.', '  Item two.', '');
  assert.equal(await clean(wrapped, BASE, wrapped.replace('Charlie three.', 'Charlie THREE.')), BASE.replace('Charlie three.', 'Charlie THREE.'));
});

test('edits to one sentence conflict on that sentence alone', async () => {
  const ours = BASE.replace('Bravo two.', 'Bravo ours.');
  const theirs = BASE.replace('Bravo two.', 'Bravo theirs.');
  const result = await mergeMarkdown({ base: BASE, ours, theirs, labels: ['HEAD', 'base', 'topic'] });
  assert.equal(result.conflicts, 1);
  assert.equal(result.text, md('# Title', '', 'Alpha one.', '<<<<<<< HEAD', 'Bravo ours.', '=======', 'Bravo theirs.', '>>>>>>> topic', 'Charlie three. Delta four.', '', '- Item one. Item two.', ''));
  const diff3 = await mergeMarkdown({ base: BASE, ours, theirs, conflictStyle: 'diff3', markerSize: 9 });
  assert.match(diff3.text, /^<{9} ours\nBravo ours\.\n\|{9} base\nBravo two\.\n={9}\nBravo theirs\.\n>{9} theirs$/m);
});

test('a conflict keeps a list marker on its sentence and leaves out what both sides share', async () => {
  const base = md('1. First one. Second one. Third one.', '');
  const result = await mergeMarkdown({
    base,
    ours: md('1. First ours. Second same. Third one.', ''),
    theirs: md('1. First theirs. Second same. Third one.', ''),
  });
  assert.equal(result.conflicts, 1);
  assert.equal(result.text, md('<<<<<<< ours', '1. First ours.', '=======', '1. First theirs.', '>>>>>>> theirs', 'Second same. Third one.', ''));
});

test('the sentence merge conflicts only on a shared base sentence or one insertion point', () => {
  const base = ['a', 'b', 'c'];
  assert.deepEqual(mergeSentences(base, ['a', 'B', 'c'], ['a', 'b', 'C']), ['a', 'B', 'C']);
  assert.deepEqual(mergeSentences(base, ['a', 'B', 'c'], ['a', 'B', 'c']), ['a', 'B', 'c']);
  assert.equal(mergeSentences(base, ['a', 'B', 'c'], ['a', 'c']), null);
  assert.equal(mergeSentences(base, ['a', 'x', 'b', 'c'], ['a', 'y', 'b', 'c']), null);
  assert.equal(mergeSentences(base, ['a', 'X', 'Y', 'c'], ['a', 'b', 'c', 'd']).join(), 'a,X,Y,c,d');
});

test('code blocks and tables merge by line, never by sentence', async () => {
  const base = md('```text', 'One. Two.', '```', '', '| a. b. |', '|---|');
  const result = await mergeMarkdown({ base, ours: base.replace('One.', 'ONE.'), theirs: base.replace('Two.', 'TWO.') });
  assert.equal(result.conflicts, 1);
});

test('every tracked markdown file survives an unchanged merge byte for byte', async () => {
  const files = execFileSync('git', ['ls-files', '*.md', '*.mdx'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const result = await mergeMarkdown({ base: text, ours: text, theirs: text, mdx: file.endsWith('.mdx') });
    assert.equal(result.text, text, file);
  }
});

test('a side that already holds a split marker gets a line merge', async () => {
  const odd = BASE.replace('Alpha', `Al${MORE}pha`);
  const result = await mergeMarkdown({ base: odd, ours: odd, theirs: odd });
  assert.equal(result.sentences, false);
  assert.equal(result.text, odd);
});

function repo(t, driver) {
  const dir = mkdtempSync(join(tmpdir(), 'md-merge-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  if (driver) git('config', 'merge.md-sentences.driver', driver);
  writeFileSync(join(dir, '.gitattributes'), '*.md merge=md-sentences\n');
  writeFileSync(join(dir, 'doc.md'), BASE);
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'topic');
  writeFileSync(join(dir, 'doc.md'), BASE.replace('Charlie three.', 'Charlie THREE.'));
  git('commit', '-qam', 'topic');
  git('checkout', '-q', 'main');
  writeFileSync(join(dir, 'doc.md'), BASE.replace('Bravo two.', 'Bravo TWO.'));
  git('commit', '-qam', 'main');
  const merge = git('merge', '-q', '--no-edit', 'topic');
  return { status: merge.status, text: readFileSync(join(dir, 'doc.md'), 'utf8') };
}

test('git merges through the driver', (t) => {
  const { status, text } = repo(t, `node ${JSON.stringify(DRIVER)} %O %A %B %L %P %S %X %Y`);
  assert.equal(status, 0);
  assert.equal(text, BASE.replace('Bravo two.', 'Bravo TWO.').replace('Charlie three.', 'Charlie THREE.'));
});

test('without the driver defined, or on a branch without the script, git merges by line', (t) => {
  for (const driver of [null, setupGitDriver()]) {
    const { status, text } = repo(t, driver);
    assert.equal(status, 1);
    assert.match(text, /^<<<<<<< HEAD\nAlpha one\. Bravo TWO\. Charlie three\. Delta four\.\n=======\n/m);
  }
});

/** The driver command scripts/setup-git.mjs installs, read back from a scratch repo. */
function setupGitDriver() {
  const dir = mkdtempSync(join(tmpdir(), 'md-merge-setup-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync(process.execPath, [fileURLToPath(new URL('./setup-git.mjs', import.meta.url))], { cwd: dir });
    return execFileSync('git', ['config', 'merge.md-sentences.driver'], { cwd: dir, encoding: 'utf8' }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
