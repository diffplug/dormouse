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
// server and its connect-src must not be able to. The one relay origin the
// build reaches is baked into the sidecar bundle by build-sidecar-proxy.mjs
// (docs/specs/relay.md → "Relay origin").
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
// the whole document (docs/specs/layout.md -> "Inline graphics").
// Nothing else exercises this policy: the smoketest never boots a webview.
test('script-src grants WebAssembly compilation and nothing more', () => {
  const scriptSrc = csp
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find((parts) => parts[0] === 'script-src');
  assert.deepEqual(scriptSrc, ['script-src', "'self'", "'wasm-unsafe-eval'"]);
});

// Managed voice plays host-fetched audio from a Blob URL
// (docs/specs/alert.md -> "Spoken alarms"); the webview itself never fetches it.
test('media-src grants Blob URLs and nothing remote', () => {
  const mediaSrc = csp
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find((parts) => parts[0] === 'media-src');
  assert.deepEqual(mediaSrc, ['media-src', "'self'", 'blob:']);
});

// None of these falls back to default-src. No form in the webview submits, no
// `<base>` is wanted, and nothing frames the app; Tauri sends this policy as a
// response header, where `frame-ancestors` applies.
test('the directives without a default-src fallback admit nothing', () => {
  const directives = new Map(csp.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]));
  for (const name of ['base-uri', 'form-action', 'frame-ancestors']) assert.deepEqual(directives.get(name), ["'none'"], name);
});

// xterm appends runtime `<style>` elements and sets `style` attributes with no
// nonce, so it needs `'unsafe-inline'`. A packaged build gives every bundled
// `<style>` element a nonce and adds it to `style-src`, and a source list with
// a nonce ignores `'unsafe-inline'` — unless `style-src` is exempted from that
// rewrite. Neither `tauri dev` nor the browser harness applies this policy.
test("style-src keeps 'unsafe-inline' in a packaged build", () => {
  const styleSrc = csp
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find((parts) => parts[0] === 'style-src');
  assert.ok(styleSrc.includes("'unsafe-inline'"));
  // Named, never `true`: that would also drop the nonces Tauri adds to
  // `script-src`, which carries no `'unsafe-inline'` and relies on them.
  assert.deepEqual(conf.app.security.dangerousDisableAssetCspModification, ['style-src'],
    'Tauri may not add a nonce to style-src, and must keep rewriting every other directive');
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

// Spoken alarms play in the renderer, and a minimized window's throttled or
// suspended webview delayed them (docs/specs/standalone.md -> "Windows"); every
// later window inherits this from the clone. Pinned for the clone by
// `every_window_disables_background_throttling` in src-tauri/src/lib.rs.
test('the first window is never throttled in the background', () => {
  assert.equal(conf.app.windows[0].backgroundThrottling, 'disabled');
});

// Least privilege, and it is what structurally enforces that the update
// install runs in the window the quit walk tears down last
// (docs/specs/auto-update.md).
test('only the first window may check for or install an update', () => {
  const dflt = capability('default');
  const mainOnly = capability('main-only');
  assert.deepEqual(dflt.windows, ['main', 'ws-*'], 'torn-out windows need the AppBar controls');
  assert.deepEqual(mainOnly.windows, ['main']);
  // `core:resources:allow-close` is what `Update.close()` invokes: without it
  // the release of a replaced update handle is a swallowed ACL rejection.
  for (const permission of ['updater:default', 'core:app:allow-version', 'core:resources:allow-close']) {
    assert.ok(mainOnly.permissions.includes(permission), `main-only holds ${permission}`);
    assert.ok(!dflt.permissions.includes(permission), `default does not hold ${permission}`);
  }
});

// Every window close and destroy runs in Rust, behind the close and quit
// interception. A webview able to destroy its own window would skip
// `CloseRequested`, and with it that whole interception. Nothing in the app
// asks for it: the JS API destroys only from `onCloseRequested`, which the app
// does not use.
test('no window may destroy itself', () => {
  for (const name of ['default', 'main-only']) {
    assert.ok(!capability(name).permissions.includes('core:window:allow-destroy'), name);
  }
});

