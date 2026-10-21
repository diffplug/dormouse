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
function session(save, position, read, afterApply) {
  const held = { text: '' }, errors = [], writes = [];
  const doc = documentSession({
    snapshot: () => ({ content: held.text, mark: held.text }),
    holds: mark => mark === held.text,
    apply(text) { held.text = text; afterApply?.(); },
  }, { report() {}, fail: error => errors.push(error) }, {
    load: () => read ? read() : Promise.resolve({ content: 'original', version: 'v1', name: 'doc.md' }),
    save: async (text, version) => { writes.push([text, version]); return save ? save() : { version: 'v2' }; },
  }, position);
  const edit = text => { held.text = text; doc.changed(); };
  return { doc, errors, writes, edit, held };
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

for (const saveWhileLoading of [false, true]) {
  test('reload preserves edits made while disk is being read' + (saveWhileLoading ? ', even if saved' : ''), async () => {
    const gate = Promise.withResolvers();
    let reads = 0;
    const { doc, edit, held, errors, writes } = session(undefined, undefined, () => ++reads === 1
      ? Promise.resolve({ content: 'original', version: 'v1', name: 'doc.md' }) : gate.promise);
    await doc.load();
    const reloading = doc.reload();
    edit('new edit');
    if (saveWhileLoading) await doc.write();
    gate.resolve({ content: 'old disk snapshot', version: 'v1', name: 'doc.md' });
    await reloading;
    assert.equal(held.text, 'new edit');
    assert.equal(doc.dirty(), !saveWhileLoading);
    assert.match(errors.at(-1), /changed.*reload/i);
    edit('later edit');
    await doc.write();
    assert.deepEqual(writes.at(-1), ['later edit', saveWhileLoading ? 'v2' : 'v1']);
  });
}

test('repeated reloads share one read instead of applying stale responses out of order', async () => {
  const gate = Promise.withResolvers();
  let reads = 0;
  const { doc, held } = session(undefined, undefined, () => ++reads === 1
    ? Promise.resolve({ content: 'original', version: 'v1', name: 'doc.md' }) : gate.promise);
  await doc.load();
  const first = doc.reload();
  const second = doc.reload();
  assert.equal(reads, 2);
  gate.resolve({ content: 'fresh', version: 'fresh-version', name: 'doc.md' });
  await Promise.all([first, second]);
  assert.equal(held.text, 'fresh');
  assert.equal(doc.dirty(), false);
});

for (const answer of ['cancel', 'discard']) {
  test('concurrent dirty reloads share one discard prompt: ' + answer, async () => {
    let close;
    let shown = 0;
    const dialog = { returnValue: '', addEventListener: (_name, fn) => { close = fn; }, showModal: () => { shown++; } };
    globalThis.document = { getElementById: () => dialog };
    const { doc, edit, held } = session();
    await doc.load();
    edit('unsaved');
    const first = doc.reload(), second = doc.reload();
    assert.equal(shown, 1);
    dialog.returnValue = answer;
    close();
    await Promise.all([first, second]);
    assert.equal(held.text, answer === 'discard' ? 'original' : 'unsaved');
    assert.equal(doc.dirty(), answer === 'cancel');
  });
}

test('edits immediately after applying a reload are never rebased as saved', async () => {
  let applies = 0;
  const { doc, edit, held } = session(undefined, undefined, undefined, () => {
    if (++applies > 1) queueMicrotask(() => edit('edit after reload'));
  });
  await doc.load();
  await doc.reload();
  assert.equal(held.text, 'edit after reload');
  assert.equal(doc.dirty(), true);
});
