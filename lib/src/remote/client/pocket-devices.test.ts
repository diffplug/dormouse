/**
 * A real `PocketClient` against a real `BurrowRuntime` and `RemoteApiSession`:
 * what Pocket does with the paired-browser verbs, what it prompts for, and what
 * it tells its Relay (`docs/specs/remote-api.md` -> "Paired browsers"). The
 * Burrow's half of the same rules is `lib/src/host/remote/service.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PAIRING_DEVICE_LABELS,
  PRESENCE_WINDOW_IDLE_MS,
  REMOTE_METHODS,
  type PairedBrowserV1,
  type PresenceBinding,
} from 'remote-lib-common';
import { deviceIdFor } from '../burrow/access-log';
import type { BurrowOptions } from '../burrow/burrow-runtime';
import { RemoteApiSession } from '../burrow/remote-api';
import {
  DEVICES_UNSUPPORTED_MESSAGE,
  DEVICE_REFUSAL_MESSAGES,
  RELAY_TOO_OLD_FOR_PROOF_MESSAGE,
} from './pocket-client';
import { makeE2eHarness, waitFor, type E2eHarness } from './test-e2e-harness';

const THEIRS: PairedBrowserV1 = {
  id: 'feedfacefeedface',
  label: PAIRING_DEVICE_LABELS[0],
  approvedAt: 7,
  lastSeenAt: 9,
  self: false,
};

afterEach(() => vi.restoreAllMocks());

/**
 * A Burrow whose sessions run the real handler, over what the service would
 * hand it: the presence the runtime built, one other browser, and a revoke that
 * reaches the runtime's own.
 */
async function pairedHarness(
  over: { refuseBinding?: (binding: PresenceBinding) => boolean; burrowNow?: () => number } = {},
) {
  let harness!: E2eHarness;
  const revoked: string[] = [];
  const createSession: BurrowOptions['createSession'] = ({ burrowId, send, label, presence, deviceId }) =>
    new RemoteApiSession({
      burrowId,
      send: send as (payload: unknown) => void,
      provider: {} as never,
      holder: { id: 'holder', label, serviceId: 'service' },
      ...(presence && deviceId
        ? {
            devices: {
              presence,
              list: async () => [THEIRS, { ...THEIRS, id: deviceId, label: 'Whatever a record says', self: true }],
              resolve: async (id) => (id === deviceId || id === THEIRS.id ? { self: id === deviceId } : 'unknown-device'),
              revoke: async (id) => {
                revoked.push(id);
                if (id === deviceId) {
                  await harness.burrow.revoke({ clientStaticPublicKey: harness.savedAcl[0]!.clientStaticPublicKey }, 'pocket');
                }
                return 'revoked';
              },
            },
          }
        : {}),
    });
  harness = await makeE2eHarness({ createSession, ...over });
  await harness.connectPaired();
  return { harness, revoked };
}

/** What each `/api/reauth/begin` named, in order: one per prompt. */
function proofsAsked(harness: E2eHarness): PresenceBinding[] {
  return harness.calls
    .filter((call) => call.url.endsWith('/api/reauth/begin'))
    .map((call) => (call.body as { binding: PresenceBinding }).binding);
}

