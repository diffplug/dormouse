import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcTauri = join(here, '..', 'src-tauri');
const conf = JSON.parse(readFileSync(join(srcTauri, 'tauri.conf.json'), 'utf8'));
const csp = conf.app.security.csp;
const capability = (name) =>
  JSON.parse(readFileSync(join(srcTauri, 'capabilities', `${name}.json`), 'utf8'));

// The Burrow moved into the sidecar, so the webview never speaks to a relay
// server and its connect-src must not be able to. The allowlist that does apply
// is baked into the sidecar bundle by build-sidecar-proxy.mjs
// (docs/specs/relay.md → "Where a Burrow may reach a Relay").
test('the webview cannot reach a Relay', () => {
  assert.ok(!csp.includes('dormouse.sh'), 'no SaaS relay sources in the webview CSP');
  // Secure by default: no scheme-wide `https:`/`wss:` in connect-src that
  // would let the webview reach an arbitrary internet host.
  assert.ok(!csp.includes(' https:;') && !csp.includes(' https: '), 'no bare https: source');
  assert.ok(!csp.includes(' wss:;') && !csp.includes(' wss: '), 'no bare wss: source');
});

// The inline-image addon compiles a vendored WebAssembly SIXEL decoder at
// Session creation, so this webview needs the WASM grant — and only that one.
// `'unsafe-eval'` would unblock the same decoder while re-enabling `eval` for
// the whole document (docs/specs/terminal-escapes.md -> "Inline graphics").
// Nothing else exercises this policy: the smoketest never boots a webview.
test('script-src grants WebAssembly compilation and nothing more', () => {
  const scriptSrc = csp
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find((parts) => parts[0] === 'script-src');
  assert.deepEqual(scriptSrc, ['script-src', "'self'", "'wasm-unsafe-eval'"]);
});

test('localhost stays allowed for dev and the loopback proxies', () => {
  assert.ok(csp.includes('http://localhost:*') && csp.includes('ws://localhost:*'));
  assert.ok(csp.startsWith("default-src 'self'"));
});

// Every window is cloned from this config (`WebviewWindowBuilder::from_config`),
// and the first one's label is its persistence identity: the snapshot it wrote
// before multi-window shipped is `main.json`, and `restorable_labels` puts
// `main` first (docs/specs/standalone.md -> "Windows").
test('the first window is labelled main', () => {
  assert.equal(conf.app.windows[0].label, 'main');
});

// Least privilege, and it is what structurally enforces that the update
// install runs in the window the quit walk tears down last
// (docs/specs/auto-update.md).
test('only the first window may check for or install an update', () => {
  const dflt = capability('default');
  const mainOnly = capability('main-only');
  assert.deepEqual(dflt.windows, ['main', 'ws-*'], 'torn-out windows need the AppBar controls');
  assert.deepEqual(mainOnly.windows, ['main']);
  for (const permission of ['updater:default', 'core:app:allow-version']) {
    assert.ok(mainOnly.permissions.includes(permission), `main-only holds ${permission}`);
    assert.ok(!dflt.permissions.includes(permission), `default does not hold ${permission}`);
  }
});
