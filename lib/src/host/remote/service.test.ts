/**
 * The Node-resident Host, driven the way both of its neighbours drive it: the
 * webview through `handleCommand`, and the relay through a fake `/ws/host`
 * socket. The point of most cases here is that nothing a webview says can widen
 * access — recipients, the ACL, and the allowlist are all read on this side.
 */

import { hostname } from 'node:os';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_ROUTES,
  mintNoiseStaticKeyPair,
  parsePairingInvitationUrl,
  generateNoiseKeyPair,
  toBase64Url,
  type EnrollmentOffer,
  type HostAclRecord,
} from 'server-lib-common';
import type { HostEnrollment } from '../../remote/host/enrollment';
import type { HostSurfaceProvider } from '../../remote/host/host-surface-provider';
import { FakeSocket } from '../../remote/test-fake-socket';
import {
  createTestAuthenticator,
  openPairingSession,
  pairThroughSocket,
  readOutcome,
  settle,
  testRoutingId,
  type TestAuthenticator,
} from '../../remote/test-e2e-client';
import { createEphemeralHostStateStore, type HostStateStore } from './host-state-store';
import { RemoteHostService } from './service';
import type {
  HostStatusEvent,
  InvitationEvent,
  PairingQueueEvent,
  RemoteHostConsoleStatus,
  SetupQrResult,
} from './service-protocol';

const CONNECT_SRC = 'https://*.dormouse.sh wss://*.dormouse.sh';
const HOST_ID = testRoutingId();
const ORIGIN = 'https://relay.dormouse.sh';

/**
 * The enrollment every case runs on, with a **real** Noise static: without one
 * the service backfills and persists a fresh key on start, which is its own
 * case below rather than a hidden write under every other.
 */
let ENROLLMENT: HostEnrollment;

beforeAll(async () => {
  const material = await mintNoiseStaticKeyPair();
  ENROLLMENT = {
    serverUrl: ORIGIN,
    hostId: HOST_ID,
    hostToken: 'tok',
    origin: ORIGIN,
    rpId: 'relay.dormouse.sh',
    label: 'Laptop',
    noiseStaticPrivateKey: material.privateKeyPkcs8,
    noiseStaticPublicKey: material.publicKey,
  };
});

/**
 * A v2 ACL record. Both E2E fields are checked for exact length on read, so a
 * fixture that spelled them loosely would be dropped rather than asserted on.
 */
function aclRecord(seed: string, label = 'iPhone Safari'): HostAclRecord {
  const pad = (text: string): string => text.padEnd(43, 'A').slice(0, 43);
  return {
    hostId: HOST_ID,
    accountId: 'owner',
    passkeyCredentialId: 'cred',
    passkeyPublicKeyHash: 'hash',
    clientStaticPublicKey: pad(`client-${seed}`),
    deliveryId: pad(`delivery-${seed}`),
    approvedAt: 1,
    approvedBy: 'host-user',
    label,
    revokedAt: null,
  };
}

interface MemoryStore extends HostStateStore {
  enrollment: HostEnrollment | null;
  acl: Record<string, HostAclRecord[]>;
}

/**
 * A durable store whose contents a test can seed and read back — not
 * `createEphemeralHostStateStore`, whose whole point is `persistent: false`,
 * which is what the adopt cases turn on.
 */
function memoryStore(seed: Partial<Pick<MemoryStore, 'enrollment' | 'acl'>> = {}): MemoryStore {
  const store: MemoryStore = {
    persistent: true,
    enrollment: seed.enrollment ?? null,
    acl: seed.acl ?? {},
    loadEnrollment: async () => store.enrollment,
    saveEnrollment: async (enrollment) => {
      store.enrollment = enrollment;
    },
    clearEnrollment: async () => {
      store.enrollment = null;
    },
    loadAcl: async (hostId) => store.acl[hostId] ?? [],
    saveAcl: async (hostId, records) => {
      store.acl[hostId] = [...records];
    },
  };
  return store;
}

function fakeProvider(): HostSurfaceProvider {
  return {
    collectDirectory: async () => [],
    watchDirectory: () => () => {},
    resolveSurface: async () => null,
    writePty: () => {},
    resizePty: () => {},
    streamPty: () => () => {},
  };
}

let sockets: FakeSocket[];
let sent: Array<{ event: string; data: Record<string, unknown> }>;
let requests: Array<{ url: string; init?: RequestInit }>;
let store: MemoryStore;
let service: RemoteHostService;
let commandSeq = 0;

/** How many setup tokens the fake server has minted, so each one is distinct. */
let setupTokensMinted: number;
/** Make `POST /api/host/setup-token` answer a 200 that is not a setup token. */
let setupTokenMalformed: boolean;
/** What the fake server puts in `expiresAt`; a test moves it to expire one. */
let setupTokenTtlMs: number;

