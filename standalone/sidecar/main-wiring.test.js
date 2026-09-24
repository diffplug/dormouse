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

// The sidecar's one AlertManager (docs/specs/standalone.md -> "Alerts"). Each
// check below pins a call whose absence would fail silently: a window would
// render stale rings, or ring on its own typing.
const handler = (event) => {
  const start = source.indexOf(`case '${event}':`);
  assert.ok(start >= 0, `main.js handles ${event}`);
  const end = source.indexOf('case ', start + 6);
  return source.slice(start, end);
};

test('the Burrow parse feeds the same manager the alert commands drive', () => {
  assert.match(source, /const alerts = createSidecarAlerts\(\{ send \}\)/);
  assert.match(source, /createSidecarBurrow\(\{[^}]*alerts: alerts\.manager,[^}]*\}\)/);
  assert.match(handler('alert:command'), /alerts\.handle\(data\)/);
});

test('human input is acknowledged in its own write message, before the write', () => {
  const body = handler('pty:input');
  const ack = body.indexOf('alerts.acknowledgeInput(data.id)');
  assert.ok(ack >= 0 && ack < body.indexOf('mgr.write('), 'acknowledged before mgr.write');
  assert.match(body, /data\.userInput === true/);
});

test('a window collecting its PTYs gets their alert state behind the list', () => {
  const body = handler('pty:requestInit');
  const publish = body.indexOf('alerts.publish(data?.ids)');
  assert.ok(publish > body.indexOf('mgr.list('), 'published after the list');
});

test('helpers mirror pty-core at spawn and promotion, and closed windows stop being viewers', () => {
  const spawn = handler('pty:spawn');
  assert.ok(spawn.indexOf('alerts.setHelper(data.id, mgr.isHelper(data.id))') > spawn.indexOf('mgr.spawn('));
  assert.match(handler('pty:context'), /data\.op === 'promote'\) alerts\.setHelper\(data\.id, mgr\.isHelper\(data\.id\)\)/);
  assert.match(handler('burrow:windows'), /alerts\.setWindows\(data\?\.labels\)/);
});
