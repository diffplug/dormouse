import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { workspaceSourceAliases } from '../../scripts/workspace-sources.mjs';
import { markdownPage } from '../dist/editor-page.js';
import { mayHoldIndentedCode, parsesIndentedCode } from '../dist/editor-routes.js';

// The real Markdown page, bundled as one classic script and mounted in jsdom
// against a stubbed viewer server: what it shows, and every POST it makes.
const page = (await build({
  entryPoints: [fileURLToPath(new URL('../viewer/markdown.tsx', import.meta.url))],
  bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', target: 'es2022',
  alias: workspaceSourceAliases(), jsx: 'automatic', loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' }, external: ['mermaid'],
})).outputFiles[0].text;

/** Opens `text` (or a `source` that fails with `sourceError`), under
 * `userAgent` when given, and lets the editor settle; then runs `act` against
 * the page's window, its POSTs, and what `source` serves, which it may change.
 * `navigations` counts the page's attempts to leave, which jsdom reports. */
async function open(text, { sourceError, act, userAgent } = {}) {
  const html = markdownPage('doc.md').replace(/<script[^>]*><\/script>/, '').replace(/<link[^>]*>/, '');
  const virtualConsole = new VirtualConsole();
  let navigations = 0;
  virtualConsole.on('jsdomError', error => {
    if (/navigation/.test(error.message)) navigations++;
    else console.error(error);
  });
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:1/cap/view', virtualConsole });
  const w = dom.window, posts = [], served = { text, editing: 'rich' };
  w.fetch = async (url, init) => {
    if (init?.method === 'POST') posts.push({ url, body: JSON.parse(init.body) });
    if (url === 'source' && sourceError) return { ok: false, status: 415, text: async () => sourceError };
    const answer = url === 'source' ? { ...served, version: 'v1', name: 'doc.md' } : url === 'save' ? { version: 'v2' } : {};
    return { ok: true, status: 200, json: async () => answer };
  };
  w.eval(`window.matchMedia = q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
    class Observer { observe() {} unobserve() {} disconnect() {} } window.ResizeObserver = Observer; window.IntersectionObserver = Observer;
    const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
    Range.prototype.getBoundingClientRect = rect; Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });
    Element.prototype.scrollIntoView = function () {}; document.elementFromPoint = () => null;`);
  // Browsers have it; jsdom does not, and a table cell's hand-off uses it.
  w.structuredClone = value => JSON.parse(JSON.stringify(value));
  if (userAgent) Object.defineProperty(w.navigator, 'userAgent', { value: userAgent });
  w.eval(page);
  // The editor's effects (its transforms among them) run after its first export.
  await new Promise(done => setTimeout(done, 500));
  try { await act?.(w, posts, served); } catch (error) { w.close(); throw error; }
  const result = {
    navigations,
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

test('a document that fails to load shows why', async () => {
  const { error } = await open('', { sourceError: 'This editor supports UTF-8 text. Open this file in another editor.' });
  assert.equal(error, 'This editor supports UTF-8 text. Open this file in another editor.');
});

test('Reload of a file that no longer opens rich goes back through view, and never loads it rich', async () => {
  const reload = w => [...w.document.querySelectorAll('button')].find(button => button.textContent === 'Reload').click();
  const prose = w => w.document.querySelector('.prose').textContent;
  // Changed on disk to hold indented code: the page leaves for `view`.
  const changed = await open('Before.\n', {
    async act(w, _posts, served) {
      Object.assign(served, { text: 'After.\n\n    code\n', editing: 'indented' });
      reload(w);
      await new Promise(done => setTimeout(done, 300));
      assert.match(prose(w), /Before\./);
      assert.doesNotMatch(prose(w), /After|code/);
    },
  });
  assert.equal(changed.navigations, 1);
  // Changed and still rich: it reloads in place.
  const kept = await open('Before.\n', {
    async act(w, _posts, served) {
      served.text = 'After.\n';
      reload(w);
      await new Promise(done => setTimeout(done, 300));
      assert.match(prose(w), /After\./);
    },
  });
  assert.equal(kept.navigations, 0);
});

const settle = (ms = 100) => new Promise(done => setTimeout(done, ms));
const label = w => w.document.querySelector('.controls .state')?.textContent;
const saves = posts => posts.filter(post => post.url === 'save').map(post => post.body.text);
const saveKey = w => w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }));
// Compare DOM nodes with `===` under `assert.ok`: a failing `assert.equal`
// inspects both nodes, and jsdom's object graph exhausts memory.

