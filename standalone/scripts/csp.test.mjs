import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DEFAULT_REMOTE_CONNECT_SRC, withRemoteConnectSrc } from './csp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const conf = JSON.parse(readFileSync(join(here, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
const csp = conf.app.security.csp;

test('the shipped default CSP is scoped to the SaaS origin', () => {
  assert.ok(csp.includes(DEFAULT_REMOTE_CONNECT_SRC), 'default remote sources present');
  // Secure by default: no scheme-wide `https:`/`wss:` in connect-src that
  // would let the webview reach an arbitrary internet host.
  assert.ok(!csp.includes(' https:;') && !csp.includes(' https: '), 'no bare https: source');
  assert.ok(!csp.includes(' wss:;') && !csp.includes(' wss: '), 'no bare wss: source');
  // Localhost stays allowed (dev + local self-host server).
  assert.ok(csp.includes('http://localhost:*') && csp.includes('ws://localhost:*'));
});

test('withRemoteConnectSrc retargets the remote sources', () => {
  const out = withRemoteConnectSrc(csp, 'https://dormouse.example.com wss://dormouse.example.com');
  assert.ok(out.includes('https://dormouse.example.com wss://dormouse.example.com'));
  assert.ok(!out.includes('dormouse.sh'), 'default SaaS sources replaced');
  // Everything else (localhost, ipc, directives) is untouched.
  assert.ok(out.includes('http://localhost:*') && out.startsWith("default-src 'self'"));
});

test('withRemoteConnectSrc trims whitespace from the env value', () => {
  const out = withRemoteConnectSrc(csp, '  https://a wss://a\n');
  assert.ok(out.includes('https://a wss://a'));
  assert.ok(!out.includes('https://a wss://a\n'));
});

test('withRemoteConnectSrc throws when the base CSP has drifted', () => {
  assert.throws(
    () => withRemoteConnectSrc("connect-src 'self' https:;", 'https://x'),
    /tauri\.conf\.json changed/,
  );
});
