import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeInputEvents, validateInputEvents } from '../dist/input-events.js';

test('cursor keys use the terminal mode while literal text and other keys stay unchanged', () => {
  const events = [{ text: '\x1b[A' }, { key: 'up' }, { key: 'tab' }];
  assert.equal(validateInputEvents(events).ok, true);
  assert.deepEqual(encodeInputEvents(events, true), [{ kind: 'text', data: '\x1b[A' }, { kind: 'key', data: '\x1bOA' }, { kind: 'key', data: '\t' }]);
  assert.equal(encodeInputEvents(events, false)[1].data, '\x1b[A');
});