/** A server that answers enroll, setup-token, push/send, and push/devices. */
function fakeFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith(API_ROUTES.hostSetupToken)) {
      return {
        ok: true,
        json: async () =>
          setupTokenMalformed
            ? { expiresAt: Date.now() + setupTokenTtlMs }
            : {
                // A real-shaped token: it goes straight into the positional QR
                // fragment, which pins its length.
                token: toBase64Url(new Uint8Array(32).fill(++setupTokensMinted)),
                expiresAt: Date.now() + setupTokenTtlMs,
              },
      } as Response;
    }
    if (url.endsWith('/api/host/enroll')) {
      return {
        ok: true,
        json: async () => ({
          hostId: HOST_ID,
          hostToken: 'tok',
          origin: new URL(url).origin,
          rpId: new URL(url).hostname,
        }),
      } as Response;
    }
    if (url.endsWith('/api/push/devices')) {
      return {
        ok: true,
        json: async () => ({
          devices: [
            { deliveryId: aclRecord('1').deliveryId, subscribedAt: 1 },
            { deliveryId: aclRecord('revoked').deliveryId, subscribedAt: 1 },
          ],
        }),
      } as Response;
    }
    return {
      ok: true,
      json: async () => ({ delivered: 1, expired: 0, unknown: 0, failed: 0 }),
    } as Response;
  }) as unknown as typeof globalThis.fetch;
}

/**
 * The offer reader is always injected, never the real one: whether these tests
 * pass must not depend on whether the machine running them has a Dormouse
 * server installed. `offerReads` counts the calls, which is how the "an enrolled
 * Host does not touch the disk" case is stated.
 */
let offer: EnrollmentOffer | null;
let offerReads: number;
/** Set to suspend the injected reader mid-read, so a status can be raced. */
let offerGate: Promise<void> | null;

const OFFER: EnrollmentOffer = {
  origin: 'https://relay.dormouse.sh',
  token: 'a'.repeat(64),
  mintedAt: '2026-08-31T00:00:00.000Z',
};

function createService(seed?: Partial<Pick<MemoryStore, 'enrollment' | 'acl'>>): RemoteHostService {
  store = memoryStore(seed);
  service = new RemoteHostService({
    store,
    provider: fakeProvider(),
    sendToUi: (event, data) => sent.push({ event, data: data as Record<string, unknown> }),
    connectSrc: CONNECT_SRC,
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    fetch: fakeFetch(),
    readOffer: async () => {
      offerReads++;
      if (offerGate) await offerGate;
      return offer;
    },
  });
  return service;
}

/** The JSON body of the nth request, for asserting what a credential carried. */
function requestBody(index: number): Record<string, unknown> {
  return JSON.parse(requests[index]!.init!.body as string) as Record<string, unknown>;
}

/** Run a command and return the `remoteHost:result` it produced. */
async function command(cmd: string, params?: unknown): Promise<Record<string, unknown>> {
  const rhId = `c-${++commandSeq}`;
  await service.handleCommand({ rhId, cmd, params });
  const result = sent
    .filter((message) => message.event === 'remoteHost:result')
    .find((message) => message.data.rhId === rhId);
  if (!result) throw new Error(`no result for ${cmd}`);
  return result.data;
}

function queueEvents(): PairingQueueEvent[] {
  return uiEvents().filter((event): event is PairingQueueEvent => event.name === 'pairing-queue');
}

function uiEvents(): Array<PairingQueueEvent | HostStatusEvent | InvitationEvent> {
  return sent
    .filter((message) => message.event === 'remoteHost:event')
    .map(
      (message) =>
        message.data as unknown as PairingQueueEvent | HostStatusEvent | InvitationEvent,
    );
}

function invitationEvents(): InvitationEvent[] {
  return uiEvents().filter((event): event is InvitationEvent => event.name === 'invitation');
}

/** What the webviews were told about whether there is a Host, in order. */
function statusEvents(): boolean[] {
  return uiEvents()
    .filter((event): event is HostStatusEvent => event.name === 'status')
    .map((event) => event.enrolled);
}

beforeEach(() => {
  sockets = [];
  sent = [];
  requests = [];
  offer = null;
  offerReads = 0;
  offerGate = null;
  setupTokensMinted = 0;
  setupTokenMalformed = false;
  setupTokenTtlMs = 5 * 60 * 1000;
  vi.stubGlobal('fetch', fakeFetch());
});

afterEach(() => {
  service?.dispose();
  vi.unstubAllGlobals();
});

