import { test } from 'node:test';
import assert from 'node:assert/strict';

import { API_ROUTES } from 'server-lib-common';
import { ORIGIN, freshApp } from './helpers.mjs';

test('a foreign Host-enrollment preflight receives no CORS grant', async () => {
  const { app } = await freshApp();
  const res = await app.request(API_ROUTES.hostEnroll, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:1420',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.headers.get('access-control-allow-methods'), null);
  assert.equal(res.headers.get('access-control-allow-headers'), null);
});

test('API responses emit no cross-origin grant', async () => {
  const { app } = await freshApp();
  const res = await app.request(API_ROUTES.signinBegin, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
});

test('a foreign bearer preflight receives no CORS grant', async () => {
  const { app } = await freshApp();
  const res = await app.request(API_ROUTES.hosts, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:1420',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.headers.get('access-control-allow-headers'), null);
});
