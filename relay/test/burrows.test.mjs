/**
 * Burrow enrollment and presence (docs/specs/relay.md, "HTTP API"): the password
 * path of the credential-gated `POST /api/burrow/enroll`, the session-gated
 * `GET /api/burrows` presence flag, and WS token rejection on both relay routes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { API_ROUTES, E2E_ID_LENGTH, WS_ROUTES, WS_TOKEN_PARAM, isE2eId } from 'remote-lib-common';

import { BURROW_ENROLL_ATTEMPT_REFILL_MS } from '../dist/app.js';
import { BURROW_TOKEN_LENGTH, BurrowStore, MAX_ENROLLED_BURROWS } from '../dist/state.js';

import {
  RP_ID,
  connectBurrow,
  enrollBurrow,
  freshApp,
  makeClock,
  ownerSession,
  post,
  startRelay,
  until,
  wsConnect,
} from './helpers.mjs';

/** GET /api/burrows as the owner; returns the parsed body. */
async function listBurrows(app, sessionToken) {
  const res = await app.request(API_ROUTES.burrows, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  return { res, body: await res.json() };
}

test('enroll happy path returns burrow credentials and policy', async () => {
  const { app, origin } = await freshApp();
  const { res, body } = await enrollBurrow(app);
  assert.equal(res.status, 200);
  // Pinned at enrollment: `e2e` routes on `burrowId`, and `isE2eId` accepts only
  // base64url of 16 bytes — a Burrow of any other shape is one no Client could
  // ever address (docs/specs/relay.md -> "Routing").
  assert.equal(isE2eId(body.burrowId), true);
  assert.equal(body.burrowId.length, E2E_ID_LENGTH);
  assert.equal(typeof body.burrowToken, 'string');
  assert.notEqual(body.burrowId, body.burrowToken);
  assert.equal(body.origin, origin);
  assert.equal(body.rpId, RP_ID);
});

test('enroll rejects a wrong password', async () => {
  const { app } = await freshApp();
  const res = await post(app, API_ROUTES.burrowEnroll, { password: 'wrong' });
  assert.equal(res.status, 401);
});

test('a second enrollment appends and gets distinct credentials', async () => {
  const { app } = await freshApp();
  // Registering the owner passkey enrolls a Burrow of its own — that is the only
  // way a setup token exists — so the list is measured as a delta.
  const { sessionToken } = await ownerSession(app);
  const before = (await listBurrows(app, sessionToken)).body.burrows.length;
  const { body: a } = await enrollBurrow(app);
  const { body: b } = await enrollBurrow(app);
  assert.notEqual(a.burrowId, b.burrowId);
  assert.notEqual(a.burrowToken, b.burrowToken);

  const { body } = await listBurrows(app, sessionToken);
  assert.equal(body.burrows.length, before + 2);
  assert.deepEqual(
    body.burrows.filter((h) => h.burrowId === a.burrowId || h.burrowId === b.burrowId).length,
    2,
  );
});

test('burrows.json is owner-only, since it stores burrowToken in plaintext', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX file modes only');
  const { app, stateDir } = await freshApp();
  await enrollBurrow(app);
  const { mode } = await stat(join(stateDir, 'burrows.json'));
  assert.equal(mode & 0o777, 0o600);
});

test('a hand-edited burrows.json row of the wrong burrowId shape is dropped', async () => {
  // The documented revocation mechanism is editing this file, so a row of
  // another length is an expected state — and it must read as un-enrolled
  // rather than as a Burrow no `e2e` frame could ever be routed to.
  const { app, stateDir } = await freshApp();
  const { sessionToken } = await ownerSession(app);
  const { body: burrow } = await enrollBurrow(app);
  const path = join(stateDir, 'burrows.json');
  const rows = JSON.parse(await readFile(path, 'utf8'));
  const corrupted = rows.map((row) =>
    row.burrowId === burrow.burrowId ? { ...row, burrowId: 'too-short' } : row,
  );
  await writeFile(path, JSON.stringify(corrupted), 'utf8');

  const listed = (await listBurrows(app, sessionToken)).body.burrows;
  assert.equal(listed.some((h) => h.burrowId === burrow.burrowId), false);
  assert.equal(listed.some((h) => h.burrowId === 'too-short'), false);
  // And its bearer token no longer resolves, so the row is revoked rather than
  // merely invisible.
  const minted = await app.request(API_ROUTES.burrowSetupToken, {
    method: 'POST',
    headers: { authorization: `Bearer ${burrow.burrowToken}` },
  });
  assert.equal(minted.status, 401);
});

test('GET /api/burrows requires a session', async () => {
  const { app } = await freshApp();
  assert.equal((await app.request(API_ROUTES.burrows)).status, 401);
});