describe('paired browsers, from Pocket', () => {
  it('reads an older Burrow as unsupported, never as no devices, and sends it nothing', async () => {
    // The default handler answers a hello without `devices`, as an older Burrow's does.
    const harness = await makeE2eHarness();
    await harness.connectPaired();
    await harness.client.hello();
    const sentBefore = harness.clientTransportFrames().length;

    expect(await harness.client.listDevices()).toEqual({
      ok: false,
      message: DEVICES_UNSUPPORTED_MESSAGE,
      unsupported: true,
    });
    expect(await harness.client.revokeDevice('feedfacefeedface')).toEqual({
      ok: false,
      message: DEVICES_UNSUPPORTED_MESSAGE,
    });
    expect(harness.clientTransportFrames()).toHaveLength(sentBefore);
  });

  it('forgets what a hello said when the session goes', async () => {
    const { harness } = await pairedHarness();
    await harness.client.hello();
    expect(await harness.client.listDevices()).toMatchObject({ ok: true });

    harness.client.close();
    expect(await harness.client.listDevices()).toMatchObject({ ok: false, unsupported: true });
  });

  it('lists on the proof its connection carried, prompting no more, each label mapped again', async () => {
    let clock = Date.now();
    const { harness } = await pairedHarness({ burrowNow: () => clock });
    // The pairing's window has lapsed, so a new connection proves.
    harness.client.close();
    clock += PRESENCE_WINDOW_IDLE_MS + 1;
    const prompts = proofsAsked(harness).length;
    expect(await harness.client.connect(harness.burrowId)).toMatchObject({ ok: true });
    expect(proofsAsked(harness)).toHaveLength(prompts + 1);
    await harness.client.hello();

    const listing = await harness.client.listDevices();

    expect(listing).toEqual({
      ok: true,
      devices: [
        THEIRS,
        expect.objectContaining({ label: 'Unknown device', self: true }),
      ],
    });
    expect(proofsAsked(harness)).toHaveLength(prompts + 1);
  });

  it('prompts for a session that rode a window, once per listing asked of it', async () => {
    const { harness } = await pairedHarness();
    expect(await harness.client.connect(harness.burrowId)).toMatchObject({ ok: true });
    await harness.client.hello();
    const prompts = proofsAsked(harness).length;

    expect(await harness.client.listDevices()).toMatchObject({ ok: true });
    expect(proofsAsked(harness)).toHaveLength(prompts + 1);
    expect(await harness.client.listDevices()).toMatchObject({ ok: true });
    expect(proofsAsked(harness)).toHaveLength(prompts + 1);
  });

  it('prompts for every revoke, in a `session` binding over this session, its paired credential alone', async () => {
    const { harness, revoked } = await pairedHarness();
    await harness.client.hello();
    const prompts = proofsAsked(harness).length;
    const assert = vi.spyOn(harness.authenticator, 'assert');

    expect(await harness.client.revokeDevice(THEIRS.id)).toEqual({ ok: true, self: false });
    expect(await harness.client.revokeDevice(THEIRS.id)).toEqual({ ok: true, self: false });

    expect(revoked).toEqual([THEIRS.id, THEIRS.id]);
    expect(assert).toHaveBeenCalledTimes(2);
    const asked = proofsAsked(harness).slice(prompts);
    expect(asked).toHaveLength(2);
    for (const binding of asked) {
      expect(Object.keys(binding).sort()).toEqual(
        ['burrowChallenge', 'burrowId', 'connectionId', 'handshakeHash', 'kind', 'passkeyCredentialId'].sort(),
      );
      expect(binding).toMatchObject({
        kind: 'session',
        burrowId: harness.burrowId,
        passkeyCredentialId: harness.authenticator.credentialId,
      });
    }
    expect(asked[0]!.burrowChallenge).not.toBe(asked[1]!.burrowChallenge);
  });

  it('tells its Relay nothing of any record, in a route or on the socket', async () => {
    const { harness } = await pairedHarness();
    await harness.client.hello();
    await harness.client.listDevices();
    await harness.client.revokeDevice(THEIRS.id);

    const seen = JSON.stringify([harness.calls.map((call) => call.body), harness.clientSocket().frames('e2e')]);
    for (const leak of [THEIRS.id, THEIRS.label, 'approvedAt', 'devices.', deviceIdFor(harness.savedAcl[0]!.clientStaticPublicKey), harness.savedAcl[0]!.deliveryId]) {
      expect(seen).not.toContain(leak);
    }
  });

  it('reads a refusal in its own words', async () => {
    const { harness, revoked } = await pairedHarness();
    await harness.client.hello();
    expect(await harness.client.revokeDevice('0000000000000000')).toEqual({
      ok: false,
      message: DEVICE_REFUSAL_MESSAGES['unknown-device'],
    });
    expect(revoked).toEqual([]);
  });

  it('leaves everything as it was when the person dismisses the prompt', async () => {
    const { harness, revoked } = await pairedHarness();
    await harness.client.hello();
    vi.spyOn(harness.authenticator, 'assert').mockRejectedValueOnce(
      new DOMException('dismissed', 'NotAllowedError'),
    );
    await expect(harness.client.revokeDevice(THEIRS.id)).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(revoked).toEqual([]);
    expect(harness.knownBurrows.records.get(harness.burrowId)!.authorization.state).toBe('paired');
    // The session is still good, and asks afresh.
    expect(await harness.client.revokeDevice(THEIRS.id)).toEqual({ ok: true, self: false });
  });

  it('says a Relay older than the binding is the reason, without calling it no devices', async () => {
    const { harness, revoked } = await pairedHarness({ refuseBinding: (binding) => binding.kind === 'session' });
    await harness.client.hello();

    expect(await harness.client.revokeDevice(THEIRS.id)).toEqual({
      ok: false,
      message: RELAY_TOO_OLD_FOR_PROOF_MESSAGE,
    });
    expect(revoked).toEqual([]);
  });

  it('on revoking itself, drops its own authorization with the pin kept, and its delivery row', async () => {
    const { harness } = await pairedHarness();
    await harness.client.hello();
    const before = harness.knownBurrows.records.get(harness.burrowId)!;
    const ownId = deviceIdFor(before.clientStaticKeyPair.publicKeyRaw);

    expect(await harness.client.revokeDevice(ownId)).toEqual({ ok: true, self: true });

    const after = harness.knownBurrows.records.get(harness.burrowId)!;
    expect(after.authorization).toEqual({ state: 'pairing-required' });
    expect(after.burrowStaticPublicKey).toBe(before.burrowStaticPublicKey);
    await waitFor(
      () => harness.calls.some((call) => call.method === 'DELETE' && call.url.includes('/api/push/subscriptions/')),
      'the delivery row to go',
    );
    await waitFor(() => harness.client.connectedBurrowId === null, 'the session to end');
    expect(harness.burrow.activeRecords).toEqual([]);
  });

  it('holds one challenge per session on the Burrow, and none past its end', async () => {
    const { harness } = await pairedHarness();
    await harness.client.hello();
    const before = harness.burrow.pendingChallengeCount;
    for (let asked = 0; asked < 3; asked++) {
      await harness.client.request(REMOTE_METHODS.devicesRevoke, { id: THEIRS.id });
      expect(harness.burrow.pendingChallengeCount).toBe(before + 1);
    }

    harness.sessions.at(-1)!.end();
    expect(harness.burrow.pendingChallengeCount).toBe(before);
  });

  it('sends no verb on a session the Burrow has ended', async () => {
    const { harness } = await pairedHarness();
    await harness.client.hello();
    harness.sessions.at(-1)!.end();
    await waitFor(() => harness.client.connectedBurrowId === null, 'the goodbye');
    expect(await harness.client.listDevices()).toMatchObject({ ok: false, unsupported: true });
  });
});
