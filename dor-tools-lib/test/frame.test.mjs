import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectToolFrame } from '../dist/frame.js';

/** A frame's window: its parent records posts, and `deliver` plays a message event. */
function scope() {
  const window = new EventTarget();
  const posted = [];
  window.parent = { postMessage: (message, origin) => posted.push({ message, origin }) };
  window.deliver = (data, { origin = 'http://host.test', source = window.parent } = {}) =>
    window.dispatchEvent(Object.assign(new Event('message'), { data, origin, source }));
  return { window, posted };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('reports nothing until the host connects, then answers at the connecting origin', () => {
  const { window, posted } = scope();
  let dirty;
  const frame = connectToolFrame({ dirty: () => dirty, save: async () => {} }, window);
  frame.report();
  window.deliver({ dorTool: 1, kind: 'connect', connection: 'c1' });
  assert.deepEqual(posted, [], 'still loading');
  dirty = true;
  frame.report();
  assert.deepEqual(posted, [{ message: { dorTool: 1, connection: 'c1', kind: 'state', dirty: true }, origin: 'http://host.test' }]);
  window.deliver({ dorTool: 1, kind: 'connect', connection: 'c2' }, { origin: 'http://other.test' });
  assert.deepEqual(posted.at(-1), { message: { dorTool: 1, connection: 'c2', kind: 'ready', dirty: true }, origin: 'http://other.test' });
});

test('accepts only its parent, and saves only for the current connection and origin', async () => {
  const { window, posted } = scope();
  let saves = 0;
  let dirty = true;
  connectToolFrame({ dirty: () => dirty, save: async () => { saves++; dirty = false; } }, window);
  window.deliver({ dorTool: 1, kind: 'connect', connection: 'c' }, { source: {} });
  assert.equal(posted.length, 0);
  window.deliver({ dorTool: 1, kind: 'connect', connection: 'c' });
  window.deliver({ dorTool: 1, kind: 'save', connection: 'old', request: '1' });
  window.deliver({ dorTool: 1, kind: 'save', connection: 'c', request: '1' }, { origin: 'http://elsewhere.test' });
  await settle();
  assert.equal(saves, 0);
  window.deliver({ dorTool: 1, kind: 'save', connection: 'c', request: '2' });
  await settle();
  assert.equal(saves, 1);
  assert.deepEqual(posted.at(-1).message, { dorTool: 1, connection: 'c', kind: 'saved', request: '2', dirty: false });
});

test('a failed save settles the request with its error and the current dirty state', async () => {
  const { window, posted } = scope();
  connectToolFrame({ dirty: () => true, save: async () => { throw new Error('Changed on disk'); } }, window);
  window.deliver({ dorTool: 1, kind: 'connect', connection: 'c' });
  window.deliver({ dorTool: 1, kind: 'save', connection: 'c', request: '7' });
  await settle();
  assert.deepEqual(posted.at(-1).message, { dorTool: 1, connection: 'c', kind: 'saved', request: '7', error: 'Changed on disk', dirty: true });
});

test('close stops answering', () => {
  const { window, posted } = scope();
  const frame = connectToolFrame({ dirty: () => false, save: async () => {} }, window);
  window.deliver({ dorTool: 1, kind: 'connect', connection: 'c' });
  frame.close();
  frame.report();
  window.deliver({ dorTool: 1, kind: 'connect', connection: 'd' });
  assert.equal(posted.length, 1);
});