describe('status', () => {
  it('reports a Host that has not been enrolled', async () => {
    createService();
    await service.start();
    expect((await command('status')).result).toEqual({
      enrolled: false,
      serverUrl: null,
      hostId: null,
      connection: 'stopped',
      pairedClients: 0,
      suggestedLabel: hostname(),
      offer: null,
    } satisfies RemoteHostConsoleStatus);
  });

  it('offers the installer’s enrollment while un-enrolled, without its token', async () => {
    offer = OFFER;
    createService();
    await service.start();

    expect((await command('status')).result).toEqual({
      enrolled: false,
      serverUrl: null,
      hostId: null,
      connection: 'stopped',
      pairedClients: 0,
      suggestedLabel: hostname(),
      offer: { origin: OFFER.origin },
    } satisfies RemoteHostConsoleStatus);
    // The one-time token is a bearer credential and this is a service→webview
    // shape (docs/specs/security-application.md -> "Trust boundary"), so it must not appear anywhere in what was sent.
    expect(JSON.stringify(sent)).not.toContain(OFFER.token);
  });

  it('reports no offer, and reads no file, once enrolled', async () => {
    // What bounds the read to the un-enrolled state: an enrolled machine has
    // nothing to offer, so the 2 s poll must not stat a file every tick.
    offer = OFFER;
    createService({ enrollment: ENROLLMENT });
    await service.start();

    expect((await command('status')).result).toMatchObject({ enrolled: true, offer: null });
    expect(offerReads).toBe(0);
  });

  it('reports the relay socket and the paired count once running', async () => {
    createService({ enrollment: ENROLLMENT, acl: { [HOST_ID]: [aclRecord('device-1')] } });
    await service.start();
    sockets[0]!.open();

    expect((await command('status')).result).toEqual({
      enrolled: true,
      serverUrl: ENROLLMENT.serverUrl,
      hostId: HOST_ID,
      connection: 'connected',
      pairedClients: 1,
      suggestedLabel: hostname(),
      offer: null,
    } satisfies RemoteHostConsoleStatus);
  });

  it('cannot answer un-enrolled from a read an enroll finished under', async () => {
    // The seed `status` a webview issues on load reads the offer file, and an
    // enroll can complete during that await. The webview's gate is
    // last-writer-wins over the `{ enrolled: true }` event, so a snapshot built
    // from an `#enrollment` sampled *before* the read would disarm it — the
    // machine is enrolled and every gated behaviour is off until the next poll.
    offer = OFFER;
    createService();
    let release: () => void = () => {};
    offerGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // In flight and suspended inside the reader.
    const status = command('status');
    await Promise.resolve();
    expect(offerReads).toBe(1);

    // Now enroll, all the way through the `{ enrolled: true }` event...
    offerGate = null;
    await command('enroll', {
      serverUrl: 'https://relay.dormouse.sh',
      password: 'setup',
      label: 'Laptop',
    });
    expect(statusEvents()).toEqual([true]);

    // ...and only then let the status read finish.
    release();
    expect((await status).result).toMatchObject({ enrolled: true, offer: null });
  });

  it('rejects a command it does not know', async () => {
    createService();
    expect((await command('nope')).error).toContain('nope');
  });
});

describe('enroll', () => {
  it('refuses an origin outside the build’s allowed sources', async () => {
    createService();
    const result = await command('enroll', {
      serverUrl: 'https://relay.example.com',
      password: 'setup',
      label: 'Laptop',
    });

    expect(result.error).toContain(CONNECT_SRC);
    // Refused before the setup password leaves the machine.
    expect(requests).toEqual([]);
    expect(store.enrollment).toBeNull();
  });

  it('enrolls, persists, and starts against an allowed origin', async () => {
    createService();
    const result = await command('enroll', {
      serverUrl: 'https://relay.dormouse.sh/',
      password: 'setup',
      label: 'Laptop',
    });

    expect(result.result).toEqual({ hostId: HOST_ID, serverUrl: ORIGIN });
    expect(store.enrollment?.hostToken).toBe('tok');
    expect(sockets).toHaveLength(1);
  });

  it('replaces a running Host rather than adding one', async () => {
    createService({ enrollment: ENROLLMENT });
    await service.start();
    sockets[0]!.open();

    await command('enroll', {
      serverUrl: 'https://other.dormouse.sh',
      password: 'setup',
      label: 'Laptop',
    });
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.readyState).toBe(3);
  });

  it('keeps the old Host when the new enrollment cannot be persisted', async () => {
    // The `hostToken` this exchange just minted exists nowhere else and cannot
    // be minted again, so stopping the old Host before the save is what turns
    // one failed write into a machine with no Host and a status that lies.
    createService({ enrollment: ENROLLMENT });
    await service.start();
    sockets[0]!.open();
    store.saveEnrollment = async () => {
      throw new Error('keychain is locked');
    };

    const result = await command('enroll', {
      serverUrl: 'https://other.dormouse.sh',
      password: 'setup',
      label: 'Laptop',
    });

    expect(result.error).toContain('keychain is locked');
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.readyState).toBe(1);
    expect((await command('status')).result).toMatchObject({
      enrolled: true,
      serverUrl: ENROLLMENT.serverUrl,
      connection: 'connected',
    });
  });

  it('cycles the enrolled gate when it swaps one running Host for another', async () => {
    // The webviews' gate is edge-triggered (`enrolled-gate.ts`), and what it
    // holds — the mirrored pairing queue, the push device list — belongs to the
    // server being left. With no `false` between the two Hosts the gate never
    // cycles and the Settings dialog keeps naming the old server's devices.
    createService({ enrollment: ENROLLMENT });
    await service.start();
    sockets[0]!.open();
    expect(statusEvents()).toEqual([true]);

    await command('enroll', {
      serverUrl: 'https://other.dormouse.sh',
      password: 'setup',
      label: 'Laptop',
    });

    expect(statusEvents()).toEqual([true, false, true]);
  });
});

