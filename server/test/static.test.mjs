/**
 * Slice 5: the server serves the built Pocket app statically at `/*`, while the
 * API and `/ws` routes keep precedence. The build itself is not needed here —
 * a temp dir with an `index.html` stands in for `lib/dist-pocket`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../dist/app.js';

const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'http://localhost:3000';

async function makePocketDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dormouse-pocket-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Pocket</title><div id=pocket-root></div>');
  await writeFile(join(dir, 'app.js'), 'console.log("pocket");');
  // Mirrors the real build's two kinds: `public/` passthroughs at the root and
  // Vite's content-hashed output under `assets/`.
  await writeFile(join(dir, 'sw.js'), 'self.addEventListener("push", () => {});');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'index-Cv4RGHv-.js'), 'export default 1;');
  return dir;
}

function app(config = {}) {
  return createApp({ setupPassword: PASSWORD, origin: ORIGIN, stateDir: config.stateDir ?? '.', ...config });
}

test('serves index.html at / when the Pocket build is present', async () => {
  const { app: hono } = app({ pocketDir: await makePocketDir() });
  const res = await hono.request('/');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /pocket-root/);
});

test('serves built asset files', async () => {
  const { app: hono } = app({ pocketDir: await makePocketDir() });
  const res = await hono.request('/app.js');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /console\.log/);
});

test('SPA fallback returns index.html for an unknown non-file path', async () => {
  const { app: hono } = app({ pocketDir: await makePocketDir() });
  const res = await hono.request('/some/deep/link');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /pocket-root/);
});

test('API routes still win over static serving', async () => {
  const { app: hono } = app({ pocketDir: await makePocketDir() });
  // No bearer token → the session-gated API route answers, not the static app.
  const res = await hono.request('/api/hosts');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'unauthorized');
});

test('a content-hashed asset may be cached forever', async () => {
  const { app: hono } = app({ pocketDir: await makePocketDir() });
  const res = await hono.request('/assets/index-Cv4RGHv-.js');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
});

test('the unhashed shell is revalidated instead', async () => {
  // `emptyOutDir` deletes the previous build's hashed assets, so a cached
  // index.html would not serve stale code — it would request files that no
  // longer exist. The worker and the SPA fallback answer the same way.
  const { app: hono } = app({ pocketDir: await makePocketDir() });
  for (const path of ['/', '/sw.js', '/some/deep/link']) {
    const res = await hono.request(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('cache-control'), 'no-cache', path);
  }
});

test('a hashed asset that no longer exists 404s instead of being answered with the shell', async () => {
  // `emptyOutDir` deletes the previous build's assets, so a client mid-deploy
  // can ask for one that is gone. Answering with the shell would store an HTML
  // body under that URL — and under the immutable class, where no reload could
  // revalidate it away, so an unchanged chunk keeping its hash across builds
  // would serve the poisoned entry forever.
  const { app: hono } = app({ pocketDir: await makePocketDir() });
  const res = await hono.request('/assets/index-DELETED.js');

  assert.equal(res.status, 404);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.doesNotMatch(await res.text(), /pocket-root/);
});

test('falls back to the build-instructions stub when no Pocket build exists', async () => {
  const { app: hono } = app({ pocketDir: join(tmpdir(), 'dormouse-nonexistent-pocket-dir') });
  const res = await hono.request('/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /build:pocket/);
});

// --- Content-Security-Policy -----------------------------------------------
// The Pocket origin holds a per-Host Client static and the worker that opens
// sealed pushes, and `SECURITY.md` names active XSS here as an accepted risk —
// so the policy is the defense in depth around it
// (docs/specs/pocket-app.md -> Deployment).

/** The header, split into `directive -> sources` for readable assertions. */
function policyOf(res) {
  const header = res.headers.get('content-security-policy');
  assert.ok(header, 'no Content-Security-Policy header');
  return Object.fromEntries(
    header.split(';').map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

test('every Pocket response carries the policy — shell, asset, and SPA fallback', async () => {
  const { app: hono } = app({ pocketDir: await makePocketDir() });
  for (const path of ['/', '/app.js', '/assets/index-Cv4RGHv-.js', '/sw.js', '/some/deep/link']) {
    const res = await hono.request(path);
    assert.equal(res.status, 200, path);
    assert.ok(res.headers.get('content-security-policy'), `no policy on ${path}`);
  }
});

test('the policy is same-origin everywhere, and unframeable', async () => {
  const { app: hono } = app({ pocketDir: await makePocketDir() });
  const policy = policyOf(await hono.request('/'));

  // No exception for scripts: the build emits none inline and loads nothing
  // off-origin, which the built-output case below pins.
  assert.deepEqual(policy['script-src'], ["'self'"]);
  assert.deepEqual(policy['default-src'], ["'self'"]);
  assert.deepEqual(policy['worker-src'], ["'self'"]);
  assert.deepEqual(policy['object-src'], ["'none'"]);
  assert.deepEqual(policy['frame-ancestors'], ["'none'"]);
  assert.deepEqual(policy['base-uri'], ["'none'"]);
  assert.deepEqual(policy['form-action'], ["'self'"]);
  // The one loosening: the shell's pre-paint `<style>` and React's own style
  // attributes. A hash covers the first but not the second.
  assert.deepEqual(policy['style-src'], ["'self'", "'unsafe-inline'"]);
});

test('connect-src names this deployment own relay and no other host', async () => {
  // `'self'` alone leaves ws/wss to browsers that have disagreed about whether
  // it covers them, and a bare `ws:` would admit every host on the network.
  for (const [origin, expected] of [
    ['https://dormouse.tailnet.ts.net', 'wss://dormouse.tailnet.ts.net'],
    ['http://localhost:3000', 'ws://localhost:3000'],
  ]) {
    const { app: hono } = app({ origin, pocketDir: await makePocketDir() });
    const policy = policyOf(await hono.request('/'));
    assert.deepEqual(policy['connect-src'], ["'self'", expected], origin);
  }
});

// The other half of `script-src 'self'` — that the BUILT shell carries no inline
// script and nothing off-origin — is asserted by `lib/scripts/assert-pocket-worker.mjs`
// inside `build:pocket`, because no test suite builds the app first.
