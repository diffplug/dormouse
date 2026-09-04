/**
 * The Pocket service worker's push path (`docs/specs/pocket-app.md` ->
 * Installable web app).
 *
 * The worker is the only party that can read a push — the Burrow seals to this
 * Client's static and the Relay forwards ciphertext
 * (`docs/specs/remote-security-model.md` -> Push sealing) — so what is under
 * test is the whole decision table, and the one rule that spans it: **every
 * delivery ends in a notification**, because `userVisibleOnly: true` makes
 * showing none a browser-substituted notice charged against the subscription.
 *
 * Driven through the real `self.addEventListener` wiring with a fake scope, so
 * a handler that stopped being installed fails here too.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  fromBase64Url,
  generateNoiseKeyPair,
  sealPush,
  toBase64Url,
  utf8Encode,
  type NoiseKeyPair,
  type SealedPushPayload,
} from 'remote-lib-common';

import type { KnownBurrowStore, KnownBurrowV1 } from '../client/pocket-db';
import { GENERIC_PUSH_NOTIFICATION, installPocketWorker, type WorkerScope } from './sw';

/** A `burrowId` in the shape the Relay mints: base64url of 16 bytes. */
const BURROW_ID = toBase64Url(new Uint8Array(16).fill(7));
const OTHER_BURROW_ID = toBase64Url(new Uint8Array(16).fill(9));

type PushListener = (event: {
  data?: { json(): unknown } | null;
  waitUntil(promise: Promise<unknown>): void;
}) => void;

interface Harness {
  readonly push: PushListener;
  readonly showNotification: ReturnType<typeof vi.fn>;
  readonly burrowStatic: NoiseKeyPair;
  readonly clientStatic: NoiseKeyPair;
  readonly put: (record: KnownBurrowV1) => void;
  readonly shown: () => { title: string; body: string; tag?: string };
}

/** One paired Burrow record, with real statics so the seal is the real one. */
function knownBurrow(
  burrowStatic: NoiseKeyPair,
  clientStatic: NoiseKeyPair,
  authorization: KnownBurrowV1['authorization'],
): KnownBurrowV1 {
  return {
    burrowId: BURROW_ID,
    accountId: 'owner',
    label: 'Work laptop',
    burrowStaticPublicKey: toBase64Url(burrowStatic.publicKey),
    clientStaticKeyPair: {
      privateKey: clientStatic.privateKey as CryptoKey,
      publicKeyRaw: toBase64Url(clientStatic.publicKey),
    },
    passkeyCredentialId: 'cred',
    passkeyPublicKeyHash: 'hash',
    authorization,
  };
}

async function harness(): Promise<Harness> {
  const burrowStatic = await generateNoiseKeyPair();
  const clientStatic = await generateNoiseKeyPair();
  const records = new Map<string, KnownBurrowV1>();
  records.set(BURROW_ID, knownBurrow(burrowStatic, clientStatic, { state: 'paired', deliveryId: 'd', approvedAt: 1 }));

  const store: KnownBurrowStore = {
    get: async (burrowId) => records.get(burrowId) ?? null,
    put: async (record) => void records.set(record.burrowId, record),
    delete: async (burrowId) => void records.delete(burrowId),
    list: async () => [...records.values()],
  };

  const listeners = new Map<string, unknown>();
  const showNotification = vi.fn(async () => undefined);
  const scope = {
    addEventListener: (type: string, listener: unknown) => listeners.set(type, listener),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async () => undefined },
    registration: { showNotification },
  } as unknown as WorkerScope;
  installPocketWorker(scope, store);

  return {
    push: listeners.get('push') as PushListener,
    showNotification,
    burrowStatic,
    clientStatic,
    put: (record) => void records.set(record.burrowId, record),
    shown: () => {
      const [title, options] = showNotification.mock.calls.at(-1) as unknown as [
        string,
        { body: string; tag?: string },
      ];
      return { title, body: options.body, tag: options.tag };
    },
  };
}

/** Deliver one payload and wait for whatever the handler kept alive. */
async function deliver(worker: Harness, payload: unknown): Promise<void> {
  const pending: Array<Promise<unknown>> = [];
  worker.push({
    data:
      payload === undefined
        ? null
        : {
            json: () => {
              if (payload === 'not-json') throw new SyntaxError('not json');
              return payload;
            },
          },
    waitUntil: (promise) => void pending.push(promise),
  });
  await Promise.all(pending);
}

/** What the Burrow puts on the wire: the sealed envelope plus its `burrowId`. */
async function sealedPayload(
  worker: Harness,
  fields: unknown,
  burrowId = BURROW_ID,
): Promise<SealedPushPayload> {
  const sealed = await sealPush({
    burrowStaticPrivateKey: worker.burrowStatic.privateKey,
    clientStaticPublicKey: worker.clientStatic.publicKey,
    plaintext: utf8Encode(JSON.stringify(fields)),
  });
  return { burrowId, ...sealed };
}

