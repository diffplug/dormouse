import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_PUSH_QUERY_DELIVERY_IDS,
  fromBase64Url,
  generateNoiseKeyPair,
  openPush,
  sealPush,
  toBase64Url,
  utf8Decode,
  type BurrowAclRecord,
  type NoiseKeyPair,
  type PushSendRequest,
} from 'remote-lib-common';
import { loadPushDevices, sendPush, toPushText, type AlertPushDeps } from './push-delivery';
import { clearPushDevices, commitPushDevices, getPushDevices, resetPushDevices } from '../../lib/push-devices';

/**
 * The Burrow's Relay calls (`docs/specs/alert.md` -> Push notifications): the
 * recipient rule, the title bounds, the seal, and the device list the Settings
 * dialog names. When a push is due is the host's delivery scheduler's, and
 * swallowing a failed one is `BurrowService.push`'s (`service.test.ts`).
 */

const ENROLLMENT = { relayUrl: 'https://relay.example', burrowToken: 'burrow-token' };

/**
 * Base64url of exactly 32 bytes is 43 characters, and `isBurrowAclRecord` checks
 * both E2E fields for that length exactly — a shorter fixture is dropped rather
 * than tested.
 */
function id32(name: string): string {
  return name.padEnd(43, '0').slice(0, 43);
}

/** Delivery is keyed on the record's `deliveryId`, never on who holds it. */
const PHONE = id32('delivery-phone');
const TABLET = id32('delivery-tablet');
/** Still subscribed on the Relay, no longer on this Burrow's ACL. */
const REVOKED = id32('delivery-revoked');

/**
 * Real X25519 statics, minted once: a push is sealed to the record's own Client
 * key, so a fixture key that cannot be imported would fail the seal rather than
 * the rule under test.
 */
let burrowStatic: NoiseKeyPair;
const clientStatics = new Map<string, NoiseKeyPair>();

beforeAll(async () => {
  burrowStatic = await generateNoiseKeyPair();
  for (const deliveryId of [PHONE, TABLET, REVOKED]) {
    clientStatics.set(deliveryId, await generateNoiseKeyPair());
  }
});

function aclRecord(deliveryId: string, label: string): BurrowAclRecord {
  return {
    burrowId: 'burrow-1',
    accountId: 'owner',
    passkeyCredentialId: 'cred',
    passkeyPublicKeyHash: 'hash',
    // The half a push is sealed to, so each recipient gets its own ciphertext.
    clientStaticPublicKey: toBase64Url(clientStatics.get(deliveryId)!.publicKey),
    deliveryId,
    approvedAt: 1,
    approvedBy: 'burrow-user',
    label,
    revokedAt: null,
  };
}

/**
 * A stand-in for the Burrow's seal: shape-correct, distinct per recipient, and
 * free of WebCrypto, so the cases below mint no keys. The real construction is
 * driven with real keys in `sealed push`.
 */
function fakeSeal(): AlertPushDeps['seal'] {
  let n = 0;
  return async (clientStaticPublicKey) => {
    n += 1;
    return { v: 1, salt: id32(`salt${n}`), ct: `${clientStaticPublicKey}${n}` };
  };
}

/** The real construction, standing in for `BurrowRuntime.sealPushForClient`. */
const realSeal: AlertPushDeps['seal'] = (clientStaticPublicKey, plaintext) =>
  sealPush({
    burrowStaticPrivateKey: burrowStatic.privateKey,
    clientStaticPublicKey: fromBase64Url(clientStaticPublicKey),
    plaintext,
  });

/** Requests made of the Relay, in order. */
let requests: Array<{ url: string; init?: RequestInit }>;
let subscribed: string[];
let records: BurrowAclRecord[];

function fakeFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/api/push/devices')) {
      return {
        ok: true,
        json: async () => ({
          devices: subscribed.map((deliveryId) => ({ deliveryId, subscribedAt: 1 })),
        }),
      } as Response;
    }
    return {
      ok: true,
      json: async () => ({ delivered: 1, expired: 0, unknown: 0, failed: 0 }),
    } as Response;
  }) as unknown as typeof globalThis.fetch;
}

function deps(overrides: Partial<AlertPushDeps> = {}): AlertPushDeps {
  return {
    enrollment: ENROLLMENT,
    activeRecords: () => records,
    seal: fakeSeal(),
    fetch: fakeFetch(),
    ...overrides,
  };
}

/** As the settings dialog asks for it, over the bridge (`activation.ts`). */
function refreshPushDevices(pushDeps: AlertPushDeps): Promise<void> {
  return commitPushDevices(() => loadPushDevices(pushDeps));
}

