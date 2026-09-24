// The sidecar's entry wires pty-core to the bundles it requires. These are
// source checks, because loading main.js needs the built bundles and a live
// stdin; each pins one injection whose absence fails silently at runtime.
const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const source = readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('pty-core is created with the shared sliceSince, so recovery capture reads a buffer', () => {
  // Without it `outputSince` answers '' and `captureAgentRecovery` records
  // nothing, with no error anywhere (pty-core.js -> outputSince).
  assert.match(source, /\{\s*captureAgentRecovery,\s*createRecoveryStore,\s*sliceSince\s*\}\s*=\s*require\('\.\/recovery\.cjs'\)/);
  assert.match(source, /nodePty,\s*\{\s*replay:\s*true,\s*sliceSince\s*\}\)/);
});

test('recovery capture and the record take are answered from pty-core marks', () => {
  assert.match(source, /receivedChars:\s*\(id\)\s*=>\s*mgr\.receivedChars\(id\)/);
  assert.match(source, /outputSince:\s*\(id,\s*mark\)\s*=>\s*mgr\.outputSince\(id,\s*mark\)/);
});
