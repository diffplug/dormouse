/**
 * Host enrollment and presence (docs/specs/server.md, "HTTP API"): the password
 * path of the credential-gated `POST /api/host/enroll`, the session-gated
 * `GET /api/hosts` presence flag, and WS token rejection on both relay routes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { API_ROUTES, E2E_ID_LENGTH, WS_ROUTES, WS_TOKEN_PARAM, isE2eId } from 'server-lib-common';

import { HOST_TOKEN_LENGTH, HostStore, MAX_ENROLLED_HOSTS } from '../dist/state.js';

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
  const { res, body } = await enrollHost(app);
  assert.equal(res.status, 200);
  // Pinned at enrollment: `e2e` routes on `hostId`, and `isE2eId` accepts only
  // base64url of 16 bytes — a Host of any other shape is one no Client could
  // ever address (docs/specs/server.md -> Relay).
  assert.equal(isE2eId(body.hostId), true);
  assert.equal(body.hostId.length, E2E_ID_LENGTH);
  assert.equal(typeof body.hostToken, 'string');
  assert.notEqual(body.hostId, body.hostToken);
  assert.equal(body.origin, origin);
  assert.equal(body.rpId, RP_ID);
});

test('enroll rejects a wrong password', async () => {
  const { app } = await freshApp();
  const res = await post(app, API_ROUTES.hostEnroll, { password: 'wrong' });
  assert.equal(res.status, 401);
});

test('a second enrollment appends and gets distinct credentials', async () => {
  const { app } = await freshApp();
  // Registering the owner passkey enrolls a Host of its own — that is the only
  // way a setup token exists — so the list is measured as a delta.
  const { sessionToken } = await ownerSession(app);
  const before = (await listHosts(app, sessionToken)).body.hosts.length;
  const { body: a } = await enrollHost(app);
  const { body: b } = await enrollHost(app);
  assert.notEqual(a.hostId, b.hostId);
  assert.notEqual(a.hostToken, b.hostToken);

  const { body } = await listHosts(app, sessionToken);
  assert.equal(body.hosts.length, before + 2);
  assert.deepEqual(
    body.hosts.filter((h) => h.hostId === a.hostId || h.hostId === b.hostId).length,
    2,
  );
});

test('hosts.json is owner-only, since it stores hostToken in plaintext', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX file modes only');
  const { app, stateDir } = await freshApp();
  await enrollHost(app);
  const { mode } = await stat(join(stateDir, 'hosts.json'));
  assert.equal(mode & 0o777, 0o600);
});

test('a hand-edited hosts.json row of the wrong hostId shape is dropped', async () => {
  // The documented revocation mechanism is editing this file, so a row of
  // another length is an expected state — and it must read as un-enrolled
  // rather than as a Host no `e2e` frame could ever be routed to.
  const { app, stateDir } = await freshApp();
  const { sessionToken } = await ownerSession(app);
  const { body: host } = await enrollHost(app);
  const path = join(stateDir, 'hosts.json');
  const rows = JSON.parse(await readFile(path, 'utf8'));
  const corrupted = rows.map((row) =>
    row.hostId === host.hostId ? { ...row, hostId: 'too-short' } : row,
  );
  await writeFile(path, JSON.stringify(corrupted), 'utf8');

  const listed = (await listHosts(app, sessionToken)).body.hosts;
  assert.equal(listed.some((h) => h.hostId === host.hostId), false);
  assert.equal(listed.some((h) => h.hostId === 'too-short'), false);
  // And its bearer token no longer resolves, so the row is revoked rather than
  // merely invisible.
  const minted = await app.request(API_ROUTES.hostSetupToken, {
    method: 'POST',
    headers: { authorization: `Bearer ${host.hostToken}` },
  });
  assert.equal(minted.status, 401);
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

    const enrolled = await enrollHost(app);
    const hostId = enrolled.body.hostId;
    /** This Host's row; the owner's registration enrolled one of its own. */
    const row = async () =>
      (await listHosts(app, sessionToken)).body.hosts.find((h) => h.hostId === hostId);

    // No label: the Server holds none, so this list is discovery only.
    assert.deepEqual(await row(), { hostId, online: false });

    const socket = wsConnect(
      `${server.wsUrl}${WS_ROUTES.host}?${WS_TOKEN_PARAM}=${enrolled.body.hostToken}`,
    );
    await socket.ready;
    await until(async () => (await row()).online === true);

    socket.close();
    await socket.closed;
    await until(async () => (await row()).online === false);
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

