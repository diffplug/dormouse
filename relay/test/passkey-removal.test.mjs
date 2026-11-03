import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { API_ROUTES, MALFORMED_PASSKEY_QUERY_ERROR, MAX_PASSKEY_QUERY_IDS, UNAUTHORIZED_ERROR } from 'remote-lib-common';

import { enrollBurrow, freshApp } from './helpers.mjs';
import { recordingSocket } from './harness/memory-socket.mjs';

/**
 * `docs/specs/remote-security-model.md` -> "Relay-named revocation", this
 * Relay's half: `account.json` is the only record of what the account holds, a
 * hand edit is the only removal, and the sweep is driven directly, as
 * `burrow-revocation.test.mjs` drives its own.
 */

const NUDGE = { t: 'passkeys-changed' };

function accountFile(stateDir, ...credentialIds) {
  return writeFile(
    join(stateDir, 'account.json'),
    JSON.stringify({
      accountId: 'owner',
      createdAt: 1,
      passkeys: credentialIds.map((credentialId) => ({ credentialId, publicKey: 'k', label: 'Phone', createdAt: 1 })),
    }),
  );
}

async function ask(app, burrowToken, credentialIds) {
  const res = await app.request(API_ROUTES.burrowPasskeysRemoved, {
    method: 'POST',
    headers: { authorization: `Bearer ${burrowToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ credentialIds }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function enrolled() {
  const created = await freshApp();
  const { body: burrow } = await enrollBurrow(created.app);
  return { ...created, burrow, asks: (ids) => ask(created.app, burrow.burrowToken, ids) };
}

test('names only the asked ids the account no longer holds', async () => {
  const { stateDir, asks } = await enrolled();
  await accountFile(stateDir, 'kept', 'unasked');

  assert.deepEqual(await asks(['kept', 'gone', 'gone']), { status: 200, body: { removed: ['gone'] } });

  // A hand edit is the removal, with nothing left behind to read.
  await accountFile(stateDir, 'unasked');
  assert.deepEqual((await asks(['kept'])).body, { removed: ['kept'] });
});

test('an account file that is absent or will not parse names nothing', async () => {
  const { stateDir, asks } = await enrolled();

  // No account yet, or the file moved aside mid-edit: not "every passkey went".
  await rm(join(stateDir, 'account.json'), { force: true });
  assert.deepEqual(await asks(['phone']), { status: 200, body: { removed: [] } });

  await writeFile(join(stateDir, 'account.json'), '{ half a file');
  const refused = await asks(['phone']);
  assert.equal(refused.status, 500);
  assert.equal(refused.body?.removed, undefined);
});

test('only a Burrow token asks, and only a well-formed question', async () => {
  const { app, stateDir, asks } = await enrolled();
  await accountFile(stateDir, 'kept');

  const stranger = await ask(app, 'a'.repeat(43), ['kept']);
  assert.deepEqual(stranger, { status: 401, body: { error: UNAUTHORIZED_ERROR } });

  const tooMany = Array.from({ length: MAX_PASSKEY_QUERY_IDS + 1 }, (_, i) => `id-${i}`);
  for (const bad of [undefined, 'kept', [1], ['x'.repeat(1025)], tooMany]) {
    assert.deepEqual(await asks(bad), { status: 400, body: { error: MALFORMED_PASSKEY_QUERY_ERROR } });
  }
  assert.equal((await asks(tooMany.slice(1))).status, 200);
});

test('the sweep nudges every connected Burrow once a passkey leaves the file, and otherwise stays quiet', async () => {
  const { hub, stateDir, burrow, app, sweepRemovedPasskeys } = await enrolled();
  const { body: second } = await enrollBurrow(app);
  const sockets = [recordingSocket(), recordingSocket()];
  hub.registerBurrow(burrow.burrowId, sockets[0]);
  hub.registerBurrow(second.burrowId, sockets[1]);
  await accountFile(stateDir, 'phone', 'tablet');
  const clear = () => sockets.forEach((socket) => (socket.sent.length = 0));

  // The first read has nothing to compare with, and an edit may have landed
  // between a Burrow's first ask and it.
  assert.equal(await sweepRemovedPasskeys(), 2);
  assert.deepEqual(sockets.map((socket) => socket.sent), [[NUDGE], [NUDGE]]);
  clear();

  // Nothing changed, then only an addition: no passkey went.
  assert.equal(await sweepRemovedPasskeys(), 0);
  await accountFile(stateDir, 'phone', 'tablet', 'laptop');
  assert.equal(await sweepRemovedPasskeys(), 0);
  assert.deepEqual(sockets.map((socket) => socket.sent), [[], []]);

  await accountFile(stateDir, 'tablet', 'laptop');
  assert.equal(await sweepRemovedPasskeys(), 2);
  assert.deepEqual(sockets.map((socket) => socket.sent), [[NUDGE], [NUDGE]]);
  clear();

  // The same removal is told once.
  assert.equal(await sweepRemovedPasskeys(), 0);
  assert.deepEqual(sockets[0].sent, []);
});

test('a file the sweep cannot read keeps what it last read, so the removal is still told after', async () => {
  const { hub, stateDir, burrow, sweepRemovedPasskeys } = await enrolled();
  const socket = recordingSocket();
  hub.registerBurrow(burrow.burrowId, socket);
  await accountFile(stateDir, 'phone', 'tablet');
  await sweepRemovedPasskeys();
  socket.sent.length = 0;

  await rm(join(stateDir, 'account.json'));
  assert.equal(await sweepRemovedPasskeys(), 0);
  await writeFile(join(stateDir, 'account.json'), '{ half a file');
  await assert.rejects(sweepRemovedPasskeys());
  assert.deepEqual(socket.sent, []);

  await accountFile(stateDir, 'tablet');
  assert.equal(await sweepRemovedPasskeys(), 1);
  assert.deepEqual(socket.sent, [NUDGE]);
});
