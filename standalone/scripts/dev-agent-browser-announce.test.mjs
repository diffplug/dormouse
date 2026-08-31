// The harness's OSC 367 announcement (docs/specs/dor-tool.md -> OSC 367).
// Pinned here rather than eyeballed: the sequence is invisible in a terminal,
// so a typo in the escape framing would fail silently — the harness would keep
// working and Dormouse would simply frame the wrong port, or none.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./dev-agent-browser.mjs', import.meta.url)), 'utf-8');

test('the harness writes an OSC 367 serve naming its vite port', () => {
  // ESC ] 367 ; serve ; <json> ESC \ — matched as source text, since the write
  // happens only when the harness boots a real vite.
  const emitted = source.match(
    /process\.stdout\.write\(\s*`\\u001b\]367;serve;\$\{JSON\.stringify\((.*?)\)\}\\u001b\\\\`,?\s*\)/s,
  );
  assert.ok(emitted, 'expected a `process.stdout.write` of an OSC 367 serve payload');

  const payload = JSON.parse(JSON.stringify(eval(`(${emitted[1].replace('vitePort', '1420')})`)));
  assert.equal(payload.port, 1420, 'must announce the vite port it chose');
  assert.equal(payload.v, 1, 'must carry the contract version');
});
