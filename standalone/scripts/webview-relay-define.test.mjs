import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';

// The webview reads its relay mode on its own (`bakedRelayMode`), so `vite
// build` must fail when the define misses a chunk, as the sidecar build does
// (docs/specs/relay.md → "Relay origin").
test('vite build asserts the relay define reached the webview', async () => {
  const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, configFile, undefined, 'silent');
  const plugin = loaded.config.plugins.flat().find((p) => p?.name === 'dormouse:assert-relay-define');
  assert.ok(plugin, 'standalone/vite.config.ts registers relayDefineVitePlugin');
  const chunk = (code) => ({ 'index.js': { type: 'chunk', fileName: 'index.js', code } });
  assert.throws(() => plugin.generateBundle({}, chunk('typeof __DORMOUSE_RELAY_MODE__')), /survived/);
  assert.doesNotThrow(() => plugin.generateBundle({}, chunk('"self-host"')));
});
