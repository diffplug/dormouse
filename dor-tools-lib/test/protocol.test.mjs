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

test('frame messages: each carries a boolean dirty state; a save error is sanitized for display', () => {
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
