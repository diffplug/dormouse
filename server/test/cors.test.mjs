import { test } from 'node:test';
import assert from 'node:assert/strict';

import { API_ROUTES } from 'server-lib-common';
import { freshApp } from './helpers.mjs';

// The standalone webview (Host) enrolls from a different origin than the
// server, so the JSON POST triggers a CORS preflight. Without an OPTIONS
// handler the preflight 404s and the fetch never happens.
test('preflight for host enrollment succeeds cross-origin', async () => {
  const { app } = await freshApp();
  const res = await app.request(API_ROUTES.hostEnroll, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:1420',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /content-type/i);
});

test('cross-origin API responses carry the allow-origin header', async () => {
  const { app } = await freshApp();
  const res = await app.request(API_ROUTES.signinBegin, {
    method: 'POST',
    headers: { origin: 'http://localhost:1420', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('bearer-authed routes allow the Authorization header in preflight', async () => {
  const { app } = await freshApp();
  const res = await app.request(API_ROUTES.hosts, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:1420',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /authorization/i);
});