describe('enrollOffer', () => {
  it('redeems the installer’s token, and sends no password', async () => {
    offer = OFFER;
    createService();

    const result = await command('enrollOffer', { origin: OFFER.origin, label: 'Laptop' });

    expect(result.result).toEqual({ hostId: HOST_ID, serverUrl: OFFER.origin });
    expect(requests).toHaveLength(1);
    // The credential and nothing else: the label the operator typed stays local.
    expect(requestBody(0)).toEqual({ enrollToken: OFFER.token });
    expect(requestBody(0)).not.toHaveProperty('password');
    // Same store-first persistence and same started Host as the typed form.
    expect(store.enrollment?.hostToken).toBe('tok');
    expect(sockets).toHaveLength(1);
    expect(statusEvents()).toEqual([true]);
  });

  it('re-reads the offer at the click, not at the render', async () => {
    // Minutes pass between the card being painted and the button being pressed,
    // and redeeming an offer unlinks it — so the copy behind the button may be
    // spent. Nothing may leave the machine on the strength of the stale one.
    offer = OFFER;
    createService();
    await command('status');
    offer = null;

    const result = await command('enrollOffer', { origin: OFFER.origin, label: 'Laptop' });

    expect(result.error).toMatch(/no enrollment offer on this machine/i);
    expect(requests).toEqual([]);
    expect(store.enrollment).toBeNull();
  });

  it('refuses an offer whose origin is not the one the card displayed', async () => {
    // An installer rerun between the render and the click rewrites the file.
    // Enrolling against the new origin would spend a one-time token on a server
    // the user was never shown, so the webview's echo is what authorizes it.
    offer = OFFER;
    createService();
    await command('status');
    offer = { ...OFFER, origin: 'https://elsewhere.dormouse.sh' };

    const result = await command('enrollOffer', { origin: OFFER.origin, label: 'Laptop' });

    expect(result.error).toMatch(/offer changed/i);
    expect(result.error).toContain('https://elsewhere.dormouse.sh');
    // Nothing left the machine: not the token, and not against either origin.
    expect(requests).toEqual([]);
    expect(store.enrollment).toBeNull();
  });

  it('refuses an offer origin outside the build’s allowed sources', async () => {
    // The allowlist gate is the typed form's, unchanged: a server installed on
    // this machine is not thereby an origin this build may reach, and the
    // one-time token must not leave before that is checked.
    offer = { ...OFFER, origin: 'https://relay.example.com' };
    createService();

    const result = await command('enrollOffer', {
      origin: 'https://relay.example.com',
      label: 'Laptop',
    });

    expect(result.error).toContain(CONNECT_SRC);
    expect(requests).toEqual([]);
    expect(store.enrollment).toBeNull();
  });
});

describe('start', () => {
  it('stays idle, loudly, when the persisted server is no longer allowed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createService({ enrollment: { ...ENROLLMENT, serverUrl: 'https://relay.example.com' } });
    await service.start();

    expect(sockets).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect((await command('status')).result).toMatchObject({ connection: 'stopped' });
    warn.mockRestore();
  });

  it('reconnect is the way back, and start()s a Host that never ran', async () => {
    createService({ enrollment: ENROLLMENT });
    const status = (await command('reconnect')).result as RemoteHostConsoleStatus;
    expect(sockets).toHaveLength(1);
    expect(status).toMatchObject({ enrolled: true, connection: 'connecting' });
  });

  it('builds one Host when a start and a reconnect race', async () => {
    // Both read `#host`, both await the store, and both then act on what they
    // read. Unserialized they each see no Host and each build one — and the
    // second holds a relay socket nothing has a reference to, so it can never
    // be stopped and the two displace each other on the server forever.
    createService({ enrollment: ENROLLMENT });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seeded = store.loadEnrollment;
    store.loadEnrollment = async () => {
      await gate;
      return seeded();
    };

    const started = service.start();
    const reconnected = service.handleCommand({ rhId: 'race', cmd: 'reconnect' });
    release();
    await Promise.all([started, reconnected]);

    expect(sockets).toHaveLength(1);
    // And the one that exists is the one `dispose()` can reach.
    service.dispose();
    expect(sockets[0]!.readyState).toBe(3);
  });

  it('does not resurrect a Host when disposal lands during startup', async () => {
    createService({ enrollment: ENROLLMENT });
    let releaseAcl: () => void = () => {};
    let enteredAcl: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enteredAcl = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseAcl = resolve;
    });
    const seeded = store.loadAcl;
    store.loadAcl = async (hostId) => {
      enteredAcl();
      await gate;
      return seeded(hostId);
    };

    const starting = service.start();
    await entered;
    service.dispose();
    releaseAcl();
    await starting;

    expect(sockets).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('clearEnrollment stops the Host and forgets it, keeping the records', async () => {
    createService({ enrollment: ENROLLMENT, acl: { [HOST_ID]: [aclRecord('device-1')] } });
    await service.start();

    await command('clearEnrollment');
    expect(store.enrollment).toBeNull();
    // The records stay filed under their hostId: re-enrolling onto the same
    // host must not silently de-pair every device.
    expect(store.acl[HOST_ID]).toHaveLength(1);
    expect((await command('status')).result).toMatchObject({ enrolled: false, connection: 'stopped' });
  });

  it('stays enrolled — and running — when the enrollment cannot be deleted', async () => {
    // Reporting un-enrolled over a delete that failed is the worst outcome
    // available: the credential is still on disk, so the next launch reads it
    // back and every paired device is let in again by a Host the user believes
    // they removed.
    createService({ enrollment: ENROLLMENT });
    await service.start();
    sockets[0]!.open();
    store.clearEnrollment = async () => {
      throw new Error('keychain is locked');
    };

    expect((await command('clearEnrollment')).error).toContain('keychain is locked');
    expect(store.enrollment).toEqual(ENROLLMENT);
    expect(sockets[0]!.readyState).toBe(1);
    expect((await command('status')).result).toMatchObject({
      enrolled: true,
      serverUrl: ENROLLMENT.serverUrl,
      connection: 'connected',
    });
    expect(statusEvents()).toEqual([true]);
  });
});

