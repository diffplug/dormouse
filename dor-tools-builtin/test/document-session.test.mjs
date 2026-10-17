import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './bundle.mjs';

// A framed page's globals: the host is the parent window, and the viewer's
// `state` route answers every report.
const listeners = {}, posted = [];
const parent = { postMessage: message => posted.push(message) };
globalThis.window = { parent, addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); } };
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

const { documentPage } = await load('../viewer/document-session.ts');

/** An editor over `held.text`, whose mark is the text itself. */
const textEditor = held => ({
  snapshot: () => ({ content: held.text, mark: held.text }),
  holds: mark => mark === held.text,
  apply(text) { held.text = text; },
});

test('the close-prompt save writes the front document first, so a page document it changes is saved after', async () => {
  const page = documentPage(), writes = [];
  const markdown = { text: '' }, image = { text: '' };
  const doc = page.open(textEditor(markdown), { report() {}, fail() {} }, {
    load: async () => ({ content: '![](a.png){width=100}', version: 'd1', name: 'doc.md' }),
    save: async text => { writes.push(['doc', text]); return { version: 'd2' }; },
  });
  const overlay = page.open(textEditor(image), { report() {}, fail() {} }, {
    load: async () => ({ content: 'pixels', version: 'i1', name: 'a.png' }),
    // Saving the image at half its size rescales the width the page's document states.
    save: async pixels => { writes.push(['image', pixels]); markdown.text = markdown.text.replace('100', '50'); return { version: 'i2' }; },
  });
  await doc.load();
  await overlay.load();
  markdown.text += ' edited';
  image.text = 'half the pixels';
  doc.changed();
  overlay.changed();

  const host = { source: parent, origin: 'http://host' };
  for (const fn of listeners.message) fn({ ...host, data: { dorTool: 1, kind: 'connect', connection: 'c' } });
  for (const fn of listeners.message) fn({ ...host, data: { dorTool: 1, kind: 'save', connection: 'c', request: 'r' } });
  while (!posted.some(m => m.kind === 'saved')) await new Promise(resolve => setTimeout(resolve));

  assert.deepEqual(writes, [['image', 'half the pixels'], ['doc', '![](a.png){width=50} edited']]);
  assert.equal(posted.find(m => m.kind === 'saved').dirty, false, 'nothing is left unsaved');
});
