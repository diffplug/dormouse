/**
 * The Node-resident Burrow, driven the way both of its neighbours drive it: the
 * webview through `handleCommand`, and the relay through a fake `/ws/burrow`
 * socket. The point of most cases here is that nothing a webview says can widen
 * access — recipients, the ACL, and the allowlist are all read on this side.
 */

import { hostname } from 'node:os';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_ROUTES,
  ONE_TIME_WS_ROUTES,
  mintNoiseStaticKeyPair,
  parseOneTimeLinkUrl,
  parsePairingInvitationUrl,
  generateNoiseKeyPair,
  toBase64Url,
  utf8Encode,
  type EnrollmentOffer,
  type BurrowAclRecord,
} from 'remote-lib-common';
import type { BurrowEnrollment } from '../../remote/burrow/enrollment';
import type {
  BurrowSurfaceProvider,
  SurfaceHold,
} from '../../remote/burrow/burrow-surface-provider';
import type { OneTimeState } from '../../remote/burrow/one-time-runtime';
import { FakeDirectNetwork } from '../../remote/direct/test-fake-peer';
import { FakeSocket } from '../../remote/test-fake-socket';
import {
  createTestAuthenticator,
  flushUntil,
  openPairingSession,
  openReceipt,
  pairThroughSocket,
  readOutcome,
  settle,
  settleUntil,
  testRoutingId,
  type TestAuthenticator,
} from '../../remote/test-e2e-client';
import {
  createTestRendezvous,
  joinOneTimeRoom,
  negotiateOneTimeDirect,
  type TestOneTimePhone,
  type TestRendezvous,
} from '../../remote/test-rendezvous';
import { createEphemeralBurrowStateStore, type BurrowStateStore } from './burrow-state-store';
import { BurrowService, idleOneTimeState, type BurrowServiceOptions } from './service';
import { isOneTimeState } from './service-protocol';
import type {
  BurrowStatusEvent,
  InvitationEvent,
  OneTimeEvent,
  PairingQueueEvent,
  PairingQueueItem,
  BurrowConsoleStatus,
  SetupQrResult,
} from './service-protocol';

const CONNECT_SRC = 'https://*.dormouse.sh wss://*.dormouse.sh';
const BURROW_ID = testRoutingId();
const ORIGIN = 'https://relay.dormouse.sh';
/** The shipped rendezvous, which the shipped allowlist admits. */
const ONE_TIME_ORIGIN = 'https://hosted.dormouse.sh';

/**
 * The enrollment every case runs on, with a **real** Noise static: without one
 * the service backfills and persists a fresh key on start, which is its own
 * case below rather than a hidden write under every other.
 */
let ENROLLMENT: BurrowEnrollment;

