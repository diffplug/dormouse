import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStreamPort, sessionForKey } from '../dist/index.js';

test('sessionForKey namespaces a key under the workspace', () => {
  assert.equal(sessionForKey('default'), 'dormouse.1.default');
  assert.equal(sessionForKey('gui-abc'), 'dormouse.1.gui-abc');
  assert.equal(sessionForKey('default', 'workspace-2b1c'), 'dormouse.workspace-2b1c.default');
});

test('sessionForKey scrubs the key like the scope: a session name is a socket path', () => {
  // The key crosses the control socket from any client, not only `dor` (which
  // rejects this shape itself), so it cannot be allowed to escape the socket dir.
  assert.equal(sessionForKey('../../../tmp/x', 'ws/1'), 'dormouse.ws-1.-.-.-.-tmp-x');
  // A valid key is unchanged.
  assert.equal(sessionForKey('a.b_c-D9', 'ws'), 'dormouse.ws.a.b_c-D9');
});

test('parseStreamPort reads a top-level port', () => {
  assert.equal(parseStreamPort(JSON.stringify({ port: 61218 })), 61218);
});

test('parseStreamPort reads a nested data.port', () => {
  assert.equal(parseStreamPort(JSON.stringify({ data: { port: 5173 } })), 5173);
});

test('parseStreamPort returns undefined for malformed or portless output', () => {
  assert.equal(parseStreamPort('not json'), undefined);
  assert.equal(parseStreamPort(JSON.stringify({ data: {} })), undefined);
  assert.equal(parseStreamPort(JSON.stringify({ port: 'nope' })), undefined);
});
