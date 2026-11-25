import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFrameMessage, readHostMessage } from '../dist/protocol.js';

test('host messages: connect and save, at this version only', () => {
  assert.deepEqual(readHostMessage({ dorTool: 1, kind: 'connect', connection: 'c' }), { dorTool: 1, kind: 'connect', connection: 'c' });
  assert.deepEqual(readHostMessage({ dorTool: 1, kind: 'save', connection: 'c', request: '1', extra: true }), { dorTool: 1, kind: 'save', connection: 'c', request: '1' });
  for (const data of [null, [], 'connect', { kind: 'connect', connection: 'c' }, { dorTool: 2, kind: 'connect', connection: 'c' },
    { dorTool: 1, kind: 'connect', connection: '' }, { dorTool: 1, kind: 'connect', connection: 'x'.repeat(129) },
    { dorTool: 1, kind: 'save', connection: 'c' }, { dorTool: 1, kind: 'ready', connection: 'c', dirty: true }]) {
    assert.equal(readHostMessage(data), null, JSON.stringify(data));
  }
});

test('save-channel frame messages: each carries a boolean dirty state; a save error is sanitized for display', () => {
  assert.deepEqual(readFrameMessage({ dorTool: 1, kind: 'ready', connection: 'c', dirty: true }), { dorTool: 1, kind: 'ready', connection: 'c', dirty: true });
  assert.deepEqual(readFrameMessage({ dorTool: 1, kind: 'saved', connection: 'c', request: '1', dirty: false }), { dorTool: 1, kind: 'saved', connection: 'c', request: '1', dirty: false });
  assert.equal(readFrameMessage({ dorTool: 1, kind: 'saved', connection: 'c', request: '1', dirty: true, error: 'Changed\x1b[31m on\n disk' }).error, 'Changed [31m on disk');
  assert.equal(readFrameMessage({ dorTool: 1, kind: 'saved', connection: 'c', request: '1', dirty: true, error: 'x'.repeat(5000) }).error.length, 1000);
  assert.equal(readFrameMessage({ dorTool: 1, kind: 'saved', connection: 'c', request: '1', dirty: true, error: '\n' }).error, 'Save failed.');
  for (const data of [{ dorTool: 1, kind: 'state', connection: 'c' }, { dorTool: 1, kind: 'state', connection: 'c', dirty: 'true' },
    { dorTool: 1, kind: 'saved', connection: 'c', dirty: true }, { dorTool: 1, kind: 'connect', connection: 'c', dirty: true },
    { __dormouse: 'editor', kind: 'state', connection: 'c', dirty: true }]) {
    assert.equal(readFrameMessage(data), null, JSON.stringify(data));
  }
});

test('reading-position messages: a malformed position drops the message; a view error is sanitized for display', () => {
  assert.deepEqual(readHostMessage({ dorTool: 1, kind: 'view-read', connection: 'c', request: '1', position: { top: 1 } }), { dorTool: 1, kind: 'view-read', connection: 'c', request: '1' });
  assert.deepEqual(readHostMessage({ dorTool: 1, kind: 'view-apply', connection: 'c', request: '1', position: { mode: 'source', top: 7, extra: true } }),
    { dorTool: 1, kind: 'view-apply', connection: 'c', request: '1', position: { mode: 'source', top: 7 } });
  for (const position of [undefined, null, { mode: 'raw' }, { top: -1 }, { top: Infinity }, { top: '7' }, { top: 1e10 }]) {
    assert.equal(readHostMessage({ dorTool: 1, kind: 'view-apply', connection: 'c', request: '1', position }), null, JSON.stringify(position));
  }
  assert.equal(readHostMessage({ dorTool: 1, kind: 'view-read', connection: 'c' }), null);

  assert.deepEqual(readFrameMessage({ dorTool: 1, kind: 'view', connection: 'c', request: '1', position: { top: 3 }, dirty: true }),
    { dorTool: 1, kind: 'view', connection: 'c', request: '1', position: { top: 3 } });
  assert.deepEqual(readFrameMessage({ dorTool: 1, kind: 'view', connection: 'c', request: '1' }), { dorTool: 1, kind: 'view', connection: 'c', request: '1' });
  assert.equal(readFrameMessage({ dorTool: 1, kind: 'view', connection: 'c', request: '1', position: { mode: 'raw' } }), null);
  assert.equal(readFrameMessage({ dorTool: 1, kind: 'view', connection: 'c', position: { top: 3 } }), null);
  assert.equal(readFrameMessage({ dorTool: 1, kind: 'view', connection: 'c', request: '1', error: 'Lost\x1b[31m\n it' }).error, 'Lost [31m it');
  assert.equal(readFrameMessage({ dorTool: 1, kind: 'view', connection: 'c', request: '1', error: '\n' }).error, 'Reading position unavailable.');
});
