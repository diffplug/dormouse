import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HELLO_ROUTE } from 'server-lib-common';

import { app } from '../dist/app.js';

test('GET / returns the Hono hello-world', async () => {
  const res = await app.request('/');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'Hello from Hono!');
});

test(`GET ${HELLO_ROUTE} returns the shared greeting`, async () => {
  const res = await app.request(HELLO_ROUTE);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { message: 'Hello, world!' });
});
