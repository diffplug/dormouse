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

test('falls back to the build-instructions stub when no Pocket build exists', async () => {
  const { app: hono } = app({ pocketDir: join(tmpdir(), 'dormouse-nonexistent-pocket-dir') });
  const res = await hono.request('/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /build:pocket/);
});