test('GET /api/burrows online flag flips with the burrow socket', async () => {
  const created = await freshApp();
  const { app } = created;
  const server = await startRelay(created);
  try {
    const { sessionToken } = await ownerSession(app);

    const enrolled = await enrollBurrow(app);
    const burrowId = enrolled.body.burrowId;
    /** This Burrow's row; the owner's registration enrolled one of its own. */
    const row = async () =>
      (await listBurrows(app, sessionToken)).body.burrows.find((h) => h.burrowId === burrowId);

    // No label: the Relay holds none, so this list is discovery only.
    assert.deepEqual(await row(), { burrowId, online: false });

    const socket = wsConnect(
      `${server.wsUrl}${WS_ROUTES.burrow}?${WS_TOKEN_PARAM}=${enrolled.body.burrowToken}`,
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

test('/ws/burrow rejects a bad token', async () => {
  const created = await freshApp();
  const server = await startRelay(created);
  try {
    const socket = wsConnect(`${server.wsUrl}${WS_ROUTES.burrow}?${WS_TOKEN_PARAM}=bogus`);
    await assert.rejects(socket.ready);
  } finally {
    await server.close();
  }
});

test('/ws/client rejects a bad token', async () => {
  const created = await freshApp();
  const server = await startRelay(created);
  try {
    const socket = wsConnect(`${server.wsUrl}${WS_ROUTES.client}?${WS_TOKEN_PARAM}=bogus`);
    await assert.rejects(socket.ready);
  } finally {
    await server.close();
  }
});

test('a burrow socket opens with a real enrollment token', async () => {
  const created = await freshApp();
  const server = await startRelay(created);
  try {
    const { socket } = await connectBurrow(created.app, server);
    socket.close();
    await socket.closed;
  } finally {
    await server.close();
  }
});

test('enrollment mirrors requireUserVerification to the Burrow, and omits it when off', async () => {
  // The flag has to travel: the Burrow is the final authority on an assertion,
  // so a Relay that demands UV while the Burrow does not leaves the weaker
  // verifier deciding access. Absent means false, which is what an older Burrow
  // reading a newer Relay — or either reading an older one — must see.
  const on = await freshApp({ requireUserVerification: true });
  const { body: uvOn } = await enrollBurrow(on.app);
  assert.equal(uvOn.requireUserVerification, true);

  const off = await freshApp();
  const { body: uvOff } = await enrollBurrow(off.app);
  assert.equal('requireUserVerification' in uvOff, false);
});

test('only Burrow-enrollment rejection invokes the retained-request delay', async () => {
  let delayCalls = 0;
  const { app } = await freshApp({
    credentialFailureDelay: async () => {
      delayCalls += 1;
    },
  });
  await enrollBurrow(app);

  assert.equal(
    (
      await app.request(API_ROUTES.pushDevices, {
        headers: { Authorization: `Bearer ${'A'.repeat(BURROW_TOKEN_LENGTH)}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await app.request(`${WS_ROUTES.burrow}?${WS_TOKEN_PARAM}=${'A'.repeat(BURROW_TOKEN_LENGTH)}`)
    ).status,
    401,
  );
  assert.equal((await post(app, API_ROUTES.setupBegin, { setupToken: 'unknown' })).status, 401);
  assert.equal(delayCalls, 0);

  assert.equal((await post(app, API_ROUTES.burrowEnroll, { password: 'wrong' })).status, 401);
  assert.equal(delayCalls, 1);
});

test('a hand-edited burrows.json revokes through the read cache', async () => {
  // `findByToken` runs unauthenticated on every burrow-gated request, so its read
  // is cached against the file's stat. Deleting a row by hand is the documented
  // revocation mechanism (docs/specs/relay.md -> Guardrails), so a cache that
  // outlived an edit would keep a revoked Burrow working.
  const { app, stateDir } = await freshApp();
  const { body: burrow } = await enrollBurrow(app);
  const authorized = { headers: { Authorization: `Bearer ${burrow.burrowToken}` } };

  assert.equal((await app.request(API_ROUTES.pushDevices, authorized)).status, 200);
  // Warm the cache, so the edit below has something stale to defeat.
  assert.equal((await app.request(API_ROUTES.pushDevices, authorized)).status, 200);

  await writeFile(join(stateDir, 'burrows.json'), '[]');
  assert.equal((await app.request(API_ROUTES.pushDevices, authorized)).status, 401);
});

test('a token of a shape no Burrow was ever minted never reaches burrows.json', async () => {
  const { app, stateDir } = await freshApp();
  const { body: burrow } = await enrollBurrow(app);
  assert.equal(burrow.burrowToken.length, BURROW_TOKEN_LENGTH);

  const store = new BurrowStore(stateDir);
  // Make the file unreadable-as-JSON: any lookup that actually reads it throws.
  await writeFile(join(stateDir, 'burrows.json'), 'not json');
  for (const bad of ['', 'short', `${burrow.burrowToken}x`, `${'!'.repeat(BURROW_TOKEN_LENGTH)}`]) {
    assert.equal(await store.findByToken(bad), undefined, bad);
  }
  // The control: a well-shaped token does read the file, and so does throw.
  await assert.rejects(store.findByToken('A'.repeat(BURROW_TOKEN_LENGTH)));
});

/**
 * An app holding `MAX_ENROLLED_BURROWS`. The clock advances a refill interval per
 * enrollment because the global admission bucket is smaller than the cap.
 */
async function appAtBurrowCap() {
  const clock = makeClock();
  const { app } = await freshApp({ now: clock.now });
  for (let i = 0; i < MAX_ENROLLED_BURROWS; i += 1) {
    assert.equal((await enrollBurrow(app)).res.status, 200, `burrow ${i}`);
    clock.advance(BURROW_ENROLL_ATTEMPT_REFILL_MS);
  }
  return app;
}

test('enrollment is capped, and the refusal names the remedy', async () => {
  // Credential-gated, so this is not a flood defense: it is the bound on a file
  // that is otherwise append-only and is compared row by row on every
  // burrow-gated request and every `/ws/burrow` upgrade.
  const { res, body } = await enrollBurrow(await appAtBurrowCap());
  assert.equal(res.status, 409);
  assert.match(body.error, /burrows\.json/);
});

test('the enrollment cap is checked after the credential, never before', async () => {
  // A caller that has proved nothing must not learn from the refusal whether
  // the Relay is full.
  const res = await post(await appAtBurrowCap(), API_ROUTES.burrowEnroll, { password: 'wrong' });
  assert.equal(res.status, 401);
});
