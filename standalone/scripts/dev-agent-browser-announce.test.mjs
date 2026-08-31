// The harness's OSC 367 announcement (docs/specs/dor-tool.md -> OSC 367).
// Pinned here rather than eyeballed: the sequence is invisible in a terminal,
// so a typo in the escape framing would fail silently — the harness would keep
// working and Dormouse would simply frame the wrong port, or none.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./dev-agent-browser.mjs', import.meta.url)), 'utf-8');
const ESC = '';

test('the harness announces its vite port as an OSC 367 serve', () => {
  const template = source.match(/`\\u001b\]367;serve;\$\{JSON\.stringify\(([^)]*)\)\}\\u001b\\\\`/);
  assert.ok(template, 'expected an OSC 367 serve template literal');

  // Rebuild the payload the template interpolates, with a stand-in port.
  const vitePort = 1420;
  const payload = JSON.parse(
    JSON.stringify(eval(`(${template[1].replace('vitePort', String(vitePort))})`)),
  );
  assert.equal(payload.port, vitePort, 'must announce the vite port it chose');
  assert.equal(payload.v, 1, 'must carry the contract version');

  // ...and the framing: ESC ] 367 ; serve ; <json> ESC \
  const emitted = `${ESC}]367;serve;${JSON.stringify(payload)}${ESC}\\`;
  assert.equal(emitted.slice(0, 12), `${ESC}]367;serve;`);
  assert.equal(emitted.slice(-2), `${ESC}\\`);
});

test('the announcement is emitted, not merely defined', () => {
  assert.match(source, /process\.stdout\.write\(\s*`\\u001b\]367;serve;/);
});
