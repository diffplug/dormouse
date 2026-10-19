import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../dist/cli.js';

test('dor-diagnostics prints the Surface\'s webview and host record as JSON, under either provider, without a native CLI', async () => {
  for (const provider of ['agent-browser', 'playwright']) {
    const calls = [];
    const response = {
      surfaceId: 'surface:72', provider, renderMode: `${provider}-screencast`, session: 's',
      webview: { phase: { k: 'live', stream: 4321 } }, host: { views: [] },
    };
    const options = { client: { browserDiagnostics: async (request) => { calls.push(request); return response; } } };
    const result = await runCli([provider, '--surface', 'surface:72', 'dor-diagnostics'], options);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      surface_id: 'surface:72', provider, render_mode: `${provider}-screencast`, session: 's',
      webview: response.webview, host: response.host,
    });
    assert.deepEqual(calls, [{ provider, surface: 'surface:72' }]);
  }
});

test('dor-diagnostics addresses a key by default, and takes no arguments', async () => {
  const calls = [];
  const options = { client: { browserDiagnostics: async (request) => { calls.push(request); return { surfaceId: 'surface:1', provider: 'agent-browser', renderMode: 'agent-browser-screencast', session: null, webview: null, host: null }; } } };
  assert.equal((await runCli(['agent-browser', 'dor-diagnostics'], options)).exitCode, 0);
  assert.deepEqual(calls, [{ provider: 'agent-browser', key: 'default' }]);
  const extra = await runCli(['agent-browser', 'dor-diagnostics', '--json'], options);
  assert.equal(extra.exitCode, 1);
  assert.match(extra.stderr, /takes no arguments/);
});

test('dor-diagnostics reports the host\'s refusal', async () => {
  const options = { client: { browserDiagnostics: async () => { throw new Error("surface 'surface:9' has no browser (kind: terminal)"); } } };
  const result = await runCli(['agent-browser', '--surface', 'surface:9', 'dor-diagnostics'], options);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /has no browser/);
});
