import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { load } from './bundle.mjs';

// A framed page's globals: the host is the parent window, and the viewer's
// `state` route answers every report.
const listeners = {}, posted = [];
const parent = { postMessage: message => posted.push(message) };
globalThis.window = { parent, addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); } };
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
const { documentSession } = await load('../viewer/document-session.ts');
beforeEach(() => {
  for (const key of Object.keys(listeners)) delete listeners[key];
  posted.length = 0;
});

const send = data => {
  for (const fn of listeners.message) fn({ source: parent, origin: 'http://host', data: { dorTool: 1, connection: 'c', ...data } });
};
async function reply(kind = 'saved') {
  for (let i = 0; i < 100; i++) {
    const reply = posted.find(m => m.kind === kind);
    if (reply) return reply;
    await setImmediate();
  }
  assert.fail(`host ${kind} request did not answer`);
}
function session(save, position) {
  const held = { text: '' }, errors = [], writes = [];
  const doc = documentSession({
    snapshot: () => ({ content: held.text, mark: held.text }),
    holds: mark => mark === held.text,
    apply(text) { held.text = text; },
  }, { report() {}, fail: error => errors.push(error) }, {
    load: async () => ({ content: 'original', version: 'v1', name: 'doc.md' }),
    save: async (text, version) => { writes.push([text, version]); return save ? save() : { version: 'v2' }; },
  }, position);
  const edit = text => { held.text = text; doc.changed(); };
  return { doc, errors, writes, edit };
}

test('host save and keyboard save write the page document at its current revision', async () => {
  const { doc, writes, edit } = session();
  send({ kind: 'connect' });
  assert.equal(posted.length, 0, 'loading is not reported clean');
  await doc.load();
  edit('first edit');
  assert.equal(posted.at(-1).dirty, true, 'dirty state reaches the host immediately');
  send({ kind: 'save', request: 'r' });
  assert.equal((await reply()).dirty, false);
  assert.deepEqual(writes, [['first edit', 'v1']]);

  edit('second edit');
  let prevented = false;
  for (const fn of listeners.keydown) fn({ ctrlKey: true, key: 's', preventDefault() { prevented = true; } });
  await doc.write(); // joins the keyboard's in-flight save
  assert.equal(prevented, true);
  assert.deepEqual(writes, [['first edit', 'v1'], ['second edit', 'v2']]);
  assert.equal(doc.dirty(), false);
});

test('edits made during a host save remain dirty so navigation cannot discard them', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { doc, edit } = session(() => pending);
  await doc.load();
  edit('saved edit');
  send({ kind: 'connect' });
  send({ kind: 'save', request: 'r' });
  edit('newer edit');
  finish({ version: 'v2' });
  assert.equal((await reply()).dirty, true);
  assert.equal(doc.dirty(), true);
});

test('a failed host save reports its error and leaves the document dirty', async () => {
  const { doc, edit, errors } = session(() => { throw new Error('file changed on disk'); });
  await doc.load();
  edit('unsaved');
  send({ kind: 'connect' });
  send({ kind: 'save', request: 'r' });
  assert.deepEqual(await reply(), { dorTool: 1, connection: 'c', kind: 'saved', request: 'r', dirty: true, error: 'file changed on disk' });
  assert.equal(errors.at(-1), 'file changed on disk');
});

test('the host can restore and read the document position through the same session', async () => {
  let position = { mode: 'rich-text', top: 0 };
  const { doc } = session(undefined, { read: () => position, apply: value => { position = value; } });
  await doc.load();
  send({ kind: 'connect' });
  send({ kind: 'view-apply', request: 'position', position: { mode: 'source', top: 320 } });
  assert.deepEqual((await reply('view')).position, { mode: 'source', top: 320 });
});
