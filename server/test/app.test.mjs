import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HELLO_ROUTE } from 'server-lib-common';

import { freshApp } from './helpers.mjs';

test('GET / serves the stub landing page when the Pocket app is not built', async () => {
  // freshApp configures no `pocketDir`, so this is always the stub (slice 5
  // serves the real Pocket build here when `pocketDir` points at one).
  const { app } = await freshApp();
  const res = await app.request('/');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /^Dormouse selfhost server/);
  assert.match(body, /build:pocket/);
});

test(`GET ${HELLO_ROUTE} returns the shared greeting`, async () => {
  const { app } = await freshApp();
  const res = await app.request(HELLO_ROUTE);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { message: 'Hello, world!' });
});