/** The page's last table cell, made the active cell as a click makes it. */
async function lastCell(w) {
  const td = [...w.document.querySelectorAll('td')].filter(cell => cell.querySelector('[data-lexical-editor]')).at(-1);
  const element = td.querySelector('[data-lexical-editor]');
  td.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  // What a click does natively: jsdom focuses no contenteditable on its own.
  element.tabIndex = -1;
  element.focus();
  await settle();
  return { td, element, editor: element.__lexicalEditor };
}
/** Appends `text` to the cell's text, with the caret after it, as typing does. */
function type(editor, text) {
  editor.update(() => {
    const node = [...editor.getEditorState()._nodeMap.values()].find(each => each.getType() === 'text');
    node.setTextContent(node.getTextContent() + text);
    node.select();
  }, { discrete: true });
}

const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n\ntext\n';

test('text typed in a table cell is unsaved at once, and a save writes it without leaving the cell', { timeout: 30_000 }, async () => {
  await open(TABLE, { act: async (w, posts) => {
    const { td, element, editor } = await lastCell(w);
    assert.ok(w.document.activeElement === element, 'the cell has focus');
    type(editor, ' TYPED');
    await settle();
    assert.equal(label(w), 'Unsaved');
    assert.deepEqual(posts.filter(post => post.url === 'state').map(post => post.body.dirty), [false, true]);
    saveKey(w);
    await settle();
    assert.deepEqual(saves(posts), [TABLE.replace('| 2 |', '| 2 TYPED |')]);
    assert.equal(label(w), 'Saved');
    assert.ok(w.document.activeElement === element, 'focus stays in the cell');
    assert.ok(td.dataset.active === 'true', 'it is still the active cell');
    type(editor, '!');
    await settle();
    assert.equal(label(w), 'Unsaved', 'typing on after the save is an edit');
  } });
});

test('moving the caret in a table cell is not an edit', { timeout: 30_000 }, async () => {
  await open(TABLE, { act: async (w, posts) => {
    const { editor } = await lastCell(w);
    editor.update(() => { [...editor.getEditorState()._nodeMap.values()].find(each => each.getType() === 'text').select(0, 0); }, { discrete: true });
    await settle();
    assert.equal(label(w), 'Saved');
    assert.deepEqual(posts, [{ url: 'state', body: { dirty: false } }]);
  } });
});

/** Dispatches the Lexical command named `type` to `editor`, as its key would. */
const command = (editor, type) => editor.dispatchCommand([...editor._commands.keys()].find(each => each.type === type), undefined);

test('undoing in the document a cell edit its cell already handed off returns it to saved', { timeout: 30_000 }, async () => {
  await open(TABLE, { act: async (w, posts) => {
    const { element, editor } = await lastCell(w);
    type(editor, ' TYPED');
    await settle();
    // Leaving the cell hands its text to the table, as MDXEditor does itself.
    element.blur();
    await settle();
    assert.equal(label(w), 'Unsaved');
    const root = w.document.querySelector('.mdxeditor-root-contenteditable [data-lexical-editor]').__lexicalEditor;
    command(root, 'UNDO_COMMAND');
    await settle();
    assert.equal(label(w), 'Saved');
    assert.equal(posts.filter(post => post.url === 'state').at(-1).body.dirty, false);
    assert.equal(saves(posts).length, 0);
  } });
});

test('undoing and redoing a saved table edit in the document returns it to saved', { timeout: 30_000 }, async () => {
  await open(TABLE, { act: async (w, posts) => {
    const { editor } = await lastCell(w);
    type(editor, ' TYPED');
    saveKey(w);
    await settle();
    assert.equal(label(w), 'Saved');
    const root = w.document.querySelector('.mdxeditor-root-contenteditable [data-lexical-editor]').__lexicalEditor;
    command(root, 'UNDO_COMMAND');
    await settle();
    assert.equal(label(w), 'Unsaved');
    command(root, 'REDO_COMMAND');
    await settle();
    assert.equal(label(w), 'Saved', 'the cell taking the redone table back is not an edit');
    assert.equal(saves(posts).length, 1);
  } });
});

// Chromium's order, where the composition ends at `compositionend`; WebKit
// defers that to the next keydown.
const CHROMIUM = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