describe('Pocket push service worker', () => {
  it('decrypts a sealed push and shows what the Burrow sent', async () => {
    const worker = await harness();

    await deliver(worker, await sealedPayload(worker, {
      title: 'build finished',
      body: 'Needs attention',
      tag: 'pty-1',
    }));

    expect(worker.shown()).toEqual({ title: 'build finished', body: 'Needs attention', tag: 'pty-1' });
  });

  it('shows the generic notification for a payload-less push', async () => {
    const worker = await harness();
    await deliver(worker, undefined);
    expect(worker.shown()).toMatchObject(GENERIC_PUSH_NOTIFICATION);
  });

  it('shows the generic notification when the payload is not JSON', async () => {
    const worker = await harness();
    await deliver(worker, 'not-json');
    expect(worker.shown()).toMatchObject(GENERIC_PUSH_NOTIFICATION);
  });

  it('shows the generic notification for a Burrow this Client never paired with', async () => {
    const worker = await harness();
    await deliver(worker, await sealedPayload(worker, { title: 'secret' }, OTHER_BURROW_ID));
    expect(worker.shown()).toMatchObject(GENERIC_PUSH_NOTIFICATION);
  });

  it('shows the generic notification when the envelope will not decrypt', async () => {
    const worker = await harness();
    const payload = await sealedPayload(worker, { title: 'build finished' });
    // One flipped byte of ciphertext: authentication fails, and there is no
    // salvageable half to render.
    const tampered = fromBase64Url(payload.ct);
    tampered[0]! ^= 0x01;
    await deliver(worker, { ...payload, ct: toBase64Url(tampered) });
    expect(worker.shown()).toMatchObject(GENERIC_PUSH_NOTIFICATION);
  });

  it('shows the generic notification when the plaintext is not a notification', async () => {
    const worker = await harness();
    // Sealed correctly by the right Burrow, and still unusable.
    await deliver(worker, await sealedPayload(worker, ['not', 'an', 'object']));
    expect(worker.shown()).toMatchObject({ title: GENERIC_PUSH_NOTIFICATION.title });

    await deliver(worker, {
      burrowId: BURROW_ID,
      ...(await sealPush({
        burrowStaticPrivateKey: worker.burrowStatic.privateKey,
        clientStaticPublicKey: worker.clientStatic.publicKey,
        plaintext: utf8Encode('{ not json'),
      })),
    });
    expect(worker.shown()).toMatchObject(GENERIC_PUSH_NOTIFICATION);
  });

  it('re-bounds and re-sanitizes what it decrypts', async () => {
    // The Burrow bounds before sealing, but the Relay can no longer be the
    // second pair of eyes it was, so the sink applies the rule itself.
    const worker = await harness();

    // Escapes, never the literal characters: a raw NUL makes git treat this
    // whole file as binary, and a raw bidi override is invisible to a reviewer.
    await deliver(worker, await sealedPayload(worker, {
      title: 'x'.repeat(500),
      body: 'wat\u202ech\u0000ed',
      tag: '',
    }));

    const shown = worker.shown();
    expect(shown.title).toHaveLength(200);
    expect(shown.body).toBe('watch ed');
    // An empty collapse key is no key, never a shared literal that would make
    // unrelated Sessions replace each other's notifications.
    expect(shown.tag).toBeUndefined();
  });

  it('treats a pairing-required record as one it cannot read', async () => {
    // The record kept its pin and lost its authorization; it is not a live
    // Client, so its Burrow's pushes are not this worker's to render.
    const worker = await harness();
    const payload = await sealedPayload(worker, { title: 'build finished' });
    worker.put(knownBurrow(worker.burrowStatic, worker.clientStatic, { state: 'pairing-required' }));

    await deliver(worker, payload);
    expect(worker.shown()).toMatchObject(GENERIC_PUSH_NOTIFICATION);
  });

  it('notifies exactly once per delivery, whatever the outcome', async () => {
    const worker = await harness();
    await deliver(worker, undefined);
    await deliver(worker, await sealedPayload(worker, { title: 'build finished' }));
    await deliver(worker, { burrowId: BURROW_ID, v: 1, salt: 'nope', ct: 'nope' });
    expect(worker.showNotification).toHaveBeenCalledTimes(3);
  });

  it('retries with the generic notice when the UA refuses the options', async () => {
    // A rejected `showNotification` would otherwise reject the `waitUntil`
    // promise — an unhandled rejection in a worker, and a delivery that showed
    // nothing. The retry is what can still land when it was the payload-derived
    // options the UA refused.
    const worker = await harness();
    worker.showNotification.mockRejectedValueOnce(new TypeError('bad options'));

    await deliver(worker, await sealedPayload(worker, { title: 'build finished', tag: 'pty-1' }));

    expect(worker.showNotification).toHaveBeenCalledTimes(2);
    expect(worker.shown()).toMatchObject(GENERIC_PUSH_NOTIFICATION);
    // The generic notice carries no collapse key, so a retry cannot replace an
    // unrelated Session's notification.
    expect(worker.shown().tag).toBeUndefined();
  });

  it('settles even when every showNotification is refused', async () => {
    // Permission revoked between subscribe and delivery: nothing can be shown,
    // and the handler must still resolve rather than reject out of `waitUntil`.
    const worker = await harness();
    worker.showNotification.mockRejectedValue(new Error('permission revoked'));

    await expect(
      deliver(worker, await sealedPayload(worker, { title: 'build finished' })),
    ).resolves.toBeUndefined();
    expect(worker.showNotification).toHaveBeenCalledTimes(2);
  });
});