describe('status events', () => {
  it('announces a Host that started, and one that was cleared', async () => {
    // What every webview arms its outbound work on: an installation that never
    // enrolls is told nothing and does nothing (`enrolled-gate.ts`).
    createService({ enrollment: ENROLLMENT });
    await service.start();
    expect(statusEvents()).toEqual([true]);

    await command('clearEnrollment');
    expect(statusEvents()).toEqual([true, false]);
  });

  it('says nothing at all when there is no Host to run', async () => {
    createService();
    await service.start();
    await command('status');
    expect(statusEvents()).toEqual([]);
  });

  it('announces the Host an enroll started', async () => {
    createService();
    await command('enroll', { serverUrl: ORIGIN, password: 'setup', label: 'Laptop' });
    expect(statusEvents()).toEqual([true]);
  });
});

describe('pairing queue', () => {
  let authenticator: TestAuthenticator;

  beforeAll(async () => {
    authenticator = await createTestAuthenticator({ rpId: ENROLLMENT.rpId, origin: ORIGIN });
  });

  async function running(): Promise<FakeSocket> {
    createService({ enrollment: ENROLLMENT });
    await service.start();
    const socket = sockets[0]!;
    socket.open();
    return socket;
  }

  /** Mint a code and run the Client half of a pairing against it. */
  async function pair(socket: FakeSocket, clientId: string, over: { code?: string; label?: string } = {}) {
    const qr = (await command('setupQr')).result as SetupQrResult;
    const invitation = await parsePairingInvitationUrl(qr.url, ORIGIN);
    if (!invitation) throw new Error(`the Host composed a URL Pocket cannot read: ${qr.url}`);
    const before = queueEvents().length;
    const paired = await pairThroughSocket({
      socket,
      hostId: ENROLLMENT.hostId,
      clientId,
      invitation,
      authenticator,
      ...over,
      until: () => queueEvents().length > before,
    });
    const item = queueEvents().at(-1)!.queue.find((entry) => entry.clientId === clientId)!;
    return { ...paired, invitation, item };
  }

  it('pushes a snapshot when a pairing arrives, and answers a seed request', async () => {
    const socket = await running();
    const { item } = await pair(socket, 'c1');

    const event = queueEvents().at(-1)!;
    expect(event.name).toBe('pairing-queue');
    expect(event.queue).toHaveLength(1);
    // Exactly four fields cross the bridge — and the expected code is not one
    // of them, which is the whole point of typing it on this side.
    expect(Object.keys(item).sort()).toEqual(['clientId', 'label', 'pairingId', 'requestedAt']);
    expect(item).toMatchObject({ clientId: 'c1', label: 'iPhone Safari' });
    expect(typeof item.pairingId).toBe('string');

    // A webview that reloaded mid-pairing seeds from the same snapshot.
    expect((await command('pairingQueue')).result).toEqual(event.queue);
  });

  it('never mirrors the code the Host is going to compare against', async () => {
    const socket = await running();
    // A code no other value in the exchange could coincidentally equal.
    await pair(socket, 'c1', { code: '73' });
    const mirrored = JSON.stringify(queueEvents());
    expect(mirrored).not.toContain('"73"');
    expect(mirrored).not.toContain('code');
  });

  it('approve types the code through, writes one record, and empties the queue', async () => {
    const socket = await running();
    const { item, session, invitation, code } = await pair(socket, 'c1');

    await command('approve', { clientId: 'c1', pairingId: item.pairingId, code });
    await settle();

    expect(await readOutcome(socket, session, 'pairing', invitation.inviteId)).toMatchObject({
      ok: true,
      hostLabel: ENROLLMENT.label,
    });
    expect(store.acl[HOST_ID]).toHaveLength(1);
    expect(store.acl[HOST_ID]![0]).toMatchObject({ label: 'iPhone Safari', revokedAt: null });
    expect(queueEvents().at(-1)!.queue).toEqual([]);
  });

  it('a mistyped code denies, writes nothing, and spends the one attempt', async () => {
    const socket = await running();
    const { item, session, invitation, code } = await pair(socket, 'c1', { code: '13' });

    await command('approve', { clientId: 'c1', pairingId: item.pairingId, code: '99' });
    await settle();
    expect(await readOutcome(socket, session, 'pairing', invitation.inviteId)).toEqual({
      ok: false,
      code: 'confirmation-mismatch',
    });
    expect(store.acl[HOST_ID]).toBeUndefined();
    // The queue is empty, so the right code has nothing left to answer.
    expect((await command('approve', { clientId: 'c1', pairingId: item.pairingId, code })).error)
      .toContain('no longer pending');
  });

  it('deny answers the client and writes no ACL', async () => {
    const socket = await running();
    const { item, session, invitation } = await pair(socket, 'c1');

    await command('deny', { clientId: 'c1', pairingId: item.pairingId });
    await settle();

    expect(await readOutcome(socket, session, 'pairing', invitation.inviteId)).toEqual({
      ok: false,
      code: 'user-denied',
    });
    expect(store.acl[HOST_ID]).toBeUndefined();
    expect(queueEvents().at(-1)!.queue).toEqual([]);
  });

  it('drops a client that went away, and a queue the socket took with it', async () => {
    const socket = await running();
    await pair(socket, 'c1');
    socket.receive({ t: 'client-gone', clientId: 'c1' });
    await settle();
    expect(queueEvents().at(-1)!.queue).toEqual([]);

    await pair(socket, 'c2');
    expect(queueEvents().at(-1)!.queue).toHaveLength(1);
    socket.close();
    await settle();
    expect(queueEvents().at(-1)!.queue).toEqual([]);
  });

  it('rejects approval for something already resolved', async () => {
    const socket = await running();
    const { item, code } = await pair(socket, 'c1');
    await command('approve', { clientId: 'c1', pairingId: item.pairingId, code });
    await settle();
    expect(
      (await command('approve', { clientId: 'c1', pairingId: item.pairingId, code })).error,
    ).toContain('no longer pending');
    expect(store.acl[HOST_ID]).toHaveLength(1);
  });

  it('rejects stale modal actions after the client replaces its pairing', async () => {
    const socket = await running();
    const first = await pair(socket, 'c1', { label: 'iPhone Safari' });
    const replacement = await pair(socket, 'c1', { label: 'Android Chrome', code: '55' });
    expect(replacement.item.pairingId).not.toBe(first.item.pairingId);

    // Both buttons from the still-rendered first modal are now stale. Neither
    // may resolve or authorize the replacement before it is shown.
    expect(
      (await command('approve', { clientId: 'c1', pairingId: first.item.pairingId, code: '55' }))
        .error,
    ).toContain('no longer pending');
    expect(
      (await command('deny', { clientId: 'c1', pairingId: first.item.pairingId })).error,
    ).toContain('no longer pending');
    expect(store.acl[HOST_ID]).toBeUndefined();
    expect(queueEvents().at(-1)!.queue).toEqual([replacement.item]);

    await command('approve', {
      clientId: 'c1',
      pairingId: replacement.item.pairingId,
      code: replacement.code,
    });
    await settle();
    expect(store.acl[HOST_ID]![0]).toMatchObject({ label: 'Android Chrome' });
  });
});

