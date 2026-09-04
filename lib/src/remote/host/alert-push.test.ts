import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/platform', () => ({
  getPlatform: () => ({ alertPublishSettings: vi.fn() }),
}));

import {
  MAX_PUSH_QUERY_DELIVERY_IDS,
  fromBase64Url,
  generateNoiseKeyPair,
  openPush,
  sealPush,
  toBase64Url,
  utf8Decode,
  type HostAclRecord,
  type NoiseKeyPair,
  type PushSendRequest,
} from 'remote-lib-common';
import { commitPushDevices, invalidatePushDeviceRefreshes, watchPushRings } from './alert-push';
// Delivery — the Server calls, the recipient rule, the title bounds — runs in
// the Host's process, so it lives beside neither webview nor sidecar.
import { loadPushDevices, sendPush, toPushText, type AlertPushDeps } from './push-delivery';
import { applyAlertSettingsFromHost, DEFAULT_ALERT_SETTINGS } from '../../lib/alert-settings';
import { getPushDevices, resetPushDevices } from '../../lib/push-devices';
import { clearPrimedActivity, primeActivity } from '../../lib/session-activity-store';

const PUSH_DELAY_MS = 20_000;

const ENROLLMENT = { serverUrl: 'https://relay.example', hostToken: 'host-token' };

/**
 * Base64url of exactly 32 bytes is 43 characters, and `isHostAclRecord` checks
 * both E2E fields for that length exactly — a shorter fixture is dropped rather
 * than tested.
 */
function id32(name: string): string {
  return name.padEnd(43, '0').slice(0, 43);
}

/** Delivery is keyed on the record's `deliveryId`, never on who holds it. */
const PHONE = id32('delivery-phone');
const TABLET = id32('delivery-tablet');
/** Still subscribed on the Server, no longer on this Host's ACL. */
const REVOKED = id32('delivery-revoked');

/**
 * Real X25519 statics, minted once: a push is sealed to the record's own Client
 * key, so a fixture key that cannot be imported would fail the seal rather than
 * the rule under test.
 */
let hostStatic: NoiseKeyPair;
const clientStatics = new Map<string, NoiseKeyPair>();

beforeAll(async () => {
  hostStatic = await generateNoiseKeyPair();
  for (const deliveryId of [PHONE, TABLET, REVOKED]) {
    clientStatics.set(deliveryId, await generateNoiseKeyPair());
  }
});

function aclRecord(deliveryId: string, label: string): HostAclRecord {
  return {
    hostId: 'host-1',
    accountId: 'owner',
    passkeyCredentialId: 'cred',
    passkeyPublicKeyHash: 'hash',
    // The half a push is sealed to, so each recipient gets its own ciphertext.
    clientStaticPublicKey: toBase64Url(clientStatics.get(deliveryId)!.publicKey),
    deliveryId,
    approvedAt: 1,
    approvedBy: 'host-user',
    label,
    revokedAt: null,
  };
}

/**
 * A stand-in for the Host's seal: shape-correct, distinct per recipient, and
 * free of WebCrypto, so the ring-delay cases below stay deterministic under
 * fake timers. The real construction is driven with real keys in `sealed push`.
 */
function fakeSeal(): AlertPushDeps['seal'] {
  let n = 0;
  return async (clientStaticPublicKey) => {
    n += 1;
    return { v: 1, salt: id32(`salt${n}`), ct: `${clientStaticPublicKey}${n}` };
  };
}

/** The real construction, standing in for `RemoteHost.sealPushForClient`. */
const realSeal: AlertPushDeps['seal'] = (clientStaticPublicKey, plaintext) =>
  sealPush({
    hostStaticPrivateKey: hostStatic.privateKey,
    clientStaticPublicKey: fromBase64Url(clientStaticPublicKey),
    plaintext,
  });

/** Requests the sink made, in order. */
let requests: Array<{ url: string; init?: RequestInit }>;
let subscribed: string[];
let records: HostAclRecord[];
let stop: (() => void) | null = null;

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

/**
 * The two shipped halves joined: the webview watches for rings and names the
 * Session (`watchPushRings`, in `activation.ts`), and the Host delivers with
 * its own ACL and swallows failures so a dead push never breaks the alert path
 * (`RemoteHostService.#push`). Wired here because they only meet across a
 * process boundary.
 */