beforeAll(async () => {
  const material = await mintNoiseStaticKeyPair();
  ENROLLMENT = {
    relayUrl: ORIGIN,
    burrowId: BURROW_ID,
    burrowToken: 'tok',
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
function aclRecord(seed: string, label = 'iPhone Safari'): BurrowAclRecord {
  const pad = (text: string): string => text.padEnd(43, 'A').slice(0, 43);
  return {
    burrowId: BURROW_ID,
    accountId: 'owner',
    passkeyCredentialId: 'cred',
    passkeyPublicKeyHash: 'hash',
    clientStaticPublicKey: pad(`client-${seed}`),
    deliveryId: pad(`delivery-${seed}`),
    approvedAt: 1,
    approvedBy: 'burrow-user',
    label,
    revokedAt: null,
  };
}

interface MemoryStore extends BurrowStateStore {
  enrollment: BurrowEnrollment | null;
  acl: Record<string, BurrowAclRecord[]>;
}

/**
 * A durable store whose contents a test can seed and read back — not
 * `createEphemeralBurrowStateStore`, whose whole point is `persistent: false`,
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
    loadAcl: async (burrowId) => store.acl[burrowId] ?? [],
    saveAcl: async (burrowId, records) => {
      store.acl[burrowId] = [...records];
    },
  };
  return store;
}

function fakeProvider(): BurrowSurfaceProvider {
  return {
    collectDirectory: async () => [],
    watchDirectory: () => () => {},
    resolveSurface: async () => null,
    releaseSurface: () => {},
    writePty: () => {},
    resizePty: () => {},
    streamPty: () => () => {},
  };
}

let sockets: FakeSocket[];
/** The one-time rendezvous every one-time socket the service opens reaches. */
let rendezvous: TestRendezvous;
/** Where the Burrow's direct peers and the test phone's meet. */
let network: FakeDirectNetwork;
let sent: Array<{ event: string; data: Record<string, unknown> }>;
let requests: Array<{ url: string; init?: RequestInit }>;
let store: MemoryStore;
let service: BurrowService;
let commandSeq = 0;

/** How many setup tokens the fake Relay has minted, so each one is distinct. */
let setupTokensMinted: number;
/** Make `POST /api/burrow/setup-token` answer a 200 that is not a setup token. */
let setupTokenMalformed: boolean;
/** What the fake Relay puts in `expiresAt`; a test moves it to expire one. */
let setupTokenTtlMs: number;

/** A Relay that answers enroll, setup-token, push/send, and push/devices. */
function fakeFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith(API_ROUTES.burrowSetupToken)) {
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
    if (url.endsWith('/api/burrow/enroll')) {
      return {
        ok: true,
        json: async () => ({
          burrowId: BURROW_ID,
          burrowToken: 'tok',
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
 * Relay installed. `offerReads` counts the calls, which is how the "an enrolled
 * Burrow does not touch the disk" case is stated.
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

function createService(
  seed?: Partial<Pick<MemoryStore, 'enrollment' | 'acl'>>,
  over: Partial<BurrowServiceOptions> = {},
): BurrowService {
  store = memoryStore(seed);
  service = new BurrowService({
    store,
    provider: fakeProvider(),
    kind: 'vscode',
    sendToUi: (event, data) => sent.push({ event, data: data as Record<string, unknown> }),
    connectSrc: CONNECT_SRC,
    oneTimeOrigin: ONE_TIME_ORIGIN,
    // One factory for both sockets, as each host passes: the rendezvous route
    // reaches the in-memory room, everything else the fake relay.
    createWebSocket: (url) => {
      if (new URL(url).pathname === ONE_TIME_WS_ROUTES.burrow) {
        return rendezvous.createBurrowSocket(url);
      }
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    createDirectPeer: () => network.createAnswerer(),
    fetch: fakeFetch(),
    readOffer: async () => {
      offerReads++;
      if (offerGate) await offerGate;
      return offer;
    },
    ...over,
  });
  return service;
}

/** The JSON body of the nth request, for asserting what a credential carried. */
function requestBody(index: number): Record<string, unknown> {
  return JSON.parse(requests[index]!.init!.body as string) as Record<string, unknown>;
}

/** Run a command and return the `burrow:result` it produced. */
async function command(cmd: string, params?: unknown): Promise<Record<string, unknown>> {
  const burrowRequestId = `c-${++commandSeq}`;
  await service.handleCommand({ burrowRequestId, cmd, params });
  const result = sent
    .filter((message) => message.event === 'burrow:result')
    .find((message) => message.data.burrowRequestId === burrowRequestId);
  if (!result) throw new Error(`no result for ${cmd}`);
  return result.data;
}

function queueEvents(): PairingQueueEvent[] {
  return uiEvents().filter((event): event is PairingQueueEvent => event.name === 'pairing-queue');
}

function uiEvents(): Array<PairingQueueEvent | BurrowStatusEvent | InvitationEvent | OneTimeEvent> {
  return sent
    .filter((message) => message.event === 'burrow:event')
    .map(
      (message) =>
        message.data as unknown as
          | PairingQueueEvent
          | BurrowStatusEvent
          | InvitationEvent
          | OneTimeEvent,
    );
}

function invitationEvents(): InvitationEvent[] {
  return uiEvents().filter((event): event is InvitationEvent => event.name === 'invitation');
}

/** What the webviews were told about whether there is a Burrow, in order. */
function statusEvents(): boolean[] {
  return uiEvents()
    .filter((event): event is BurrowStatusEvent => event.name === 'status')
    .map((event) => event.enrolled);
}

/** What the webviews were told about whether anything can reach the terminals, in order. */
function servingEvents(): boolean[] {
  return uiEvents()
    .filter((event): event is BurrowStatusEvent => event.name === 'status')
    .map((event) => event.serving);
}

/** Every one-time state the webviews were told of, in order. */
function oneTimeStates(): OneTimeState[] {
  return uiEvents()
    .filter((event): event is OneTimeEvent => event.name === 'one-time')
    .map((event) => event.state);
}

beforeEach(() => {
  sockets = [];
  rendezvous = createTestRendezvous();
  network = new FakeDirectNetwork();
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
  it('reports a Burrow that has not been enrolled', async () => {
    createService();
    await service.start();
    expect((await command('status')).result).toEqual({
      enrolled: false,
      serving: false,
      relayUrl: null,
      burrowId: null,
      connection: 'stopped',
      pairedClients: 0,
      suggestedLabel: `${hostname()} (VS Code)`,
      offer: null,
    } satisfies BurrowConsoleStatus);
  });

  it('offers the installer’s enrollment while un-enrolled, without its token', async () => {
    offer = OFFER;
    createService();
    await service.start();

    expect((await command('status')).result).toEqual({
      enrolled: false,
      serving: false,
      relayUrl: null,
      burrowId: null,
      connection: 'stopped',
      pairedClients: 0,
      suggestedLabel: `${hostname()} (VS Code)`,
      offer: { origin: OFFER.origin },
    } satisfies BurrowConsoleStatus);
    // The one-time token is a bearer credential and this is a service→webview
    // shape (docs/specs/security-remote.md -> "Trust boundary"), so it must not appear anywhere in what was sent.
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
    createService({ enrollment: ENROLLMENT, acl: { [BURROW_ID]: [aclRecord('device-1')] } });
    await service.start();
    sockets[0]!.open();

    expect((await command('status')).result).toEqual({
      enrolled: true,
      serving: true,
      relayUrl: ENROLLMENT.relayUrl,
      burrowId: BURROW_ID,
      connection: 'connected',
      pairedClients: 1,
      suggestedLabel: `${hostname()} (VS Code)`,
      offer: null,
    } satisfies BurrowConsoleStatus);
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
      relayUrl: 'https://relay.dormouse.sh',
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
      relayUrl: 'https://relay.example.com',
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
      relayUrl: 'https://relay.dormouse.sh/',
      password: 'setup',
      label: 'Laptop',
    });

    expect(result.result).toEqual({ burrowId: BURROW_ID, relayUrl: ORIGIN });
    expect(store.enrollment?.burrowToken).toBe('tok');
    expect(sockets).toHaveLength(1);
  });

  it('replaces a running Burrow rather than adding one', async () => {
    createService({ enrollment: ENROLLMENT });
    await service.start();
    sockets[0]!.open();

    await command('enroll', {
      relayUrl: 'https://other.dormouse.sh',
      password: 'setup',
      label: 'Laptop',
    });
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.readyState).toBe(3);
  });

  it('keeps the old Burrow when the new enrollment cannot be persisted', async () => {
    // The `burrowToken` this exchange just minted exists nowhere else and cannot
    // be minted again, so stopping the old Burrow before the save is what turns
    // one failed write into a machine with no Burrow and a status that lies.
    createService({ enrollment: ENROLLMENT });
    await service.start();
    sockets[0]!.open();
    store.saveEnrollment = async () => {
      throw new Error('keychain is locked');
    };

    const result = await command('enroll', {
      relayUrl: 'https://other.dormouse.sh',
      password: 'setup',
      label: 'Laptop',
    });

    expect(result.error).toContain('keychain is locked');
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.readyState).toBe(1);
    expect((await command('status')).result).toMatchObject({
      enrolled: true,
      relayUrl: ENROLLMENT.relayUrl,
      connection: 'connected',
    });
  });

  it('cycles the enrolled gate when it swaps one running Burrow for another', async () => {
    // The webviews' gate is edge-triggered (`enrolled-gate.ts`), and what it
    // holds — the mirrored pairing queue, the push device list — belongs to the
    // Relay being left. With no `false` between the two Burrows the gate never
    // cycles and the Settings dialog keeps naming the old Relay's devices.
    createService({ enrollment: ENROLLMENT });
    await service.start();
    sockets[0]!.open();
    expect(statusEvents()).toEqual([true]);

    await command('enroll', {
      relayUrl: 'https://other.dormouse.sh',
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

    expect(result.result).toEqual({ burrowId: BURROW_ID, relayUrl: OFFER.origin });
    expect(requests).toHaveLength(1);
    // The credential and nothing else: the label the operator typed stays local.
    expect(requestBody(0)).toEqual({ enrollToken: OFFER.token });
    expect(requestBody(0)).not.toHaveProperty('password');
    // Same store-first persistence and same started Burrow as the typed form.
    expect(store.enrollment?.burrowToken).toBe('tok');
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
    // Enrolling against the new origin would spend a one-time token on a Relay
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
    // The allowlist gate is the typed form's, unchanged: a Relay installed on
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
  it('stays idle, loudly, when the persisted Relay is no longer allowed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createService({ enrollment: { ...ENROLLMENT, relayUrl: 'https://relay.example.com' } });
    await service.start();

    expect(sockets).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect((await command('status')).result).toMatchObject({ connection: 'stopped' });
    warn.mockRestore();
  });

  it('reconnect is the way back, and start()s a Burrow that never ran', async () => {
    createService({ enrollment: ENROLLMENT });
    const status = (await command('reconnect')).result as BurrowConsoleStatus;
    expect(sockets).toHaveLength(1);
    expect(status).toMatchObject({ enrolled: true, connection: 'connecting' });
  });

  it('builds one Burrow when a start and a reconnect race', async () => {
    // Both read `#burrow`, both await the store, and both then act on what they
    // read. Unserialized they each see no Burrow and each build one — and the
    // second holds a relay socket nothing has a reference to, so it can never
    // be stopped and the two displace each other on the Relay forever.
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
    const reconnected = service.handleCommand({ burrowRequestId: 'race', cmd: 'reconnect' });
    release();
    await Promise.all([started, reconnected]);

    expect(sockets).toHaveLength(1);
    // And the one that exists is the one `dispose()` can reach.
    service.dispose();
    expect(sockets[0]!.readyState).toBe(3);
  });

  it('does not resurrect a Burrow when disposal lands during startup', async () => {
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
    store.loadAcl = async (burrowId) => {
      enteredAcl();
      await gate;
      return seeded(burrowId);
    };

    const starting = service.start();
    await entered;
    service.dispose();
    releaseAcl();
    await starting;

    expect(sockets).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('clearEnrollment stops the Burrow and forgets it, keeping the records', async () => {
    createService({ enrollment: ENROLLMENT, acl: { [BURROW_ID]: [aclRecord('device-1')] } });
    await service.start();

    await command('clearEnrollment');
    expect(store.enrollment).toBeNull();
    // The records stay filed under their burrowId: re-enrolling onto the same
    // burrow must not silently de-pair every device.
    expect(store.acl[BURROW_ID]).toHaveLength(1);
    expect((await command('status')).result).toMatchObject({ enrolled: false, connection: 'stopped' });
  });

  it('stays enrolled — and running — when the enrollment cannot be deleted', async () => {
    // Reporting un-enrolled over a delete that failed is the worst outcome
    // available: the credential is still on disk, so the next launch reads it
    // back and every paired device is let in again by a Burrow the user believes
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
      relayUrl: ENROLLMENT.relayUrl,
      connection: 'connected',
    });
    expect(statusEvents()).toEqual([true]);
  });
});

describe('status events', () => {
  it('announces a Burrow that started, and one that was cleared', async () => {
    // What every webview arms its outbound work on: an installation that never
    // enrolls is told nothing and does nothing (`enrolled-gate.ts`).
    createService({ enrollment: ENROLLMENT });
    await service.start();
    expect(statusEvents()).toEqual([true]);

    await command('clearEnrollment');
    expect(statusEvents()).toEqual([true, false]);
  });

  it('says nothing at all when there is no Burrow to run', async () => {
    createService();
    await service.start();
    await command('status');
    expect(statusEvents()).toEqual([]);
  });

  it('announces the Burrow an enroll started', async () => {
    createService();
    await command('enroll', { relayUrl: ORIGIN, password: 'setup', label: 'Laptop' });
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
    if (!invitation) throw new Error(`the Burrow composed a URL Pocket cannot read: ${qr.url}`);
    const before = queueEvents().length;
    const paired = await pairThroughSocket({
      socket,
      burrowId: ENROLLMENT.burrowId,
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
    // Exactly five fields cross the bridge — and the expected code is not one
    // of them, which is the whole point of typing it on this side.
    expect(Object.keys(item).sort()).toEqual(['clientId', 'kind', 'label', 'pairingId', 'requestedAt']);
    expect(item).toMatchObject({ kind: 'pairing', clientId: 'c1', label: 'iPhone Safari' });
    expect(typeof item.pairingId).toBe('string');

    // A webview that reloaded mid-pairing seeds from the same snapshot.
    expect((await command('pairingQueue')).result).toEqual(event.queue);
  });

  it('never mirrors the code the Burrow is going to compare against', async () => {
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
      burrowLabel: ENROLLMENT.label,
    });
    expect(store.acl[BURROW_ID]).toHaveLength(1);
    expect(store.acl[BURROW_ID]![0]).toMatchObject({ label: 'iPhone Safari', revokedAt: null });
    expect(queueEvents().at(-1)!.queue).toEqual([]);
  });

  it('waits for the host store before completing approval and reports a failed save', async () => {
    const socket = await running();
    const { item, session, invitation, code } = await pair(socket, 'c1');
    const write = Promise.withResolvers<void>();
    const save = vi.spyOn(store, 'saveAcl').mockImplementation(() => write.promise);
    const framesBefore = socket.sent.length;
    let completed = false;
    const approval = command('approve', { clientId: 'c1', pairingId: item.pairingId, code })
      .then(() => { completed = true; });
    await settle();
    expect(save).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    expect(socket.sent).toHaveLength(framesBefore);
    write.reject(new Error('disk full'));
    await approval;
    expect(await readOutcome(socket, session, 'pairing', invitation.inviteId)).toEqual({
      ok: false, code: 'burrow-error',
    });
    expect(store.acl[BURROW_ID]).toBeUndefined();
    expect(queueEvents().at(-1)!.queue).toEqual([]);
  });

  it('restarts only after an approved ACL write finishes, retaining the new pairing', async () => {
    const socket = await running();
    const { item, invitation, session, code } = await pair(socket, 'c1');
    const write = Promise.withResolvers<void>();
    const persist = store.saveAcl.bind(store);
    vi.spyOn(store, 'saveAcl').mockImplementation(async (burrowId, records) => {
      await write.promise;
      await persist(burrowId, records);
    });
    const approval = command('approve', { clientId: 'c1', pairingId: item.pairingId, code });
    await settle();
    let restarted = false;
    const restart = service.start().then(() => { restarted = true; });
    await settle();
    expect(restarted).toBe(false);
    write.resolve();
    await Promise.all([approval, restart]);
    expect(await readOutcome(socket, session, 'pairing', invitation.inviteId)).toMatchObject({ ok: true });
    expect((await command('status')).result).toMatchObject({ pairedClients: 1 });
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
    expect(store.acl[BURROW_ID]).toBeUndefined();
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
    expect(store.acl[BURROW_ID]).toBeUndefined();
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
    expect(store.acl[BURROW_ID]).toHaveLength(1);
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
    expect(store.acl[BURROW_ID]).toBeUndefined();
    expect(queueEvents().at(-1)!.queue).toEqual([replacement.item]);

    await command('approve', {
      clientId: 'c1',
      pairingId: replacement.item.pairingId,
      code: replacement.code,
    });
    await settle();
    expect(store.acl[BURROW_ID]![0]).toMatchObject({ label: 'Android Chrome' });
  });
});

describe('setup QR', () => {
  /**
   * An enrollment whose `burrowToken` cannot be confused with anything else in an
   * assertion — the shared fixture's `tok` is a substring of common words, and
   * this suite has to prove the bearer stays out of the webview.
   */
  let QR_ENROLLMENT: BurrowEnrollment;
  let authenticator: TestAuthenticator;

  beforeAll(async () => {
    QR_ENROLLMENT = { ...ENROLLMENT, burrowToken: 'burrow-bearer-secret' };
    authenticator = await createTestAuthenticator({ rpId: ENROLLMENT.rpId, origin: ORIGIN });
  });

  async function running(enrollment: BurrowEnrollment = QR_ENROLLMENT): Promise<FakeSocket> {
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

  it('mints over the Burrow’s own authenticated channel and composes the URL here', async () => {
    await running();
    const { qr, invitation } = await mint();

    const posted = requests.at(-1)!;
    expect(posted.url).toBe(`${QR_ENROLLMENT.relayUrl}${API_ROUTES.burrowSetupToken}`);
    expect((posted.init!.headers as Record<string, string>).authorization).toBe(
      'Bearer burrow-bearer-secret',
    );
    // An allowed origin's open redirect must not carry the bearer elsewhere.
    expect(posted.init!.redirect).toBe('error');

    // The origin is the enrollment's — the phone-facing WebAuthn origin — and
    // the whole invitation rides in the URL, which is the point of the command.
    expect(qr.url.startsWith(`${QR_ENROLLMENT.origin}/#pair?`)).toBe(true);
    expect(invitation.burrowId).toBe(QR_ENROLLMENT.burrowId);
    expect(invitation.inviteId).toBe(qr.inviteId);
    expect(invitation.setupToken).toBe(toBase64Url(new Uint8Array(32).fill(1)));

    // The invitation's private half never leaves the Burrow, and neither does the
    // bearer: only the code a human will scan crosses.
    expect(JSON.stringify(sent)).not.toContain('burrow-bearer-secret');
    expect(JSON.stringify(requests)).not.toContain(invitation.ephPubBase64Url);
  });

  it('reports the invitation live until a phone reserves it', async () => {
    const socket = await running();
    const { qr, invitation } = await mint();
    expect(invitationEvents()).toEqual([]);

    await pairThroughSocket({
      socket,
      burrowId: QR_ENROLLMENT.burrowId,
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
    // (`docs/specs/relay.md` → "Remote control, in the Settings dialog").
    const socket = await running();
    for (const [clientId, typed, expected] of [
      ['c1', (code: string) => code, 'paired'],
      ['c2', (code: string) => (code === '99' ? '98' : '99'), 'code-mismatch'],
    ] as const) {
      const { qr, invitation } = await mint();
      const before = queueEvents().length;
      const { code } = await pairThroughSocket({
        socket,
        burrowId: QR_ENROLLMENT.burrowId,
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

  it('fails the mint when the Relay answers a 200 that is not a setup token', async () => {
    await running();
    setupTokenMalformed = true;
    // An `undefined` token would go straight into the QR encoder.
    expect((await command('setupQr')).error).toContain('not a setup token');
  });

  it('paints nothing for a mint that resolves onto a different Burrow', async () => {
    // The round trip can straddle an enroll elsewhere. The code belongs to the
    // Relay we just left, so it must fail rather than mint an invitation onto
    // a replacement that could never complete it.
    await running();
    const minting = command('setupQr');
    await command('clearEnrollment');
    expect((await minting).error).toContain('reconnected to a different Relay');
  });

  it('forgets its invitations when the enrollment they belong to goes', async () => {
    const socket = await running();
    const { invitation } = await mint();

    await command('clearEnrollment');
    await command('enroll', { relayUrl: ORIGIN, password: 'setup', label: 'Laptop' });
    const reconnected = sockets.at(-1)!;
    reconnected.open();

    // The one-use key behind that code lived on the Burrow this service replaced,
    // so nothing can complete a handshake against it any more.
    expect(
      await openPairingSession({
        socket: reconnected,
        burrowId: ENROLLMENT.burrowId,
        clientId: 'c1',
        invitation,
        clientStatic: await generateNoiseKeyPair(),
      }),
    ).toBeNull();
    expect(socket.readyState).toBe(3);
  });
});

/**
 * One due alarm push, from the alert host in the service's own process
 * (`docs/specs/alert.md` -> Push notifications). No webview can ask for one.
 */
describe('push', () => {
  const rawSendBody = (): string | null =>
    (requests.filter((r) => r.url.endsWith('/api/push/send')).at(-1)?.init?.body as string) ?? null;
  const sendRecipients = (): Array<{ deliveryId: string }> => {
    const body = rawSendBody();
    return body
      ? (JSON.parse(body) as { recipients: Array<{ deliveryId: string }> }).recipients
      : [];
  };

  it('addresses the Burrow’s own ACL', async () => {
    createService({
      enrollment: ENROLLMENT,
      acl: { [BURROW_ID]: [aclRecord('device-1'), aclRecord('device-2', 'iPad')] },
    });
    await service.start();

    await service.push('pty-1', 'pnpm dev');

    // One sealed envelope per active record, in ACL order.
    expect(sendRecipients().map((r) => r.deliveryId)).toEqual([
      aclRecord('device-1').deliveryId,
      aclRecord('device-2').deliveryId,
    ]);
  });

  it('seals the title rather than posting it', async () => {
    // The Relay forwards this body and can read none of it
    // (docs/specs/remote-security-model.md -> Push sealing). That the label is
    // bounded *before* it is sealed is `lib/src/remote/burrow/push-delivery.test.ts`,
    // which holds the key to open one.
    createService({ enrollment: ENROLLMENT, acl: { [BURROW_ID]: [aclRecord('device-1')] } });
    await service.start();

    await service.push('pty-1', 'build\u0000finished\u001b');
    const body = rawSendBody()!;
    expect(body).not.toContain('finished');
    expect(body).not.toContain('pty-1');
  });

  it('sends nothing with no Burrow running', async () => {
    createService();
    await service.push('pty-1', 'x');
    expect(requests).toEqual([]);
  });

  it('warns rather than rejecting when the Relay refuses the send', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store = memoryStore({ enrollment: ENROLLMENT, acl: { [BURROW_ID]: [aclRecord('device-1')] } });
    service = new BurrowService({
      store,
      provider: fakeProvider(),
      kind: 'vscode',
      sendToUi: (event, data) => sent.push({ event, data: data as Record<string, unknown> }),
      connectSrc: CONNECT_SRC,
      oneTimeOrigin: ONE_TIME_ORIGIN,
      createWebSocket: () => new FakeSocket(),
      fetch: (async () => ({ ok: false, status: 401 })) as unknown as typeof globalThis.fetch,
    });
    await service.start();

    await expect(service.push('pty-1', 'x')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is no command a webview can send', async () => {
    createService({ enrollment: ENROLLMENT, acl: { [BURROW_ID]: [aclRecord('device-1')] } });
    await service.start();

    expect((await command('push', { sessionId: 'pty-1', title: 'x' })).error).toBe('unknown burrow command: push');
    expect(rawSendBody()).toBeNull();
  });
});

describe('pushDevices', () => {
  it('joins the Relay’s subscriptions to the ACL’s labels', async () => {
    createService({ enrollment: ENROLLMENT, acl: { [BURROW_ID]: [aclRecord('1')] } });
    await service.start();

    // The second subscribed delivery id is no longer on any ACL record — and
    // the surviving one crosses to the webview as a label alone: a delivery id
    // is a bearer capability for that Client's push rows, and no route in the
    // webview realm takes one.
    expect((await command('pushDevices')).result).toEqual({
      devices: [{ label: 'iPhone Safari' }],
    });
  });

  it('answers null when no Burrow is running', async () => {
    createService();
    // "Nowhere to push" — not an empty list, and not a failed request.
    expect((await command('pushDevices')).result).toBeNull();
  });

  it('errors when the Relay cannot be asked', async () => {
    store = memoryStore({ enrollment: ENROLLMENT, acl: { [BURROW_ID]: [aclRecord('device-1')] } });
    service = new BurrowService({
      store,
      provider: fakeProvider(),
      kind: 'vscode',
      sendToUi: (event, data) => sent.push({ event, data: data as Record<string, unknown> }),
      connectSrc: CONNECT_SRC,
      oneTimeOrigin: ONE_TIME_ORIGIN,
      createWebSocket: () => new FakeSocket(),
      fetch: (async () => ({ ok: false, status: 500 })) as unknown as typeof globalThis.fetch,
    });
    await service.start();

    expect((await command('pushDevices')).error).toBeTruthy();
  });
});

describe('pushTest', () => {
  it('refuses when this machine is not connected to a Relay', async () => {
    createService();
    // The inverse of the ring path, which swallows everything: a test button
    // that reported success here would be worse than no button.
    const { error } = await command('pushTest');
    expect(error).toContain('not connected');
  });

  it('reports that nothing was targeted when no device is authorized', async () => {
    createService({ enrollment: ENROLLMENT, acl: { [BURROW_ID]: [] } });
    await service.start();

    const { result } = await command('pushTest');
    // Distinct from a refused send: the Burrow is fine, nothing has opted in.
    expect(result).toEqual({ targeted: 0, delivered: 0, failed: 0 });
    expect(requests.some((request) => request.url.endsWith('/api/push/send'))).toBe(false);
  });

  it('sends through the real path and reports what was delivered', async () => {
    createService({ enrollment: ENROLLMENT, acl: { [BURROW_ID]: [aclRecord('device-1')] } });
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
    store = memoryStore({ enrollment: ENROLLMENT, acl: { [BURROW_ID]: [aclRecord('device-1')] } });
    service = new BurrowService({
      store,
      provider: fakeProvider(),
      kind: 'vscode',
      sendToUi: (event, data) => sent.push({ event, data: data as Record<string, unknown> }),
      connectSrc: CONNECT_SRC,
      oneTimeOrigin: ONE_TIME_ORIGIN,
      createWebSocket: () => new FakeSocket(),
      fetch: (async () => ({ ok: false, status: 500 })) as unknown as typeof globalThis.fetch,
    });
    await service.start();

    expect((await command('pushTest')).error).toBeTruthy();
  });
});

/**
 * The one-time connection, through the in-memory rendezvous and a phone driven
 * by hand — a real Noise initiator against the link, as the `/connect/` page
 * runs one (`docs/specs/one-time.md`). The ceremony itself is
 * `one-time-runtime.test.ts`'s; this is what the service adds: the three
 * commands, the event, `serving`, and the approval routed by kind.
 */
describe('one-time connection', () => {
  type Waiting = Extract<OneTimeState, { status: 'waiting' }>;

  async function open(): Promise<Waiting> {
    const { result, error } = await command('oneTimeOpen');
    if (error) throw new Error(String(error));
    const state = result as OneTimeState;
    if (state.status !== 'waiting') throw new Error(`expected waiting, got ${state.status}`);
    return state;
  }

  /** Read the link and complete IK against it, as the page does on Connect. */
  async function join(url: string): Promise<TestOneTimePhone> {
    const link = await parseOneTimeLinkUrl(url, ONE_TIME_ORIGIN);
    if (!link) throw new Error(`a phone could not read the link: ${url}`);
    return joinOneTimeRoom(rendezvous, link);
  }

  /** Send the request, and answer the item the modal would show for it. */
  async function request(phone: TestOneTimePhone, code = '42'): Promise<PairingQueueItem> {
    phone.sendControl({ code, label: 'iPhone' });
    const event = await flushUntil(() =>
      queueEvents().findLast((e) => e.queue.some((item) => item.kind === 'one-time')),
    );
    return event.queue.find((item) => item.kind === 'one-time')!;
  }

  function approve(item: PairingQueueItem, code = '42') {
    return command('approve', { kind: 'one-time', clientId: '', pairingId: item.pairingId, code });
  }

  /** Offer the direct path and switch onto it, as the page does after `ok`. */
  async function switchDirect(phone: TestOneTimePhone): Promise<void> {
    await negotiateOneTimeDirect(phone, network);
    phone.sendControl({ v: 1, t: 'direct-switch' });
    await settleUntil(() => oneTimeStates().at(-1)?.status === 'connected');
  }

  it('is idle on a machine that never enrolled, serving nothing', async () => {
    createService();
    await service.start();

    expect((await command('oneTimeStatus')).result).toEqual({ status: 'idle' });
    expect(service.oneTimeEvent()).toEqual({ name: 'one-time', state: { status: 'idle' } });
    expect((await command('status')).result).toMatchObject({ enrolled: false, serving: false });
    expect(service.statusEvent()).toEqual({ name: 'status', enrolled: false, serving: false });
  });

  it('opens a link un-enrolled, on the baked origin whatever the webview sends', async () => {
    createService();
    await service.start();

    // The command takes no parameters: an origin in them reaches nothing.
    const { result } = await command('oneTimeOpen', { origin: 'https://evil.example' });
    const waiting = result as Waiting;
    expect(waiting.status).toBe('waiting');
    expect(rendezvous.rooms).toHaveLength(1);
    expect(rendezvous.room().burrowUrl).toBe('wss://hosted.dormouse.sh/api/one-time/burrow');
    expect((await parseOneTimeLinkUrl(waiting.url, ONE_TIME_ORIGIN))?.roomId).toBe(
      rendezvous.room().roomId,
    );
    // No enrollment: no relay socket, and nothing sent to a Relay.
    expect(sockets).toEqual([]);
    expect(requests).toEqual([]);

    expect(oneTimeStates().map((state) => state.status)).toEqual(['opening', 'waiting']);
    expect((await command('oneTimeStatus')).result).toEqual(waiting);
    expect(service.oneTimeEvent().state).toEqual(waiting);
  });

  it('serves while a connection is open, and announces each flip', async () => {
    createService();
    await service.start();
    await open();
    // `serving` rose at `opening`; `enrolled` never did.
    expect(servingEvents()).toEqual([true]);
    expect(statusEvents()).toEqual([false]);
    expect((await command('status')).result).toMatchObject({ enrolled: false, serving: true });

    // End: the room goes, and so does `serving`.
    expect((await command('oneTimeEnd')).result).toEqual({});
    expect(oneTimeStates().at(-1)).toEqual({ status: 'ended', reason: 'user-ended' });
    expect(rendezvous.room().burrow.closeCode).toBe(1000);
    expect(servingEvents()).toEqual([true, false]);

    // Done: back to idle, which moves no gate.
    await command('oneTimeEnd');
    expect(oneTimeStates().at(-1)).toEqual({ status: 'idle' });
    expect(servingEvents()).toEqual([true, false]);
    // And an idle one has nothing to end.
    const quiet = uiEvents().length;
    expect((await command('oneTimeEnd')).result).toEqual({});
    expect(uiEvents()).toHaveLength(quiet);
  });

  it('is unavailable, and opens nothing, where connect-src does not admit the origin', async () => {
    createService(undefined, { oneTimeOrigin: 'https://rendezvous.example.com' });

    expect((await command('oneTimeStatus')).result).toEqual({
      status: 'unavailable',
      reason: 'origin-not-allowed',
    });
    expect((await command('oneTimeOpen')).error).toContain(CONNECT_SRC);
    expect(rendezvous.rooms).toEqual([]);
    expect(oneTimeStates()).toEqual([]);
  });

  it('is unavailable for an origin no link can carry', async () => {
    // Plain HTTP off loopback: the phone would refuse every link it minted.
    createService(undefined, { oneTimeOrigin: 'http://hosted.dormouse.sh' });
    expect((await command('oneTimeStatus')).result).toEqual({
      status: 'unavailable',
      reason: 'origin-invalid',
    });
    expect((await command('oneTimeOpen')).error).toMatch(/unavailable/);
    expect(rendezvous.rooms).toEqual([]);
    // The same answer a window with no service gives (`vscode-ext/src/burrow.ts`).
    expect(idleOneTimeState('http://hosted.dormouse.sh', CONNECT_SRC)).toEqual({
      status: 'unavailable',
      reason: 'origin-invalid',
    });
    expect(idleOneTimeState(ONE_TIME_ORIGIN, CONNECT_SRC)).toEqual({ status: 'idle' });
  });

  it('joins an open in flight rather than minting a second room', async () => {
    createService();
    const [first, second] = await Promise.all([command('oneTimeOpen'), command('oneTimeOpen')]);
    expect(rendezvous.rooms).toHaveLength(1);
    expect(first.result).toMatchObject({ status: 'waiting' });
    expect(second.result).toEqual(first.result);
  });

  it('replaces a waiting link, whose room goes with it unannounced', async () => {
    createService();
    const first = await open();
    const firstRoom = rendezvous.room();

    const second = await open();
    expect(rendezvous.rooms).toHaveLength(2);
    expect(second.url).not.toBe(first.url);
    expect(firstRoom.burrow.closeCode).toBe(1000);
    // The replaced runtime's ending is not announced as this service's: the
    // replacement's `opening` is, and `serving` never dropped between them.
    expect(oneTimeStates().map((state) => state.status)).toEqual([
      'opening',
      'waiting',
      'opening',
      'waiting',
    ]);
    expect(servingEvents()).toEqual([true]);
  });

  it('replaces a link a phone is confirming, and its modal with it', async () => {
    createService();
    const phone = await join((await open()).url);
    const item = await request(phone);

    await open();
    expect(queueEvents().at(-1)!.queue).toEqual([]);
    // The old modal's ticket names nothing now.
    expect((await approve(item)).error).toContain('no longer pending');
    expect(phone.socket.closeCode).not.toBeNull();
  });

  it('queues the request in its own slot, and routes the answer by kind', async () => {
    createService();
    const phone = await join((await open()).url);
    const item = await request(phone);
    expect(item).toEqual({
      kind: 'one-time',
      clientId: '',
      pairingId: expect.any(String),
      label: 'iPhone',
      requestedAt: expect.any(Number),
    });
    expect(oneTimeStates().at(-1)).toMatchObject({ status: 'confirming', label: 'iPhone' });
    // The digits the phone shows are not in anything the webviews heard.
    expect(JSON.stringify(uiEvents())).not.toContain('"42"');

    // An answer that names no kind is a pairing's — a webview from before the
    // field — and no pairing holds this ticket, so the one attempt is not spent.
    expect(
      (await command('approve', { clientId: '', pairingId: item.pairingId, code: '42' })).error,
    ).toContain('no longer pending');
    expect((await command('deny', { clientId: '', pairingId: item.pairingId })).error).toContain(
      'no longer pending',
    );
    // Nor does a ticket the modal was not showing.
    expect(
      (await command('approve', { kind: 'one-time', clientId: '', pairingId: 'stale', code: '42' }))
        .error,
    ).toContain('no longer pending');
    expect(oneTimeStates().at(-1)).toMatchObject({ status: 'confirming' });

    expect((await approve(item)).result).toEqual({});
    // Un-enrolled, the phone is told the name the enrollment form would suggest.
    expect(await phone.next()).toEqual({ ok: true, burrowLabel: `${hostname()} (VS Code)` });
    expect(oneTimeStates().at(-1)).toEqual({ status: 'connecting', label: 'iPhone' });
    expect(queueEvents().at(-1)!.queue).toEqual([]);
  });

  it('denies by kind, which ends the connection', async () => {
    createService();
    const phone = await join((await open()).url);
    const item = await request(phone);

    await command('deny', { kind: 'one-time', clientId: '', pairingId: item.pairingId });
    expect(await phone.next()).toEqual({ ok: false, code: 'user-denied' });
    expect(oneTimeStates().at(-1)).toEqual({ status: 'ended', reason: 'user-denied' });
    expect(queueEvents().at(-1)!.queue).toEqual([]);
    expect(servingEvents()).toEqual([true, false]);
  });

  it('answers a one-time request without waiting behind an enrollment', async () => {
    // An enroll holds the lifecycle chain across its round trip to the Relay,
    // and the one attempt must not wait that out past the link's expiry.
    createService();
    const phone = await join((await open()).url);
    const item = await request(phone);
    const relay = Promise.withResolvers<Response>();
    vi.stubGlobal('fetch', () => relay.promise);
    const enrolling = command('enroll', { relayUrl: ORIGIN, password: 'setup', label: 'Laptop' });
    await settle();

    await approve(item);
    expect(await phone.next()).toMatchObject({ ok: true });

    relay.resolve({ ok: false, status: 503, text: async () => '' } as Response);
    expect((await enrolling).error).toBeTruthy();
  });

  it('takes a pane back by ending the one-time session that holds it', async () => {
    // A provider whose one pane records the hold an attach takes and gives back.
    const holds: SurfaceHold[] = [];
    const released: SurfaceHold[] = [];
    createService(undefined, {
      provider: {
        ...fakeProvider(),
        resolveSurface: async (_surfaceId, _size, hold) => {
          holds.push(hold);
          return {
            ptyId: 'pty-1',
            cols: 51,
            rows: 14,
            resize: async (cols, rows) => ({ cols, rows }),
            release: () => void released.push(hold),
          };
        },
        streamPty: () => ({ stop: () => {}, ready: Promise.resolve() }),
      },
    });
    const phone = await join((await open()).url);
    await approve(await request(phone));
    expect(await phone.next()).toMatchObject({ ok: true });
    const { peer, inbound } = await negotiateOneTimeDirect(phone, network);
    phone.sendControl({ v: 1, t: 'direct-switch' });
    await settleUntil(() => oneTimeStates().at(-1)?.status === 'connected');
    const attach = { requestId: 'a-1', method: 'surface.attach', params: { surfaceId: 's1', cols: 51, rows: 14 } };
    for (const ct of phone.session.sendApp(utf8Encode(JSON.stringify(attach)))) peer.send(ct);
    await settleUntil(() => holds.length > 0);
    // The pane is held under the phone's own label, and an id only this session has.
    expect(holds[0]).toMatchObject({ label: 'iPhone' });

    const holder = holds[0]!.holder;
    expect((await command('takeBack', { holder })).result).toEqual({ ended: true });
    // End itself: the phone is told, and the pane is given back.
    expect(oneTimeStates().at(-1)).toEqual({ status: 'ended', reason: 'user-ended' });
    expect(released).toEqual([holds[0]]);
    await settleUntil(() => inbound.length >= 2);
    const received = inbound.map((ct) => openReceipt(phone.session, ct));
    expect(received.at(-1)).toEqual({ v: 1, t: 'session-end' });

    // Gone with its session: a second Take back ends nothing.
    expect((await command('takeBack', { holder })).result).toEqual({ ended: false });
    expect((await command('takeBack', {})).result).toEqual({ ended: false });
  });

  it('refuses a new link while a phone holds this one, connecting or connected', async () => {
    createService();
    const phone = await join((await open()).url);
    await approve(await request(phone));
    expect(await phone.next()).toMatchObject({ ok: true });

    expect((await command('oneTimeOpen')).error).toMatch(/already/);
    await switchDirect(phone);
    expect(oneTimeStates().at(-1)).toMatchObject({ status: 'connected', label: 'iPhone' });
    expect((await command('oneTimeOpen')).error).toMatch(/already/);
    expect(rendezvous.rooms).toHaveLength(1);

    // End is the way out, and a new link is then a new room.
    await command('oneTimeEnd');
    expect(oneTimeStates().at(-1)).toEqual({ status: 'ended', reason: 'user-ended' });
    await open();
    expect(rendezvous.rooms).toHaveLength(2);

    // Every state it announced is one a panel — or the VS Code marker — can read.
    expect(new Set(oneTimeStates().map((state) => state.status))).toEqual(
      new Set(['opening', 'waiting', 'confirming', 'connecting', 'connected', 'ended']),
    );
    expect(oneTimeStates().every(isOneTimeState)).toBe(true);
    for (const malformed of [
      null,
      { status: 'waiting', expiresAt: 1 },
      { status: 'connected', label: 'x' },
      { status: 'ended' },
      { status: 'unheard-of' },
    ]) {
      expect(isOneTimeState(malformed), JSON.stringify(malformed)).toBe(false);
    }
  });

  it('survives the enrollment going, and a reconnect', async () => {
    createService({ enrollment: ENROLLMENT });
    await service.start();
    sockets[0]!.open();
    const waiting = await open();

    await command('clearEnrollment');
    await command('reconnect');
    expect((await command('oneTimeStatus')).result).toEqual(waiting);
    expect(rendezvous.room().burrow.readyState).toBe(1);
    // The enrollment gate cycled; the serving one never dropped.
    expect(statusEvents()).toEqual([true, false]);
    expect(servingEvents()).toEqual([true, true]);

    // And the link still works end to end, the phone told the enrolled name
    // the connection opened under.
    const phone = await join(waiting.url);
    await approve(await request(phone));
    expect(await phone.next()).toEqual({ ok: true, burrowLabel: ENROLLMENT.label });
  });

  it('keeps its request beside the pairings, and through a clearEnrollment', async () => {
    const authenticator = await createTestAuthenticator({ rpId: ENROLLMENT.rpId, origin: ORIGIN });
    createService({ enrollment: ENROLLMENT });
    await service.start();
    const socket = sockets[0]!;
    socket.open();
    const qr = (await command('setupQr')).result as SetupQrResult;
    const invitation = await parsePairingInvitationUrl(qr.url, ORIGIN);
    await pairThroughSocket({
      socket,
      burrowId: ENROLLMENT.burrowId,
      clientId: 'c1',
      invitation: invitation!,
      authenticator,
      until: () => queueEvents().length > 0,
    });

    const phone = await join((await open()).url);
    await request(phone);
    // Pairings first, the one-time request after them.
    expect(queueEvents().at(-1)!.queue.map((item) => [item.kind, item.clientId])).toEqual([
      ['pairing', 'c1'],
      ['one-time', ''],
    ]);

    // Clearing the enrollment drops the pairing, whose Relay is gone, and
    // nothing else.
    await command('clearEnrollment');
    expect(queueEvents().at(-1)!.queue.map((item) => item.kind)).toEqual(['one-time']);
    expect(oneTimeStates().at(-1)).toMatchObject({ status: 'confirming' });
  });

  it('ends with the service, and says nothing after', async () => {
    createService();
    await open();
    const before = sent.length;

    service.dispose();
    expect(rendezvous.room().burrow.closeCode).toBe(1000);
    await settle();
    expect(sent).toHaveLength(before);
  });

  it('opens the rendezvous with no Origin header, over Node’s own WebSocket', async () => {
    // The Burrow route refuses any Origin, so that no browser page can mint a
    // room; the default factory is the global the sidecar runs on.
    const { WebSocketServer } = await import('ws');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => server.on('listening', resolve));
    const { port } = server.address() as { port: number };
    const upgrades: Array<{ url?: string; origin?: string }> = [];
    server.on('connection', (socket, request) => {
      upgrades.push({ url: request.url, origin: request.headers.origin });
      socket.send(
        JSON.stringify({ t: 'one-time-room', roomId: testRoutingId(), expiresAt: Date.now() + 60_000 }),
      );
    });
    try {
      const origin = `http://127.0.0.1:${port}`;
      createService(undefined, {
        oneTimeOrigin: origin,
        connectSrc: `${origin} ws://127.0.0.1:${port}`,
        createWebSocket: undefined,
      });
      expect(await open()).toMatchObject({ status: 'waiting' });
      expect(upgrades).toEqual([{ url: ONE_TIME_WS_ROUTES.burrow, origin: undefined }]);
    } finally {
      service.dispose();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
