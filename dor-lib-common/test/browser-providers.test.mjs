import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_PROVIDER_IDS, parseRenderMode, parseStreamPort, renderModeFor, sessionForKey } from '../dist/index.js';

test('sessionForKey namespaces a key under the workspace', () => {
  assert.equal(sessionForKey('default'), 'dormouse.1.default');
  assert.equal(sessionForKey('gui-abc'), 'dormouse.1.gui-abc');
  assert.equal(sessionForKey('default', 'workspace-2b1c'), 'dormouse.workspace-2b1c.default');
});

test('sessionForKey scrubs the key like the scope: a session name is a socket path', () => {
  // The key crosses the control socket from any client, not only `dor` (which
  // rejects this shape itself), so it cannot be allowed to escape the socket dir.
  assert.equal(sessionForKey('../../../tmp/x', 'ws/1'), 'dormouse.ws-1...-..-..-tmp-x');
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

test('parseRenderMode decodes every automated mode and renderModeFor inverts it', () => {
  for (const provider of BROWSER_PROVIDER_IDS) {
    for (const presentation of ['screencast', 'popout']) {
      const mode = renderModeFor(provider, presentation);
      assert.deepEqual(parseRenderMode(mode), { provider, presentation, mode });
    }
  }
  assert.equal(renderModeFor('agent-browser', 'screencast'), 'ab-screencast');
  assert.equal(renderModeFor('playwright', 'popout'), 'pw-popout');
});

test('parseRenderMode reads anything else as the embed, inherited names included', () => {
  for (const mode of ['iframe', undefined, null, 'constructor', 'toString', 'ab-', 7]) {
    assert.deepEqual(parseRenderMode(mode), { provider: null, presentation: 'iframe', mode: 'iframe' });
  }
});