describe('setup QR', () => {
  /**
   * An enrollment whose `hostToken` cannot be confused with anything else in an
   * assertion — the shared fixture's `tok` is a substring of common words, and
   * this suite has to prove the bearer stays out of the webview.
   */
  let QR_ENROLLMENT: HostEnrollment;
  let authenticator: TestAuthenticator;

  beforeAll(async () => {
    QR_ENROLLMENT = { ...ENROLLMENT, hostToken: 'host-bearer-secret' };
    authenticator = await createTestAuthenticator({ rpId: ENROLLMENT.rpId, origin: ORIGIN });
  });

  async function running(enrollment: HostEnrollment = QR_ENROLLMENT): Promise<FakeSocket> {
    createService({ enrollment });
    await service.start();
    const socket = sockets[0]!;
    socket.open();
    return socket;
  }

  /**
   * Mint a code and read it back through the shared parser Pocket runs, so
   * every case below pins this emitter against that parser rather than against
   * a second copy of the grammar.
   */
  async function mint(): Promise<{ qr: SetupQrResult; invitation: NonNullable<Awaited<ReturnType<typeof parsePairingInvitationUrl>>> }> {
    const qr = (await command('setupQr')).result as SetupQrResult;
    const invitation = await parsePairingInvitationUrl(qr.url, ORIGIN);
    if (!invitation) throw new Error(`Pocket could not read the minted URL: ${qr.url}`);
    return { qr, invitation };
  }

  it('mints over the Host’s own authenticated channel and composes the URL here', async () => {
    await running();
    const { qr, invitation } = await mint();

    const posted = requests.at(-1)!;
    expect(posted.url).toBe(`${QR_ENROLLMENT.serverUrl}${API_ROUTES.hostSetupToken}`);
    expect((posted.init!.headers as Record<string, string>).authorization).toBe(
      'Bearer host-bearer-secret',
    );
    // An allowed origin's open redirect must not carry the bearer elsewhere.
    expect(posted.init!.redirect).toBe('error');

    // The origin is the enrollment's — the phone-facing WebAuthn origin — and
    // the whole invitation rides in the URL, which is the point of the command.
    expect(qr.url.startsWith(`${QR_ENROLLMENT.origin}/#pair?`)).toBe(true);
    expect(invitation.hostId).toBe(QR_ENROLLMENT.hostId);
    expect(invitation.inviteId).toBe(qr.inviteId);
    expect(invitation.setupToken).toBe(toBase64Url(new Uint8Array(32).fill(1)));

    // The invitation's private half never leaves the Host, and neither does the
    // bearer: only the code a human will scan crosses.
    expect(JSON.stringify(sent)).not.toContain('host-bearer-secret');
    expect(JSON.stringify(requests)).not.toContain(invitation.ephPubBase64Url);
  });

  it('reports the invitation live until a phone reserves it', async () => {
    const socket = await running();
    const { qr, invitation } = await mint();
    expect(invitationEvents()).toEqual([]);

    await pairThroughSocket({
      socket,
      hostId: QR_ENROLLMENT.hostId,
      clientId: 'c1',
      invitation,
      authenticator,
    });
    // The flip the panel keys on: a phone has completed the handshake, so the
    // code is spent whatever the person at the laptop decides next.
    expect(invitationEvents()).toContainEqual({
      name: 'invitation',
      inviteId: qr.inviteId,
      state: 'reserved',
    });
  });

  it('carries how the ceremony ended to the webview, mistyped or not', async () => {
    // The panel behind the modal has no other way to tell a success from a
    // mistyped confirmation: both spend the code and dismiss the request
    // (`docs/specs/server.md` → "Remote control, in the Settings dialog").
    const socket = await running();
    for (const [clientId, typed, expected] of [
      ['c1', (code: string) => code, 'paired'],
      ['c2', (code: string) => (code === '99' ? '98' : '99'), 'code-mismatch'],
    ] as const) {
      const { qr, invitation } = await mint();
      const before = queueEvents().length;
      const { code } = await pairThroughSocket({
        socket,
        hostId: QR_ENROLLMENT.hostId,
        clientId,
        invitation,
        authenticator,
        until: () => queueEvents().length > before,
      });
      const item = queueEvents().at(-1)!.queue.find((entry) => entry.clientId === clientId)!;
      await command('approve', { clientId, pairingId: item.pairingId, code: typed(code) });
      await settle();

      expect(invitationEvents().at(-1)).toEqual({
        name: 'invitation',
        inviteId: qr.inviteId,
        state: 'consumed',
        outcome: expected,
      });
    }
  });

  it('refuses to mint on a machine with no enrollment', async () => {
    createService();
    await service.start();
    expect((await command('setupQr')).error).toContain('not connected');
    expect(requests).toEqual([]);
  });

  it('fails the mint when the server answers a 200 that is not a setup token', async () => {
    await running();
    setupTokenMalformed = true;
    // An `undefined` token would go straight into the QR encoder.
    expect((await command('setupQr')).error).toContain('not a setup token');
  });

  it('paints nothing for a mint that resolves onto a different Host', async () => {
    // The round trip can straddle an enroll elsewhere. The code belongs to the
    // server we just left, so it must fail rather than mint an invitation onto
    // a replacement that could never complete it.
    await running();
    const minting = command('setupQr');
    await command('clearEnrollment');
    expect((await minting).error).toContain('reconnected to a different server');
  });

  it('forgets its invitations when the enrollment they belong to goes', async () => {
    const socket = await running();
    const { invitation } = await mint();

    await command('clearEnrollment');
    await command('enroll', { serverUrl: ORIGIN, password: 'setup', label: 'Laptop' });
    const reconnected = sockets.at(-1)!;
    reconnected.open();

    // The one-use key behind that code lived on the Host this service replaced,
    // so nothing can complete a handshake against it any more.
    expect(
      await openPairingSession({
        socket: reconnected,
        hostId: ENROLLMENT.hostId,
        clientId: 'c1',
        invitation,
        clientStatic: await generateNoiseKeyPair(),
      }),
    ).toBeNull();
    expect(socket.readyState).toBe(3);
  });
});

