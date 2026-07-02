import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HELLO_ROUTE } from 'server-lib-common';

import { freshApp } from './helpers.mjs';

test('GET / serves the stub landing page', async () => {
  const { app } = await freshApp();
  const res = await app.request('/');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'Dormouse selfhost server');
});

test(`GET ${HELLO_ROUTE} returns the shared greeting`, async () => {
  const { app } = await freshApp();
  const res = await app.request(HELLO_ROUTE);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { message: 'Hello, world!' });
});