function startPush(pushDeps: AlertPushDeps): () => void {
  return watchPushRings((id, title) => {
    void sendPush(pushDeps, id, title).catch((error: unknown) => {
      console.warn('remote-host: push notification failed', error);
    });
  });
}

/** As the settings dialog asks for it, over the bridge (`activation.ts`). */
function refreshPushDevices(pushDeps: AlertPushDeps): Promise<void> {
  return commitPushDevices(() => loadPushDevices(pushDeps));
}

function ring(id: string): void {
  primeActivity(id, { status: 'NOTHING_TO_SHOW' });
  primeActivity(id, { status: 'ALERT_RINGING' });
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
  vi.useFakeTimers();
  requests = [];
  subscribed = [PHONE];
  records = [aclRecord(PHONE, 'iPhone Safari')];
  clearPrimedActivity();
  resetPushDevices();
  applyAlertSettingsFromHost({
    ...DEFAULT_ALERT_SETTINGS,
    pushEnabled: true,
    pushDelayMs: PUSH_DELAY_MS,
  });
});

afterEach(() => {
  stop?.();
  stop = null;
  clearPrimedActivity();
  resetPushDevices();
  applyAlertSettingsFromHost(DEFAULT_ALERT_SETTINGS);
  vi.useRealTimers();
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

describe('alarm push', () => {
  it('sends the pane label after the delay, tagged per Session', async () => {
    stop = startPush(deps());
    ring('pty-1');

    await vi.advanceTimersByTimeAsync(PUSH_DELAY_MS - 1);
    expect(lastSend()).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(lastRecipients()).toEqual([PHONE]);
    // The label and the collapse tag are sealed, so nothing readable rides on
    // the request the Server sees.
    const body = String(requests.at(-1)!.init?.body);
    expect(body).not.toContain('terminal');
    expect(body).not.toContain('pty-1');
  });

  it('sends nothing while pushEnabled is off', async () => {
    applyAlertSettingsFromHost({ ...DEFAULT_ALERT_SETTINGS, pushEnabled: false });
    stop = startPush(deps());
    ring('pty-1');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(lastSend()).toBeNull();
  });

  it('uses pushDelayMs as the delay', async () => {
    applyAlertSettingsFromHost({
      ...DEFAULT_ALERT_SETTINGS,
      pushEnabled: true,
      pushDelayMs: 5_000,
    });
    stop = startPush(deps());
    ring('pty-1');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(lastSend()).not.toBeNull();
  });

  it('names only devices still active in the ACL', async () => {
    // The server still holds a subscription for a revoked client — nothing
    // propagates a revocation — so the Host must not address it. It stays out
    // of the request because the ACL, not the server's list, chooses targets.
    subscribed = [PHONE, REVOKED];
    records = [aclRecord(PHONE, 'iPhone Safari')];
    stop = startPush(deps());
    ring('pty-1');

    await vi.advanceTimersByTimeAsync(PUSH_DELAY_MS);
    expect(lastRecipients()).toEqual([PHONE]);
  });

  it('costs one request per alarm, not a lookup then a send', async () => {
    // The ACL is local, and the Server intersects the names it is given with
    // its own subscriptions anyway — so asking it first would only add a round
    // trip to the one path whose whole value is timeliness.
    stop = startPush(deps());
    ring('pty-1');

    await vi.advanceTimersByTimeAsync(PUSH_DELAY_MS);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain('/api/push/send');
  });

  it('refuses redirects instead of sending Host data outside the allowlist', async () => {
    await loadPushDevices(deps());
    expect(requests[0]!.init?.redirect).toBe('error');

    requests.length = 0;
    await sendPush(deps(), 'pty-1', 'build');
    expect(requests[0]!.init?.redirect).toBe('error');
  });

  it('warns when the server accepted the send but no phone got it', async () => {
    // The send route answers 200 with counts even when every delivery failed —
    // a rotated VAPID key or a wedged push service must not be silent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stop = startPush(
      deps({
        fetch: (async () => ({
          ok: true,
          json: async () => ({ delivered: 0, expired: 0, unknown: 0, failed: 1 }),
        })) as unknown as typeof globalThis.fetch,
      }),
    );
    ring('pty-1');

    await vi.advanceTimersByTimeAsync(PUSH_DELAY_MS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns rather than failing silently when the server rejects the send', async () => {
    // A 401 from a revoked host token would otherwise resolve normally and
    // leave push permanently broken with nothing in the console.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stop = startPush(
      deps({
        fetch: (async () => ({ ok: false, status: 401 })) as unknown as typeof globalThis.fetch,
      }),
    );
    ring('pty-1');

    await vi.advanceTimersByTimeAsync(PUSH_DELAY_MS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('sends nothing when no subscribed device is still authorized', async () => {
    records = [];
    stop = startPush(deps());
    ring('pty-1');

    await vi.advanceTimersByTimeAsync(PUSH_DELAY_MS);
    expect(lastSend()).toBeNull();
  });

  it('re-reads the target list at send time, not at schedule time', async () => {
    stop = startPush(deps());
    ring('pty-1');
    // Revoked during the delay.
    records = [];

    await vi.advanceTimersByTimeAsync(PUSH_DELAY_MS);
    expect(lastSend()).toBeNull();
  });

  it('survives a server that cannot be reached', async () => {
    const failing = deps({
      fetch: (async () => {
        throw new Error('network down');
      }) as unknown as typeof globalThis.fetch,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stop = startPush(failing);
    ring('pty-1');

    await expect(vi.advanceTimersByTimeAsync(60_000)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * The seal itself, against real statics: the Server forwards these and reads
 * nothing (`docs/specs/remote-security-model.md` -> Push sealing). Driven
 * through `sendPush` rather than `sealPush` directly, so what is under test is
 * the payload the Host actually posts.
 */
describe('sealed push', () => {
  it('seals one distinct ciphertext per recipient, and posts no plaintext', async () => {
    records = [aclRecord(PHONE, 'iPhone Safari'), aclRecord(TABLET, 'iPad')];
    await sendPush(deps({ seal: realSeal }), 'pty-1', 'build finished');

    const recipients = lastSend()!.recipients;
    expect(recipients.map((r) => r.deliveryId)).toEqual([PHONE, TABLET]);
    // Same plaintext, two Client statics, two salts: nothing about the pair of
    // envelopes tells the Server they carry the same notification.
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
      hostStaticPublicKey: hostStatic.publicKey,
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
        hostStaticPublicKey: hostStatic.publicKey,
        sealed: phone!.sealed,
      }),
    ).toBeNull();
    expect(
      await openPush({
        clientStaticPrivateKey: clientStatics.get(PHONE)!.privateKey,
        hostStaticPublicKey: hostStatic.publicKey,
        sealed: tablet!.sealed,
      }),
    ).toBeNull();
  });

  it('clamps the fan-out to the newest devices the send route accepts', async () => {
    // The Server refuses the whole POST past this bound, so an unclamped Host
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

  it('reaches nobody, loudly, when this Host has no usable static', async () => {
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
  it('joins server subscriptions to ACL labels', async () => {
    // By `deliveryId`: the Server knows the capability and nothing else, so the
    // Host is the only party that can put a human name against a row. The id is
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

  it('reports error rather than an empty list when the server is unreachable', async () => {
    // "We could not ask" and "nothing is subscribed" must not look the same.
    await refreshPushDevices(
      deps({
        fetch: (async () => ({ ok: false, status: 500 })) as unknown as typeof globalThis.fetch,
      }),
    );
    expect(getPushDevices()).toEqual({ status: 'error', devices: [] });
  });

  it('discards a refresh that lands after the Host went away', async () => {
    // The enrolled gate disarms on `clearEnrollment` and resets the store to
    // `no-host`. A request already on the wire resolves afterwards and would
    // otherwise repopulate the dialog with phones there is nothing to push to.
    let land: (response: Response) => void = () => {};
    const inFlight = refreshPushDevices(
      deps({
        fetch: (() =>
          new Promise((resolve) => {
            land = resolve;
          })) as unknown as typeof globalThis.fetch,
      }),
    );

    invalidatePushDeviceRefreshes();
    resetPushDevices();

    land({
      ok: true,
      json: async () => ({ devices: [{ deliveryId: PHONE, subscribedAt: 1 }] }),
    } as Response);
    await inFlight;

    expect(getPushDevices()).toEqual({ status: 'no-host', devices: [] });
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