describe('push', () => {
  const rawSendBody = (): string | null =>
    (requests.filter((r) => r.url.endsWith('/api/push/send')).at(-1)?.init?.body as string) ?? null;
  const sendRecipients = (): Array<{ deliveryId: string }> => {
    const body = rawSendBody();
    return body
      ? (JSON.parse(body) as { recipients: Array<{ deliveryId: string }> }).recipients
      : [];
  };

  it('addresses the Host’s own ACL, not anything the webview sent', async () => {
    createService({
      enrollment: ENROLLMENT,
      acl: { [HOST_ID]: [aclRecord('device-1'), aclRecord('device-2', 'iPad')] },
    });
    await service.start();

    await command('push', { sessionId: 'pty-1', title: 'pnpm dev' });

    // One sealed envelope per active record, in ACL order.
    expect(sendRecipients().map((r) => r.deliveryId)).toEqual([
      aclRecord('device-1').deliveryId,
      aclRecord('device-2').deliveryId,
    ]);
  });

  it('seals what the webview named rather than posting it', async () => {
    // The Server forwards this body and can read none of it
    // (docs/specs/remote-security-model.md -> Push sealing). That the label is
    // bounded *before* it is sealed is `lib/src/remote/host/alert-push.test.ts`,
    // which holds the key to open one.
    createService({ enrollment: ENROLLMENT, acl: { [HOST_ID]: [aclRecord('device-1')] } });
    await service.start();

    await command('push', { sessionId: 'pty-1', title: 'build\u0000finished\u001b' });
    const body = rawSendBody()!;
    expect(body).not.toContain('finished');
    expect(body).not.toContain('pty-1');
  });

  it('is a silent no-op with no Host running', async () => {
    createService();
    const result = await command('push', { sessionId: 'pty-1', title: 'x' });
    expect(result.error).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it('warns rather than failing the command when the server rejects it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store = memoryStore({ enrollment: ENROLLMENT, acl: { [HOST_ID]: [aclRecord('device-1')] } });
    service = new RemoteHostService({
      store,
      provider: fakeProvider(),
      sendToUi: (event, data) => sent.push({ event, data: data as Record<string, unknown> }),
      connectSrc: CONNECT_SRC,
      createWebSocket: () => new FakeSocket(),
      fetch: (async () => ({ ok: false, status: 401 })) as unknown as typeof globalThis.fetch,
    });
    await service.start();

    expect((await command('push', { sessionId: 'pty-1', title: 'x' })).error).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('pushDevices', () => {
  it('joins the server’s subscriptions to the ACL’s labels', async () => {
    createService({ enrollment: ENROLLMENT, acl: { [HOST_ID]: [aclRecord('1')] } });
    await service.start();

    // The second subscribed delivery id is no longer on any ACL record — and
    // the surviving one crosses to the webview as a label alone: a delivery id
    // is a bearer capability for that Client's push rows, and no route in the
    // webview realm takes one.
    expect((await command('pushDevices')).result).toEqual({
      devices: [{ label: 'iPhone Safari' }],
    });
  });

  it('answers null when no Host is running', async () => {
    createService();
    // "Nowhere to push" — not an empty list, and not a failed request.
    expect((await command('pushDevices')).result).toBeNull();
  });

  it('errors when the server cannot be asked', async () => {
    store = memoryStore({ enrollment: ENROLLMENT, acl: { [HOST_ID]: [aclRecord('device-1')] } });
    service = new RemoteHostService({
      store,
      provider: fakeProvider(),
      sendToUi: (event, data) => sent.push({ event, data: data as Record<string, unknown> }),
      connectSrc: CONNECT_SRC,
      createWebSocket: () => new FakeSocket(),
      fetch: (async () => ({ ok: false, status: 500 })) as unknown as typeof globalThis.fetch,
    });
    await service.start();

    expect((await command('pushDevices')).error).toBeTruthy();
  });
});

describe('pushTest', () => {
  it('refuses when this machine is not connected to a server', async () => {
    createService();
    // The inverse of the ring path, which swallows everything: a test button
    // that reported success here would be worse than no button.
    const { error } = await command('pushTest');
    expect(error).toContain('not connected');
  });

  it('reports that nothing was targeted when no device is authorized', async () => {
    createService({ enrollment: ENROLLMENT, acl: { [HOST_ID]: [] } });
    await service.start();

    const { result } = await command('pushTest');
    // Distinct from a refused send: the Host is fine, nothing has opted in.
    expect(result).toEqual({ targeted: 0, delivered: 0, failed: 0 });
    expect(requests.some((request) => request.url.endsWith('/api/push/send'))).toBe(false);
  });

  it('sends through the real path and reports what was delivered', async () => {
    createService({ enrollment: ENROLLMENT, acl: { [HOST_ID]: [aclRecord('device-1')] } });
    await service.start();

    const { result } = await command('pushTest');
    expect(result).toEqual({ targeted: 1, delivered: 1, failed: 0 });

    const send = requests.find((request) => request.url.endsWith('/api/push/send'));
    expect(send).toBeTruthy();
    const raw = String(send!.init?.body);
    const body = JSON.parse(raw) as { recipients: Array<{ deliveryId: string }> };
    // Recipients come from the ACL, exactly as a real ring does — and the test
    // push is sealed like any other, so neither its fixed collapse key nor its
    // title is readable on the wire.
    expect(body.recipients.map((r) => r.deliveryId)).toEqual([aclRecord('device-1').deliveryId]);
    expect(raw).not.toContain('dormouse-push-test');
    expect(raw).not.toContain('Dormouse test');
  });

  it('surfaces a refused send instead of swallowing it', async () => {
    store = memoryStore({ enrollment: ENROLLMENT, acl: { [HOST_ID]: [aclRecord('device-1')] } });
    service = new RemoteHostService({
      store,
      provider: fakeProvider(),
      sendToUi: (event, data) => sent.push({ event, data: data as Record<string, unknown> }),
      connectSrc: CONNECT_SRC,
      createWebSocket: () => new FakeSocket(),
      fetch: (async () => ({ ok: false, status: 500 })) as unknown as typeof globalThis.fetch,
    });
    await service.start();

    expect((await command('pushTest')).error).toBeTruthy();
  });
});
