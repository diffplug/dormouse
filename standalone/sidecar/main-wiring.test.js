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
  assert.match(source, /nodePty,\s*\{\s*replay:\s*true,\s*sliceSince\b/);
});

test('recovery capture and the record take are answered from pty-core marks', () => {
  assert.match(source, /receivedChars:\s*\(id\)\s*=>\s*mgr\.receivedChars\(id\)/);
  assert.match(source, /outputSince:\s*\(id,\s*mark\)\s*=>\s*mgr\.outputSince\(id,\s*mark\)/);
  // Widens each target before its first press (recovery-capture.ts -> RECOVERY_SIZE).
  assert.match(source, /resize:\s*\(id,\s*cols,\s*rows\)\s*=>\s*mgr\.resize\(id,\s*cols,\s*rows\)/);
});

test('iframe leases are owned by the window Rust stamps, and end with it', () => {
  // docs/specs/dor-browser.md -> "Iframe Proxy Leases": without these a closed
  // window's grants would listen until quit.
  assert.match(source, /lease:\s*data\.lease/);
  assert.match(source, /case 'iframe:releaseProxy':[\s\S]*?releaseIframeProxyLease\(data\.owner/);
  assert.match(source, /event === 'burrow:windows'[\s\S]*?retainIframeProxyOwners\(/);
});
