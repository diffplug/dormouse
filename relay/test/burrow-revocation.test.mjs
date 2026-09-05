import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { WS_CLOSE_BURROW_REVOKED } from 'remote-lib-common';

import { enrollBurrow, freshApp } from './helpers.mjs';
import { e2eClientFrame } from './harness/e2e.mjs';
import { recordingSocket } from './harness/memory-socket.mjs';

/** A session that never expires: these cases are about sockets, not TTLs. */
const LIVE_SESSION = { expiresAt: Number.POSITIVE_INFINITY };

/**
 * `docs/specs/relay.md` -> Guardrails owns the rule. Driven through
 * `sweepRevokedBurrows` rather than its interval, which `index.ts` owns: the
 * timer is wall-clock plumbing, and what needs proving is the decision.
 */

function burrowsPath(stateDir) {
  return join(stateDir, 'burrows.json');
}

test('a Burrow whose row is deleted loses its relay socket, and its clients are told', async () => {
  const created = await freshApp();
  const { hub, stateDir } = created;
  const { body: burrow } = await enrollBurrow(created.app);

  // The Burrow is connected and one Client is bound to it — the state the upgrade
  // check can no longer see anything about.
  const burrowSocket = recordingSocket();
  hub.registerBurrow(burrow.burrowId, burrowSocket);
  const clientSocket = recordingSocket();
  const client = hub.registerClient(clientSocket, LIVE_SESSION);
  hub.onClientFrame(client, JSON.stringify(e2eClientFrame(burrow.burrowId)));
  assert.equal(client.burrowId, burrow.burrowId, 'precondition: bound');
  assert.equal(hub.isBurrowOnline(burrow.burrowId), true, 'precondition: online');

  // Revocation, exactly as an operator performs it.
  await writeFile(burrowsPath(stateDir), '[]');

  assert.equal(await created.sweepRevokedBurrows(), 1);
  assert.equal(burrowSocket.closeCode, WS_CLOSE_BURROW_REVOKED);
  assert.equal(hub.isBurrowOnline(burrow.burrowId), false);
  assert.equal(client.burrowId, null, 'the binding is cleared, as on a disconnect');
  assert.ok(clientSocket.sent.some((f) => f.t === 'burrow-gone'));
});

test('an enrolled Burrow is left alone, however often the sweep runs', async () => {
  const created = await freshApp();
  const { hub } = created;
  const { body: burrow } = await enrollBurrow(created.app);
  const burrowSocket = recordingSocket();
  hub.registerBurrow(burrow.burrowId, burrowSocket);

  assert.equal(await created.sweepRevokedBurrows(), 0);
  assert.equal(await created.sweepRevokedBurrows(), 0);
  assert.equal(burrowSocket.closeCode, null);
  assert.equal(hub.isBurrowOnline(burrow.burrowId), true);
});

test('a `burrows.json` caught mid-edit revokes nobody', async () => {
  // The file this reads is the one an operator edits by hand, so a partial
  // write is a real state — and it must never read as "no Burrow is enrolled",
  // which would close every socket on the Relay over a half-saved buffer. The
  // sweep rejects instead, and `index.ts`'s interval swallows that and reads
  // again a minute later.
  const created = await freshApp();
  const { hub, stateDir } = created;
  const { body: burrow } = await enrollBurrow(created.app);
  const burrowSocket = recordingSocket();
  hub.registerBurrow(burrow.burrowId, burrowSocket);

  await writeFile(burrowsPath(stateDir), '[{"burrowId": "half-writ');

  await assert.rejects(created.sweepRevokedBurrows());
  assert.equal(burrowSocket.closeCode, null);
  assert.equal(hub.isBurrowOnline(burrow.burrowId), true);
});

test('a `burrows.json` absent for an instant revokes nobody', async () => {
  // The other half of a hand edit: an editor that saves by rename unlinks the
  // file first, so it is genuinely gone for a moment. `list()` answers `[]`
  // there — which is what revoking everyone also looks like — so the sweep
  // asks the question that keeps them apart.
  const created = await freshApp();
  const { hub, stateDir } = created;
  const { body: burrow } = await enrollBurrow(created.app);
  const burrowSocket = recordingSocket();
  hub.registerBurrow(burrow.burrowId, burrowSocket);

  await rm(burrowsPath(stateDir));

  assert.equal(await created.sweepRevokedBurrows(), 0);
  assert.equal(burrowSocket.closeCode, null);
  assert.equal(hub.isBurrowOnline(burrow.burrowId), true);

  // And an array that is present and empty still means what it says.
  await writeFile(burrowsPath(stateDir), '[]');
  assert.equal(await created.sweepRevokedBurrows(), 1);
  assert.equal(burrowSocket.closeCode, WS_CLOSE_BURROW_REVOKED);
});

test('one Burrow revoked out of two closes only that one', async () => {
  const created = await freshApp();
  const { hub, stateDir } = created;
  const { body: first } = await enrollBurrow(created.app);
  const { body: second } = await enrollBurrow(created.app);
  const firstSocket = recordingSocket();
  const secondSocket = recordingSocket();
  hub.registerBurrow(first.burrowId, firstSocket);
  hub.registerBurrow(second.burrowId, secondSocket);

  const rows = JSON.parse(await readFile(burrowsPath(stateDir), 'utf8'));
  await writeFile(
    burrowsPath(stateDir),
    JSON.stringify(rows.filter((row) => row.burrowId !== first.burrowId)),
  );

  assert.equal(await created.sweepRevokedBurrows(), 1);
  assert.equal(firstSocket.closeCode, WS_CLOSE_BURROW_REVOKED);
  assert.equal(secondSocket.closeCode, null);
  assert.equal(hub.isBurrowOnline(second.burrowId), true);
});
