import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const conf = JSON.parse(readFileSync(join(here, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
const csp = conf.app.security.csp;

// The remote Host moved into the sidecar, so the webview never speaks to a relay
// server and its connect-src must not be able to. The allowlist that does apply
// is baked into the sidecar bundle by build-sidecar-proxy.mjs
// (docs/specs/server.md → "Where a Host may reach a relay server").
test('the webview cannot reach a relay server', () => {
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
