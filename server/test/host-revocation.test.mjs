import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { WS_CLOSE_HOST_REVOKED } from 'server-lib-common';

import { enrollHost, freshApp } from './helpers.mjs';
import { e2eClientFrame } from './harness/e2e.mjs';

/**
 * `docs/specs/server.md` -> Guardrails owns the rule. Driven through
 * `sweepRevokedHosts` rather than its interval, which `index.ts` owns: the
 * timer is wall-clock plumbing, and what needs proving is the decision.
 */

function fakeSocket() {
  return {
    sent: [],
    closeCode: null,
    send(data) {
      this.sent.push(JSON.parse(data));
    },
    close(code) {
      this.closeCode = code;
    },
  };
}

function hostsPath(stateDir) {
  return join(stateDir, 'hosts.json');
}

test('a Host whose row is deleted loses its relay socket, and its clients are told', async () => {
  const created = await freshApp();
  const { hub, stateDir } = created;
  const { body: host } = await enrollHost(created.app);

  // The Host is connected and one Client is bound to it — the state the upgrade
  // check can no longer see anything about.
  const hostSocket = fakeSocket();
  hub.registerHost(host.hostId, hostSocket);
  const clientSocket = fakeSocket();
  const client = hub.registerClient(clientSocket);
  hub.onClientFrame(client, JSON.stringify(e2eClientFrame(host.hostId)));
  assert.equal(client.hostId, host.hostId, 'precondition: bound');
  assert.equal(hub.isHostOnline(host.hostId), true, 'precondition: online');

  // Revocation, exactly as an operator performs it.
  await writeFile(hostsPath(stateDir), '[]');

  assert.equal(await created.sweepRevokedHosts(), 1);
  assert.equal(hostSocket.closeCode, WS_CLOSE_HOST_REVOKED);
  assert.equal(hub.isHostOnline(host.hostId), false);
  assert.equal(client.hostId, null, 'the binding is cleared, as on a disconnect');
  assert.ok(clientSocket.sent.some((f) => f.t === 'host-gone'));
});

test('an enrolled Host is left alone, however often the sweep runs', async () => {
  const created = await freshApp();
  const { hub } = created;
  const { body: host } = await enrollHost(created.app);
  const hostSocket = fakeSocket();
  hub.registerHost(host.hostId, hostSocket);

  assert.equal(await created.sweepRevokedHosts(), 0);
  assert.equal(await created.sweepRevokedHosts(), 0);
  assert.equal(hostSocket.closeCode, null);
  assert.equal(hub.isHostOnline(host.hostId), true);
});

test('one Host revoked out of two closes only that one', async () => {
  const created = await freshApp();
  const { hub, stateDir } = created;
  const { body: first } = await enrollHost(created.app);
  const { body: second } = await enrollHost(created.app);
  const firstSocket = fakeSocket();
  const secondSocket = fakeSocket();
  hub.registerHost(first.hostId, firstSocket);
  hub.registerHost(second.hostId, secondSocket);

  const rows = JSON.parse(await readFile(hostsPath(stateDir), 'utf8'));
  await writeFile(
    hostsPath(stateDir),
    JSON.stringify(rows.filter((row) => row.hostId !== first.hostId)),
  );

  assert.equal(await created.sweepRevokedHosts(), 1);
  assert.equal(firstSocket.closeCode, WS_CLOSE_HOST_REVOKED);
  assert.equal(secondSocket.closeCode, null);
  assert.equal(hub.isHostOnline(second.hostId), true);
});
