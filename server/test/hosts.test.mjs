/**
 * Slice-2 host enrollment and presence (docs/specs/server.md, "Relay & host
 * enrollment"): the password-gated `POST /api/host/enroll`, the session-gated
 * `GET /api/hosts` presence flag, and WS token rejection on both relay routes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { API_ROUTES, WS_ROUTES, WS_TOKEN_PARAM } from 'server-lib-common';

import {
  RP_ID,
  connectHost,
  enrollHost,
  freshApp,
  ownerSession,
  post,
  startServer,
  until,
  wsConnect,
} from './helpers.mjs';

/** GET /api/hosts as the owner; returns the parsed body. */
async function listHosts(app, sessionToken) {
  const res = await app.request(API_ROUTES.hosts, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  return { res, body: await res.json() };
}

test('enroll happy path returns host credentials and policy', async () => {
  const { app, origin } = await freshApp();
  const { res, body } = await enrollHost(app, { label: 'MacBook' });
  assert.equal(res.status, 200);
  assert.equal(typeof body.hostId, 'string');
  assert.equal(typeof body.hostToken, 'string');
  assert.notEqual(body.hostId, body.hostToken);
  assert.equal(body.origin, origin);
  assert.equal(body.rpId, RP_ID);
});

test('enroll rejects a wrong password', async () => {
  const { app } = await freshApp();
  const res = await post(app, API_ROUTES.hostEnroll, { password: 'wrong', label: 'x' });
  assert.equal(res.status, 401);
});

test('a second enrollment appends and gets distinct credentials', async () => {
  const { app } = await freshApp();
  const { body: a } = await enrollHost(app);
  const { body: b } = await enrollHost(app);
  assert.notEqual(a.hostId, b.hostId);
  assert.notEqual(a.hostToken, b.hostToken);

  const { sessionToken } = await ownerSession(app);
  const { body } = await listHosts(app, sessionToken);
  assert.equal(body.hosts.length, 2);
});

test('hosts.json is owner-only, since it stores hostToken in plaintext', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX file modes only');
  const { app, stateDir } = await freshApp();
  await enrollHost(app);
  const { mode } = await stat(join(stateDir, 'hosts.json'));
  assert.equal(mode & 0o777, 0o600);
});

test('GET /api/hosts requires a session', async () => {
  const { app } = await freshApp();
  assert.equal((await app.request(API_ROUTES.hosts)).status, 401);
});

test('GET /api/hosts online flag flips with the host socket', async () => {
  const created = await freshApp();
  const { app } = created;
  const server = await startServer(created);
  try {
    const { sessionToken } = await ownerSession(app);

    const enrolled = await enrollHost(app, { label: 'Laptop' });
    const hostId = enrolled.body.hostId;

    let listed = (await listHosts(app, sessionToken)).body.hosts;
    assert.deepEqual(listed, [{ hostId, label: 'Laptop', online: false }]);

    const socket = wsConnect(
      `${server.wsUrl}${WS_ROUTES.host}?${WS_TOKEN_PARAM}=${enrolled.body.hostToken}`,
    );
    await socket.ready;
    await until(async () => (await listHosts(app, sessionToken)).body.hosts[0].online === true);

    socket.close();
    await socket.closed;
    await until(async () => (await listHosts(app, sessionToken)).body.hosts[0].online === false);
  } finally {
    await server.close();
  }
});

test('/ws/host rejects a bad token', async () => {
  const created = await freshApp();
  const server = await startServer(created);
  try {
    const socket = wsConnect(`${server.wsUrl}${WS_ROUTES.host}?${WS_TOKEN_PARAM}=bogus`);
    await assert.rejects(socket.ready);
  } finally {
    await server.close();
  }
});

test('/ws/client rejects a bad token', async () => {
  const created = await freshApp();
  const server = await startServer(created);
  try {
    const socket = wsConnect(`${server.wsUrl}${WS_ROUTES.client}?${WS_TOKEN_PARAM}=bogus`);
    await assert.rejects(socket.ready);
  } finally {
    await server.close();
  }
});

test('a host socket opens with a real enrollment token', async () => {
  const created = await freshApp();
  const server = await startServer(created);
  try {
    const { socket } = await connectHost(created.app, server);
    socket.close();
    await socket.closed;
  } finally {
    await server.close();
  }
});