/** The body of the last `push/send` request, parsed. */
function lastSend(): PushSendRequest | null {
  const send = requests.filter((r) => r.url.endsWith('/api/push/send')).at(-1);
  return send ? (JSON.parse(String(send.init?.body)) as PushSendRequest) : null;
}

/** Who the last send addressed, in order. */
function lastRecipients(): string[] {
  return lastSend()?.recipients.map((r) => r.deliveryId) ?? [];
}

beforeEach(() => {
  requests = [];
  subscribed = [PHONE];
  records = [aclRecord(PHONE, 'iPhone Safari')];
  resetPushDevices();
});

afterEach(() => {
  resetPushDevices();
});

/**
 * A push payload crosses a network to a third-party push service and is
 * rendered by the OS, and the label it carries is ultimately terminal-supplied
 * (`docs/specs/alert.md` -> Text And Security).
 */
describe('toPushText', () => {
  it('keeps ordinary labels intact, including angle brackets', () => {
    // Unlike speech: the bracket rule exists only because WebKit's synthesizer
    // wedges on them, which has nothing to do with a notification.
    expect(toPushText('<idle> zsh')).toBe('<idle> zsh');
  });

  it('replaces control characters with spaces', () => {
    expect(toPushText('build\u0000finished\u001b')).toBe('build finished');
  });

  it('strips bidi overrides that could reorder text on a lock screen', () => {
    expect(toPushText('build ‮finished')).toBe('build finished');
  });

  it('strips the Arabic letter mark with the rest of the bidi set', () => {
    expect(toPushText('a؜b')).toBe('ab');
  });

  it('never cuts a surrogate pair at the cap', () => {
    // A UTF-16 slice landing mid-surrogate would ship a lone half that the
    // phone renders as U+FFFD.
    const capped = toPushText('x'.repeat(99) + '🚀');
    expect(capped.endsWith('🚀')).toBe(true);
  });

  it('strips zero-width characters rather than spacing them out', () => {
    expect(toPushText('bu​ild')).toBe('build');
  });

  it('collapses whitespace', () => {
    expect(toPushText('  build   finished \n')).toBe('build finished');
  });

  it('caps a pathological title', () => {
    expect(toPushText('x'.repeat(500))).toHaveLength(100);
  });

  it('falls back when nothing survives', () => {
    expect(toPushText('\u0000\u200b   ')).toBe('terminal');
  });
});

describe('sendPush', () => {
  it('sends the label sealed, tagged per Session', async () => {
    await sendPush(deps(), 'pty-1', 'terminal');
    expect(lastRecipients()).toEqual([PHONE]);
    // The label and the collapse tag are sealed, so nothing readable rides on
    // the request the Relay sees.
    const body = String(requests.at(-1)!.init?.body);
    expect(body).not.toContain('terminal');
    expect(body).not.toContain('pty-1');
  });

  it('names only devices still active in the ACL when it sends', async () => {
    // The Relay still holds a subscription for a revoked client — nothing
    // propagates a revocation — so the Burrow must not address it. It stays out
    // of the request because the ACL, read at the send, chooses targets.
    subscribed = [PHONE, REVOKED];
    records = [aclRecord(PHONE, 'iPhone Safari')];
    await sendPush(deps(), 'pty-1', 'terminal');
    expect(lastRecipients()).toEqual([PHONE]);
  });

  it('costs one request per alarm, not a lookup then a send', async () => {
    // The ACL is local, and the Relay intersects the names it is given with
    // its own subscriptions anyway — so asking it first would only add a round
    // trip to the one path whose whole value is timeliness.
    await sendPush(deps(), 'pty-1', 'terminal');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain('/api/push/send');
  });

  it('refuses redirects instead of sending Burrow data outside the allowlist', async () => {
    await loadPushDevices(deps());
    expect(requests[0]!.init?.redirect).toBe('error');

    requests.length = 0;
    await sendPush(deps(), 'pty-1', 'build');
    expect(requests[0]!.init?.redirect).toBe('error');
  });

  it('warns when the Relay accepted the send but no phone got it', async () => {
    // The send route answers 200 with counts even when every delivery failed —
    // a rotated VAPID key or a wedged push service must not be silent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const summary = await sendPush(deps({
      fetch: (async () => ({
        ok: true,
        json: async () => ({ delivered: 0, expired: 0, unknown: 0, failed: 1 }),
      })) as unknown as typeof globalThis.fetch,
    }), 'pty-1', 'terminal');
    expect(summary).toEqual({ targeted: 1, delivered: 0, failed: 1 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects when the Relay refuses the send', async () => {
    // A 401 from a revoked burrow token must not resolve as if it were sent.
    await expect(sendPush(deps({
      fetch: (async () => ({ ok: false, status: 401 })) as unknown as typeof globalThis.fetch,
    }), 'pty-1', 'terminal')).rejects.toThrow();
  });

  it('rejects when the Relay cannot be reached', async () => {
    await expect(sendPush(deps({
      fetch: (async () => {
        throw new Error('network down');
      }) as unknown as typeof globalThis.fetch,
    }), 'pty-1', 'terminal')).rejects.toThrow('network down');
  });

  it('sends nothing when no subscribed device is still authorized', async () => {
    records = [];
    expect(await sendPush(deps(), 'pty-1', 'terminal')).toEqual({ targeted: 0, delivered: 0, failed: 0 });
    expect(lastSend()).toBeNull();
  });
});