test('enrollment mirrors requireUserVerification to the Host, and omits it when off', async () => {
  // The flag has to travel: the Host is the final authority on an assertion,
  // so a Server that demands UV while the Host does not leaves the weaker
  // verifier deciding access. Absent means false, which is what an older Host
  // reading a newer server — or either reading an older one — must see.
  const on = await freshApp({ requireUserVerification: true });
  const { body: uvOn } = await enrollHost(on.app);
  assert.equal(uvOn.requireUserVerification, true);

  const off = await freshApp();
  const { body: uvOff } = await enrollHost(off.app);
  assert.equal('requireUserVerification' in uvOff, false);
});

// --- probing a host token costs the prober too -----------------------------
// `requireHost` and the `/ws/host` gate both run unauthenticated over the most
// expensive lookup on the server: a `readFile` + `JSON.parse` + two SHA-256 per
// row. Answering instantly, and reading the file for a value no Host could have
// been minted, made probing cheaper for the caller than for us.

test('a rejected host token pays the credential-failure delay', async () => {
  const delayMs = 60;
  const { app } = await freshApp({ credentialFailureDelayMs: delayMs });
  await enrollHost(app);

  const started = Date.now();
  const res = await app.request(API_ROUTES.pushDevices, {
    headers: { Authorization: `Bearer ${'A'.repeat(HOST_TOKEN_LENGTH)}` },
  });
  const elapsed = Date.now() - started;

  assert.equal(res.status, 401);
  assert.ok(elapsed >= delayMs, `answered in ${elapsed}ms, under the ${delayMs}ms delay`);
});

test('the /ws/host upgrade pays the same delay on a bad token', async () => {
  const delayMs = 60;
  const { app } = await freshApp({ credentialFailureDelayMs: delayMs });
  await enrollHost(app);

  const started = Date.now();
  const res = await app.request(
    `${WS_ROUTES.host}?${WS_TOKEN_PARAM}=${'A'.repeat(HOST_TOKEN_LENGTH)}`,
  );
  const elapsed = Date.now() - started;

  assert.equal(res.status, 401);
  assert.ok(elapsed >= delayMs, `answered in ${elapsed}ms, under the ${delayMs}ms delay`);
});

test('a token of a shape no Host was ever minted never reaches hosts.json', async () => {
  const { app, stateDir } = await freshApp({ credentialFailureDelayMs: 1 });
  const { body: host } = await enrollHost(app);
  assert.equal(host.hostToken.length, HOST_TOKEN_LENGTH);

  const store = new HostStore(stateDir);
  // Make the file unreadable-as-JSON: any lookup that actually reads it throws.
  await writeFile(join(stateDir, 'hosts.json'), 'not json');
  for (const bad of ['', 'short', `${host.hostToken}x`, `${'!'.repeat(HOST_TOKEN_LENGTH)}`]) {
    assert.equal(await store.findByToken(bad), undefined, bad);
  }
  // The control: a well-shaped token does read the file, and so does throw.
  await assert.rejects(store.findByToken('A'.repeat(HOST_TOKEN_LENGTH)));
});

test('enrollment is capped, and the refusal names the remedy', async () => {
  // Credential-gated, so this is not a flood defense: it is the bound on a file
  // that is otherwise append-only and is compared row by row on every
  // host-gated request and every `/ws/host` upgrade.
  const { app } = await freshApp({ credentialFailureDelayMs: 1 });
  for (let i = 0; i < MAX_ENROLLED_HOSTS; i += 1) {
    assert.equal((await enrollHost(app)).res.status, 200, `host ${i}`);
  }

  const { res, body } = await enrollHost(app);
  assert.equal(res.status, 409);
  assert.match(body.error, /hosts\.json/);
});

test('the enrollment cap is checked after the credential, never before', async () => {
  // A caller that has proved nothing must not learn from the refusal whether
  // the server is full.
  const { app } = await freshApp({ credentialFailureDelayMs: 1 });
  for (let i = 0; i < MAX_ENROLLED_HOSTS; i += 1) {
    assert.equal((await enrollHost(app)).res.status, 200);
  }

  const res = await post(app, API_ROUTES.hostEnroll, { password: 'wrong' });
  assert.equal(res.status, 401);
});