test('a save leaves a table cell mid-composition to the input method, and writes its text once it ends', { timeout: 30_000 }, async () => {
  await open(TABLE, { userAgent: CHROMIUM, act: async (w, posts) => {
    const { element, editor } = await lastCell(w);
    type(editor, ''); // the caret the composition starts at
    element.dispatchEvent(new w.CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    type(editor, ' 漢');
    await settle();
    assert.equal(editor.isComposing(), true);
    saveKey(w);
    await settle();
    assert.equal(editor.isComposing(), true, 'the composition goes on');
    assert.ok(saves(posts).every(text => !text.includes('漢')), 'nothing mid-composition is written');
    assert.equal(label(w), 'Unsaved');
    element.dispatchEvent(new w.CompositionEvent('compositionend', { bubbles: true, data: '漢' }));
    await settle();
    saveKey(w);
    await settle();
    assert.equal(saves(posts).at(-1), TABLE.replace('| 2 |', '| 2 漢 |'));
  } });
});

/** `text` after the word `wrod` in a paragraph before it is fixed and saved;
 * `also` runs in the same update, given the editor's nodes. */
async function fixedAndSaved(text, also) {
  let saved;
  await open(`Intro wrod.\n\n${text}`, { act: async (w, posts) => {
    const root = w.document.querySelector('.mdxeditor-root-contenteditable [data-lexical-editor]').__lexicalEditor;
    root.update(() => {
      const node = [...root.getEditorState()._nodeMap.values()].find(each => each.getType() === 'text' && each.getTextContent() === 'Intro wrod.');
      node.setTextContent('Intro word.');
      also?.([...root.getEditorState()._nodeMap.values()]);
    }, { discrete: true });
    await settle();
    saveKey(w);
    await settle();
    saved = saves(posts).at(-1);
  } });
  return saved;
}

for (const text of [
  '3. third\n4. fourth\n',
  '1. one\n\n```sh\nmake\n```\n\n2. two\n',
  '9. nine\n10. ten\n11. eleven\n',
  '1. a\n2. b\n',
  '- [ ] todo\n- [x] done\n',
  '- a\n  1. one\n  2. two\n- b\n',
]) {
  test(`a save keeps an ordered list's numbering: ${JSON.stringify(text)}`, { timeout: 30_000 }, async () => {
    assert.equal(await fixedAndSaved(text), `Intro word.\n\n${text}`);
  });
}

for (const [text, saved = text] of [
  ['Line one\\\nLine two\n'],
  // A spelling change, not a rendering one: the break stays hard.
  ['Line one  \nLine two\n', 'Line one\\\nLine two\n'],
  ['- line one\\\n  line two\n- next\n'],
  ['Line one\nLine two\n'],
  ['- first para\n\n  second para\n- next\n'],
]) {
  test(`a save keeps hard and soft line breaks: ${JSON.stringify(text)}`, { timeout: 30_000 }, async () => {
    assert.equal(await fixedAndSaved(text), `Intro word.\n\n${saved}`);
  });
}

test('a save keeps a line break that ends its paragraph from writing a literal backslash', { timeout: 30_000 }, async () => {
  // As Shift+Enter at the end of a line leaves it.
  const saved = await fixedAndSaved('Line one\\\nLine two\n', nodes => {
    const lineBreak = nodes.find(each => each.getType() === 'linebreak');
    nodes.find(each => each.getType() === 'text' && each.getTextContent() === 'Line two').insertAfter(new lineBreak.constructor());
  });
  assert.ok(!saved.trimEnd().endsWith('\\'), saved);
  assert.ok(saved.startsWith('Intro word.\n\nLine one\\\nLine two'), saved);
});

// What the rich editor writes must never hold indented code, which decides a
// document under the parse bound, nor look like it could to the scan, which
// decides one past it, or a document it saved would reopen as source.
for (const text of [
  '- a\n  - b\n    - c\n',
  '1. a\n   1. b\n      1. c\n',
  '1. a\n\n   para a\n\n   1. b\n\n      para b\n\n      1. c\n\n         para c\n',
  '- a\n\n  - b\n\n    - c\n\n      para c\n',
  '- first\n\n  second\n- next\n',
  '- item\n\n  ```js\n  x\n      indented in the fence\n  ```\n',
  '- [ ] todo\n- [x] done\n  - [ ] nested\n',
  '| a | b |\n| - | - |\n| 1 | 2 |\n',
  '> - a\n>   - b\n>     - c\n',
  '> quote\n>\n> - a\n>\n>   para\n',
  '# H1\n\n## H2\n\ntext\n',
  'Line one\\\nLine two\n\n- item one\\\n  item two\n',
]) {
  test(`what the rich editor saves reopens rich at any size: ${JSON.stringify(text)}`, { timeout: 30_000 }, async () => {
    const saved = await fixedAndSaved(text);
    assert.ok(saved.startsWith('Intro word.'), saved);
    assert.ok(!parsesIndentedCode(saved), JSON.stringify(saved));
    assert.ok(!mayHoldIndentedCode(saved), JSON.stringify(saved));
  });
}
