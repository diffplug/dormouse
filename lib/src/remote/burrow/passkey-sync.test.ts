/**
 * The asking half of `docs/specs/remote-security-model.md` -> "Relay-named
 * revocation": what goes to the Relay, what its answer can do, and how often. A
 * Relay here is only a scripted `fetch`, since it is trusted with nothing. The
 * service's half, the revocation itself and who it logs, is in
 * `lib/src/host/remote/service.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_ROUTES, MAX_PASSKEY_QUERY_IDS, type BurrowAclRecord } from 'remote-lib-common';

import { fakeTimers, type FakeTimers } from '../test-timers';
import { settle } from '../test-e2e-client';
import {
  PASSKEY_QUERY_RETRIES,
  PASSKEY_QUERY_RETRY_MS,
  PASSKEY_QUERY_SPACING_MS,
  createPasskeySync,
  type PasskeySync,
} from './passkey-sync';

const RELAY = 'https://relay.example';

function record(passkeyCredentialId: string, seed = passkeyCredentialId): BurrowAclRecord {
  return {
    burrowId: 'burrow-1',
    accountId: 'owner',
    passkeyCredentialId,
    passkeyPublicKeyHash: 'hash',
    clientStaticPublicKey: `static-${seed}`,
    deliveryId: `delivery-${seed}`,
    approvedAt: 1,
    approvedBy: 'burrow-user',
    label: 'Phone',
    revokedAt: null,
  };
}

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('createPasskeySync', () => {
  let timers: FakeTimers;
  let records: BurrowAclRecord[];
  let connected: boolean;
  let revoked: string[];
  let revoke: (id: string) => Promise<unknown>;
  /** What the Relay answers an ask with; a function may reject or hold. */
  let relay: (ids: string[]) => Response | Promise<Response>;
  let asks: { url: string; init: RequestInit; ids: string[] }[];
  let sync: PasskeySync;

  beforeEach(() => {
    timers = fakeTimers();
    records = [record('phone')];
    connected = true;
    revoked = [];
    revoke = async (id) => void revoked.push(id);
    relay = () => answer({ removed: [] });
    asks = [];
    sync = createPasskeySync({
      enrollment: { relayUrl: RELAY, burrowToken: 'tok' },
      fetch: (async (url: string, init: RequestInit) => {
        const { credentialIds } = JSON.parse(String(init.body)) as { credentialIds: string[] };
        asks.push({ url, init, ids: credentialIds });
        return relay(credentialIds);
      }) as unknown as typeof globalThis.fetch,
      connected: () => connected,
      activeRecords: () => records,
      revoke: (id) => revoke(id),
      setTimer: timers.setTimer,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    sync.stop();
    vi.restoreAllMocks();
  });

  it('asks on the Burrow token, sends each credential id once, and nothing else of a record', async () => {
    records = [record('phone', 'tab'), record('phone', 'install'), record('tablet')];
    sync.request();
    await settle();

    expect(asks).toHaveLength(1);
    expect(asks[0]!.url).toBe(`${RELAY}${API_ROUTES.burrowPasskeysRemoved}`);
    expect(asks[0]!.init.headers).toMatchObject({ authorization: 'Bearer tok' });
    expect(asks[0]!.init.redirect).toBe('error');
    expect(JSON.parse(String(asks[0]!.init.body))).toEqual({ credentialIds: ['phone', 'tablet'] });
  });

  it('revokes each id named, and leaves a passkey the account still holds alone', async () => {
    records = [record('phone'), record('tablet'), record('laptop')];
    relay = () => answer({ removed: ['phone', 'laptop'] });
    sync.request();
    await settle();

    expect(revoked).toEqual(['phone', 'laptop']);
  });

  it('ignores an id it did not ask about, and anything in the answer that is not an id', async () => {
    relay = () => answer({ removed: ['someone-else', 7, null, { id: 'phone' }, 'phone', 'phone'] });
    sync.request();
    await settle();

    expect(revoked).toEqual(['phone']);
  });

  it('asks nothing with no active record', async () => {
    records = [];
    sync.request();
    await settle();

    expect(asks).toEqual([]);
  });

  it('asks nothing with no relay socket, or a latched Burrow, its next open asking instead', async () => {
    connected = false;
    sync.request();
    await settle();
    expect(asks).toEqual([]);
    // Not retried: nothing failed.
    expect(timers.live.map((timer) => timer.delayMs)).toEqual([PASSKEY_QUERY_SPACING_MS]);

    connected = true;
    timers.fire();
    sync.request();
    await settle();
    expect(asks).toHaveLength(1);
  });

  it('asks in batches within the Relay’s bound, revoking what each answered', async () => {
    const count = MAX_PASSKEY_QUERY_IDS + 2;
    records = Array.from({ length: count }, (_, i) => record(`id-${i}`));
    relay = (ids) => answer({ removed: ids.filter((id) => id === 'id-0' || id === `id-${count - 1}`) });
    sync.request();
    await settle();

    expect(asks.map((ask) => ask.ids.length)).toEqual([MAX_PASSKEY_QUERY_IDS, 2]);
    expect(revoked).toEqual(['id-0', `id-${count - 1}`]);
  });

  it.each([
    ['no answer', () => Promise.reject(new Error('offline'))],
    ['a 5xx', () => answer({ removed: ['phone'] }, 503)],
    ['a body that is not JSON', () => new Response('<!doctype html>')],
    ['no list', () => answer({ removed: 'phone' })],
    ['no field', () => answer({ gone: ['phone'] })],
    ['null', () => answer(null)],
  ])('revokes nothing on %s, and tries again a bounded number of times', async (_name, failing) => {
    relay = failing as typeof relay;
    sync.request();
    await settle();
    expect(asks).toHaveLength(1);

    for (let retry = 1; retry <= PASSKEY_QUERY_RETRIES; retry++) {
      timers.fireAt(PASSKEY_QUERY_RETRY_MS);
      await settle();
      expect(asks).toHaveLength(1 + retry);
    }
    // The budget is spent: only the spacing is left armed, and nothing is pending.
    timers.fireAt(PASSKEY_QUERY_SPACING_MS);
    await settle();
    expect(asks).toHaveLength(1 + PASSKEY_QUERY_RETRIES);
    expect(timers.live).toEqual([]);
    expect(revoked).toEqual([]);

    // The next open or nudge asks again, and an answer then revokes.
    relay = () => answer({ removed: ['phone'] });
    sync.request();
    await settle();
    expect(revoked).toEqual(['phone']);
  });

  it.each([404, 401, 403, 400])('revokes nothing on a %i and does not ask again: no retry changes it', async (status) => {
    // A 404 is a Relay older than the route, which must not break for it.
    relay = () => answer({ removed: ['phone'] }, status);
    sync.request();
    await settle();

    expect(revoked).toEqual([]);
    timers.fireAt(PASSKEY_QUERY_SPACING_MS);
    await settle();
    expect(asks).toHaveLength(1);
  });

  it('asks once more after a nudge that lands while it asks, so a removal racing a reconnect is not lost', async () => {
    let release = (_response: Response): void => {};
    relay = () => new Promise<Response>((resolve) => (release = resolve));
    sync.request();
    await settle();

    // The first read predates the commit; the nudge follows it.
    sync.request();
    await settle();
    expect(asks).toHaveLength(1);
    release(answer({ removed: [] }));
    await settle();
    expect(revoked).toEqual([]);

    relay = () => answer({ removed: ['phone'] });
    timers.fireAt(PASSKEY_QUERY_SPACING_MS);
    await settle();
    expect(asks).toHaveLength(2);
    expect(revoked).toEqual(['phone']);
  });

  it('holds a hostile Relay’s nudges to one ask per spacing', async () => {
    sync.request();
    await settle();
    for (let nudge = 0; nudge < 1000; nudge++) sync.request();
    await settle();
    expect(asks).toHaveLength(1);

    timers.fireAt(PASSKEY_QUERY_SPACING_MS);
    await settle();
    expect(asks).toHaveLength(2);

    // Nothing arrived since: the spacing ends and nothing is asked.
    timers.fireAt(PASSKEY_QUERY_SPACING_MS);
    await settle();
    expect(asks).toHaveLength(2);
    expect(timers.live).toEqual([]);
  });

  it('carries on past a revocation that fails', async () => {
    records = [record('phone'), record('tablet')];
    relay = () => answer({ removed: ['phone', 'tablet'] });
    revoke = async (id) => {
      revoked.push(id);
      if (id === 'phone') throw new Error('disk full');
    };
    sync.request();
    await settle();

    expect(revoked).toEqual(['phone', 'tablet']);
  });

  it('stopped, revokes nothing it was still waiting to hear, asks nothing, and leaves no timer armed', async () => {
    let release = (_response: Response): void => {};
    relay = () => new Promise<Response>((resolve) => (release = resolve));
    sync.request();
    await settle();
    sync.stop();
    release(answer({ removed: ['phone'] }));
    await settle();

    expect(revoked).toEqual([]);
    expect(timers.live).toEqual([]);
    sync.request();
    await settle();
    expect(asks).toHaveLength(1);
  });

  it('stopped mid-spacing, leaves no timer armed', async () => {
    sync.request();
    await settle();
    expect(timers.live).toHaveLength(1);

    sync.stop();
    expect(timers.live).toEqual([]);
  });
});