/**
 * The seal itself, against real statics: the Relay forwards these and reads
 * nothing (`docs/specs/remote-security-model.md` -> Push sealing). Driven
 * through `sendPush` rather than `sealPush` directly, so what is under test is
 * the payload the Burrow actually posts.
 */
describe('sealed push', () => {
  it('seals one distinct ciphertext per recipient, and posts no plaintext', async () => {
    records = [aclRecord(PHONE, 'iPhone Safari'), aclRecord(TABLET, 'iPad')];
    await sendPush(deps({ seal: realSeal }), 'pty-1', 'build finished');

    const recipients = lastSend()!.recipients;
    expect(recipients.map((r) => r.deliveryId)).toEqual([PHONE, TABLET]);
    // Same plaintext, two Client statics, two salts: nothing about the pair of
    // envelopes tells the Relay they carry the same notification.
    expect(recipients[0]!.sealed.ct).not.toEqual(recipients[1]!.sealed.ct);
    expect(recipients[0]!.sealed.salt).not.toEqual(recipients[1]!.sealed.salt);

    const body = String(requests.at(-1)!.init?.body);
    for (const secret of ['build finished', 'Needs attention', 'pty-1']) {
      expect(body).not.toContain(secret);
    }
  });

  it('opens with the recipient own key and with no other', async () => {
    records = [aclRecord(PHONE, 'iPhone Safari'), aclRecord(TABLET, 'iPad')];
    await sendPush(deps({ seal: realSeal }), 'pty-1', 'build finished');
    const [phone, tablet] = lastSend()!.recipients;

    const opened = await openPush({
      clientStaticPrivateKey: clientStatics.get(PHONE)!.privateKey,
      burrowStaticPublicKey: burrowStatic.publicKey,
      sealed: phone!.sealed,
    });
    expect(JSON.parse(utf8Decode(opened!))).toEqual({
      title: 'build finished',
      body: 'Needs attention',
      tag: 'pty-1',
    });

    // The other paired phone holds a delivery id it could present, and still
    // cannot read this envelope: the ACL record's static is what the seal binds.
    expect(
      await openPush({
        clientStaticPrivateKey: clientStatics.get(TABLET)!.privateKey,
        burrowStaticPublicKey: burrowStatic.publicKey,
        sealed: phone!.sealed,
      }),
    ).toBeNull();
    expect(
      await openPush({
        clientStaticPrivateKey: clientStatics.get(PHONE)!.privateKey,
        burrowStaticPublicKey: burrowStatic.publicKey,
        sealed: tablet!.sealed,
      }),
    ).toBeNull();
  });

  it('clamps the fan-out to the newest devices the send route accepts', async () => {
    // The Relay refuses the whole POST past this bound, so an unclamped Burrow
    // would reach nobody rather than most — and the end it keeps matters:
    // `activeRecords()` is in approval order and a re-paired phone mints a new
    // record without superseding the old one, so the front of the list is where
    // dead records accumulate.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ids = Array.from({ length: MAX_PUSH_QUERY_DELIVERY_IDS + 3 }, (_, i) =>
      id32(`delivery-${i}`),
    );
    // Real statics, since `aclRecord` seals against whatever this map holds.
    for (const deliveryId of ids) clientStatics.set(deliveryId, await generateNoiseKeyPair());
    records = ids.map((deliveryId, i) => aclRecord(deliveryId, `phone ${i}`));

    await sendPush(deps({ seal: realSeal }), 'pty-1', 'build finished');

    const reached = lastRecipients();
    expect(reached).toHaveLength(MAX_PUSH_QUERY_DELIVERY_IDS);
    expect(reached).toEqual(ids.slice(-MAX_PUSH_QUERY_DELIVERY_IDS));
    // The three oldest are the ones dropped, never the most recently paired.
    expect(reached).not.toContain(ids[0]);
    expect(reached).toContain(ids.at(-1));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps sealing for the rest when one recipient cannot be sealed for', async () => {
    // A corrupt record must cost that phone its notification, not every phone
    // its notification.
    records = [aclRecord(PHONE, 'iPhone Safari'), aclRecord(TABLET, 'iPad')];
    const seal: AlertPushDeps['seal'] = (clientStaticPublicKey, plaintext) =>
      clientStaticPublicKey === records[0]!.clientStaticPublicKey
        ? Promise.resolve(null)
        : realSeal(clientStaticPublicKey, plaintext);

    const summary = await sendPush(deps({ seal }), 'pty-1', 'build finished');

    expect(lastRecipients()).toEqual([TABLET]);
    expect(summary.targeted).toBe(1);
  });

  it('reaches nobody, loudly, when this Burrow has no usable static', async () => {
    // `sealPushForClient` answers null when the enrollment carries no importable
    // static; a send that silently reported success would read as "delivered".
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const summary = await sendPush(deps({ seal: async () => null }), 'pty-1', 'build');

    expect(summary).toEqual({ targeted: 0, delivered: 0, failed: 0 });
    expect(lastSend()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('push device list', () => {
  it('joins Relay subscriptions to ACL labels', async () => {
    // By `deliveryId`: the Relay knows the capability and nothing else, so the
    // Burrow is the only party that can put a human name against a row. The id is
    // the join key and stops here — it is a bearer capability, and the dialog
    // that reads this renders labels (`docs/specs/security-remote.md` -> "Trust boundary", the outbound FAIL IF).
    await refreshPushDevices(deps());
    expect(getPushDevices()).toEqual({
      status: 'ready',
      devices: [{ label: 'iPhone Safari' }],
    });
  });

  it('omits a subscribed device that is no longer in the ACL', async () => {
    subscribed = [PHONE, REVOKED];
    await refreshPushDevices(deps());
    expect(getPushDevices().devices).toEqual([{ label: 'iPhone Safari' }]);
  });

  it('reports error rather than an empty list when the Relay is unreachable', async () => {
    // "We could not ask" and "nothing is subscribed" must not look the same.
    await refreshPushDevices(
      deps({
        fetch: (async () => ({ ok: false, status: 500 })) as unknown as typeof globalThis.fetch,
      }),
    );
    expect(getPushDevices()).toEqual({ status: 'error', devices: [] });
  });

  it('discards a refresh that lands after the Burrow went away', async () => {
    // The enrolled gate disarms on `clearEnrollment` with one clear. A request
    // already on the wire resolves afterwards and would otherwise repopulate
    // the dialog with phones there is nothing to push to.
    let land: (response: Response) => void = () => {};
    const inFlight = refreshPushDevices(
      deps({
        fetch: (() =>
          new Promise((resolve) => {
            land = resolve;
          })) as unknown as typeof globalThis.fetch,
      }),
    );

    clearPushDevices();

    land({
      ok: true,
      json: async () => ({ devices: [{ deliveryId: PHONE, subscribedAt: 1 }] }),
    } as Response);
    await inFlight;

    expect(getPushDevices()).toEqual({ status: 'no-burrow', devices: [] });
  });

  it('keeps a newer refresh when an older request resolves last', async () => {
    records = [aclRecord(PHONE, 'iPhone Safari'), aclRecord(TABLET, 'iPad')];
    let resolveOlder: (response: Response) => void = () => {};
    const older = refreshPushDevices(
      deps({
        fetch: (() =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          })) as unknown as typeof globalThis.fetch,
      }),
    );
    const newer = refreshPushDevices(
      deps({
        fetch: (async () => ({
          ok: true,
          json: async () => ({ devices: [{ deliveryId: TABLET, subscribedAt: 2 }] }),
        })) as unknown as typeof globalThis.fetch,
      }),
    );

    await newer;
    expect(getPushDevices().devices).toEqual([{ label: 'iPad' }]);

    resolveOlder({
      ok: true,
      json: async () => ({ devices: [{ deliveryId: PHONE, subscribedAt: 1 }] }),
    } as Response);
    await older;

    expect(getPushDevices().devices).toEqual([{ label: 'iPad' }]);
  });
});
