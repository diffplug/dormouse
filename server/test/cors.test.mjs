import { test } from 'node:test';
import assert from 'node:assert/strict';

import { API_ROUTES } from 'server-lib-common';
import { ORIGIN, freshApp } from './helpers.mjs';

// A preflight is how a browser asks for the grant, so its 404 is the assertion:
// no OPTIONS handler exists to answer one, on a body-credentialed route or a
// bearer one.
for (const [label, route, method, header] of [
  ['host enrollment', API_ROUTES.hostEnroll, 'POST', 'content-type'],
  ['a bearer route', API_ROUTES.hosts, 'GET', 'authorization'],
]) {
  test(`a foreign preflight for ${label} receives no CORS grant`, async () => {
    const { app } = await freshApp();
    const res = await app.request(route, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:1420',
        'access-control-request-method': method,
        'access-control-request-headers': header,
      },
    });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-methods'), null);
    assert.equal(res.headers.get('access-control-allow-headers'), null);
  });
}

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
