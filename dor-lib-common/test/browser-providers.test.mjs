import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_PROVIDER_IDS, BROWSER_PROVIDERS, parseRenderMode, renderModeFor, sessionForKey } from '../dist/browser-providers.js';

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

test('each provider refuses a session name its CLI would read as an option or a path', () => {
  for (const provider of BROWSER_PROVIDER_IDS) {
    const { isSessionName } = BROWSER_PROVIDERS[provider];
    assert.equal(isSessionName('dormouse.1.default'), true, provider);
    for (const bad of ['../../tmp/evil', 'a/b', 'a\\b', 'a\nb', '', 7]) {
      assert.equal(isSessionName(bad), false, `${provider} ${JSON.stringify(bad)}`);
    }
  }
  // agent-browser takes its session as its own argument, so a leading dash
  // would read as an option; Playwright's rides inside `--session=`.
  for (const option of ['--executable-path', '-x']) assert.equal(BROWSER_PROVIDERS['agent-browser'].isSessionName(option), false);
  // agent-browser takes a user's raw name; Playwright only the names Dormouse mints.
  assert.equal(BROWSER_PROVIDERS['agent-browser'].isSessionName('my session'), true);
  assert.equal(BROWSER_PROVIDERS.playwright.isSessionName('my session'), false);
});
