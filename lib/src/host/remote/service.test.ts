/**
 * The Node-resident Burrow, driven the way both of its neighbours drive it: the
 * webview through `handleCommand`, and the relay through a fake `/ws/burrow`
 * socket. The point of most cases here is that nothing a webview says can widen
 * access — recipients, the ACL, and the relay origin are all read on this side.
 */

import { hostname } from 'node:os';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The socket factory, direct path, and fetch the service handed on, kept so a
 * case can play a path that forgot its own policy check. The runtime and the
 * exchange are the real ones.
 */
const handedTransport = vi.hoisted(() => ({
  createWebSocket: null as ((url: string) => unknown) | null,
  directPeering: null as DirectPeering | null,
  fetch: null as typeof globalThis.fetch | null,
}));

vi.mock('../../remote/burrow/burrow-runtime', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../remote/burrow/burrow-runtime')>();
  class BurrowRuntime extends real.BurrowRuntime {
    constructor(options: ConstructorParameters<typeof real.BurrowRuntime>[0]) {
      super(options);
      handedTransport.createWebSocket = options.createWebSocket ?? null;
      handedTransport.directPeering = options.directPeering ?? null;
    }
  }
  return { ...real, BurrowRuntime };
});

vi.mock('../../remote/burrow/enrollment', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../remote/burrow/enrollment')>();
  return {
    ...real,
    performEnrollment: (...args: Parameters<typeof real.performEnrollment>) => {
      handedTransport.fetch = args[3] ?? null;
      return real.performEnrollment(...args);
    },
  };
});
import {
  API_ROUTES,
  MAX_PENDING_PAIRINGS,
  NOT_ENTITLED_ERROR,
  ONE_TIME_WS_ROUTES,
  ORIGIN_MISMATCH_ERROR,
  RELAY_BEARER_LENGTH,
  UNAUTHORIZED_ERROR,
  WS_CLOSE_BURROW_REVOKED,
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
import type { PendingPairing } from '../../remote/burrow/pairing-approval';
import type {
  BurrowSurfaceProvider,
  SurfaceHold,
} from '../../remote/burrow/burrow-surface-provider';
import type { OneTimeState } from '../../remote/burrow/one-time-runtime';
import { levelsFor, nothingPolicy, type NetworkInterfaceInfo, type NetworkPolicy } from '../../remote/network-policy';
import type { DirectPathPolicy, DirectPeering } from '../../remote/direct/direct-peer';
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
  offerOneTimeDirect,
  type TestOneTimePhone,
  type TestRendezvous,
} from '../../remote/test-rendezvous';
import { createEphemeralBurrowStateStore, type BurrowStateStore } from './burrow-state-store';
import { DEFAULT_RELAY_ORIGIN } from '../relay-origin';
import type { BurrowDirectPeerFactory } from './native-direct-peer';
import {
  BurrowService,
  enqueuePending,
  enrollVerificationUrl,
  suggestedBurrowLabel,
  type BurrowServiceOptions,
} from './service';
import { ANYWHERE_ON, LAN, LOCAL_ON, RELAY_ON } from './test-burrow-link';
import { idleOneTimeState, isOneTimeState } from './service-protocol';
import type {
  BurrowStatusEvent,
  BurrowUiEvent,
  InvitationEvent,
  NetworkPolicyEvent,
  OneTimeEvent,
  PairingQueueEvent,
  PairingQueueItem,
  BurrowConsoleStatus,
  SetupQrResult,
} from './service-protocol';

const BURROW_ID = testRoutingId();
/** The self-host Relay the default service here was baked for. */
const ORIGIN = 'https://relay.example.ts.net';
/** The shipped relay origin: a Hosted build's, where one-time links are made. */
const HOSTED_ORIGIN = DEFAULT_RELAY_ORIGIN;

/**
 * The enrollment every case runs on, with a **real** Noise static: the service
 * checks that its halves correspond before it starts a Burrow.
 */
let ENROLLMENT: BurrowEnrollment;

beforeAll(async () => {
  const material = await mintNoiseStaticKeyPair();
  ENROLLMENT = {
    relayUrl: ORIGIN,
    burrowId: BURROW_ID,
    burrowToken: 'tok',
    origin: ORIGIN,
    rpId: 'relay.example.ts.net',
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
  network: NetworkPolicy | null;
}

type Seed = Partial<Pick<MemoryStore, 'enrollment' | 'acl' | 'network'>>;

/**
 * The builds' own cases run under `RELAY_ON` / `LOCAL_ON`, their network on, so
 * a case about a Relay or a one-time link is not also a case about the policy.
 * The `network policy` cases seed their own, `null` included.
 */
const NOTHING = nothingPolicy();

/** What the injected interface list answers. */
const INTERFACES: NetworkInterfaceInfo[] = [
  { id: 'en0', label: 'Local network', kind: 'lan', prefixes: [LAN] },
];

/**
 * A durable store whose contents a test can seed and read back — not
 * `createEphemeralBurrowStateStore`, whose whole point is `persistent: false`,
 * which is what the adopt cases turn on.
 */
function memoryStore(seed: Seed = {}): MemoryStore {
  const store: MemoryStore = {
    persistent: true,
    enrollment: seed.enrollment ?? null,
    acl: seed.acl ?? {},
    network: seed.network ?? null,
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
    loadNetworkPolicy: async () => store.network,
    saveNetworkPolicy: async (policy) => {
      store.network = policy;
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
/** Where each relay socket in {@link sockets} was opened to. */
let socketUrls: string[];
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
/** The `origin` the fake Relay's enroll answer reports; its own URL's by default. */
let enrollReportedOrigin: string | null;
/**
 * Whether the fake Relay refuses a request naming another origin, as a
 * conforming one does; off, it answers for its own origin regardless.
 */
let relayChecksOrigin: boolean;
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
      const relayOrigin = enrollReportedOrigin ?? new URL(url).origin;
      const claimed = (JSON.parse(String(init?.body)) as { origin?: string }).origin;
      if (relayChecksOrigin && claimed !== undefined && claimed !== relayOrigin) {
        return {
          ok: false,
          status: 409,
          text: async () => JSON.stringify({ error: ORIGIN_MISMATCH_ERROR, origin: relayOrigin }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          burrowId: BURROW_ID,
          burrowToken: 'tok',
          origin: enrollReportedOrigin ?? new URL(url).origin,
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
  origin: ORIGIN,
  token: 'a'.repeat(64),
  mintedAt: '2026-08-31T00:00:00.000Z',
};

function createService(seed?: Seed, over: Partial<BurrowServiceOptions> = {}): BurrowService {
  store = memoryStore({ network: RELAY_ON, ...seed });
  service = new BurrowService({
    store,
    provider: fakeProvider(),
    kind: 'vscode',
    sendToUi: (event, data) => sent.push({ event, data: data as Record<string, unknown> }),
    // A self-host build: the only kind that enrolls (docs/specs/relay.md → "Relay origin").
    relay: { origin: ORIGIN, mode: 'self-host' },
    // One factory for both sockets, as each host passes: the rendezvous route
    // reaches the in-memory room, everything else the fake relay.
    createWebSocket: (url) => {
      if (new URL(url).pathname === ONE_TIME_WS_ROUTES.burrow) {
        return rendezvous.createBurrowSocket(url);
      }
      const socket = new FakeSocket();
      sockets.push(socket);
      socketUrls.push(url);
      return socket;
    },
    createDirectPeer: () => network.createAnswerer(),
    fetch: fakeFetch(),
    readOffer: async () => {
      offerReads++;
      if (offerGate) await offerGate;
      return offer;
    },
    listInterfaces: () => INTERFACES,
    ...over,
  });
  return service;
}

/**
 * A Hosted build — the only kind with one-time connections (`hostedOrigin` in
 * `../relay-origin.ts`). A seeded enrollment is moved to the Hosted origin,
 * since one naming any other reads as none.
 */
function createHostedService(seed?: Seed, over: Partial<BurrowServiceOptions> = {}): BurrowService {
  const enrollment = seed?.enrollment
    ? {
        ...seed.enrollment,
        relayUrl: HOSTED_ORIGIN,
        origin: HOSTED_ORIGIN,
        rpId: new URL(HOSTED_ORIGIN).hostname,
      }
    : seed?.enrollment;
  return createService(
    { network: LOCAL_ON, ...seed, enrollment },
    { relay: { origin: HOSTED_ORIGIN, mode: 'hosted' }, ...over },
  );
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

/** Run `setNetworkPolicy` with `policy`, as the Network panel sends it. */
function setPolicy(policy: unknown): Promise<Record<string, unknown>> {
  return command('setNetworkPolicy', { policy });
}

function queueEvents(): PairingQueueEvent[] {
  return uiEvents().filter((event): event is PairingQueueEvent => event.name === 'pairing-queue');
}

function uiEvents(): BurrowUiEvent[] {
  return sent
    .filter((message) => message.event === 'burrow:event')
    .map((message) => message.data as unknown as BurrowUiEvent);
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

/** One factory call: the path policy, and whether to gather through STUN, the service handed it. */
type Handed = [DirectPathPolicy | undefined, boolean | undefined];

/**
 * A factory whose answerer selects `remote` from this end on the allowed
 * LAN, recording what each attempt hands it.
 */
function answererTo(remote: string, handed: Handed[]): BurrowDirectPeerFactory {
  return (pathPolicy, stun) => {
    handed.push([pathPolicy, stun]);
    const answerer = network.createAnswerer();
    answerer.selectedPair = { local: '192.168.1.2', remote };
    return answerer;
  };
}

beforeEach(() => {
  sockets = [];
  socketUrls = [];
  rendezvous = createTestRendezvous();
  network = new FakeDirectNetwork();
  sent = [];
  requests = [];
  offer = null;
  offerReads = 0;
  offerGate = null;
  setupTokensMinted = 0;
  setupTokenMalformed = false;
  enrollReportedOrigin = null;
  relayChecksOrigin = true;
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
      relayOrigin: ORIGIN,
      relayMode: 'self-host',
      burrowId: null,
      connection: 'stopped',
      pairedClients: 0,
      suggestedLabel: `${hostname()} (VS Code)`,
      offer: false,
      hostedEnrollment: null,
      accountOrigin: null,
    } satisfies BurrowConsoleStatus);
  });

  it('names a Hosted build, and reads no offer there', async () => {
    // A Hosted build enrolls nowhere, so an installer's offer is no card it could
    // show — and the 2 s poll must not stat a file for one.
    offer = OFFER;
    createHostedService();
    await service.start();

    expect((await command('status')).result).toMatchObject({
      enrolled: false,
      relayOrigin: HOSTED_ORIGIN,
      relayMode: 'hosted',
      offer: false,
    });
    expect(offerReads).toBe(0);
  });

  it('offers no installer offer that names another origin', async () => {
    // This build could never enroll against it (docs/specs/relay.md → "Relay origin").
    offer = { ...OFFER, origin: 'https://elsewhere.example' };
    createService();
    await service.start();

    expect((await command('status')).result).toMatchObject({ enrolled: false, offer: false });
  });

  it('offers the installer’s enrollment while un-enrolled, without its token', async () => {
    offer = OFFER;
    createService();
    await service.start();

    expect((await command('status')).result).toEqual({
      enrolled: false,
      serving: false,
      relayOrigin: ORIGIN,
      relayMode: 'self-host',
      burrowId: null,
      connection: 'stopped',
      pairedClients: 0,
      suggestedLabel: `${hostname()} (VS Code)`,
      offer: true,
      hostedEnrollment: null,
      accountOrigin: null,
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

    expect((await command('status')).result).toMatchObject({ enrolled: true, offer: false });
    expect(offerReads).toBe(0);
  });

  it('reports the relay socket and the paired count once running', async () => {
    createService({ enrollment: ENROLLMENT, acl: { [BURROW_ID]: [aclRecord('device-1')] } });
    await service.start();
    sockets[0]!.open();

    expect((await command('status')).result).toEqual({
      enrolled: true,
      serving: true,
      relayOrigin: ORIGIN,
      relayMode: 'self-host',
      burrowId: BURROW_ID,
      connection: 'connected',
      pairedClients: 1,
      suggestedLabel: `${hostname()} (VS Code)`,
      offer: false,
      hostedEnrollment: null,
      accountOrigin: null,
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
    await command('enroll', { password: 'setup', label: 'Laptop' });
    expect(statusEvents()).toEqual([true]);

    // ...and only then let the status read finish.
    release();
    expect((await status).result).toMatchObject({ enrolled: true, offer: false });
  });

  it('rejects a command it does not know', async () => {
    createService();
    expect((await command('nope')).error).toContain('nope');
  });
});

describe('enroll', () => {
  it('refuses in a Hosted build, before the setup password leaves the machine', async () => {
    // Hosted takes no setup password: its build enrolls by device code
    // (docs/specs/relay.md → "Relay origin").
    createHostedService();
    const result = await command('enroll', { password: 'setup', label: 'Laptop' });

    expect(result.error).toMatch(/Dormouse Hosted/);
    expect(requests).toEqual([]);
    expect(store.enrollment).toBeNull();
  });

  it('enrolls, persists, and starts against the baked origin, naming it to the Relay', async () => {
    createService();
    const result = await command('enroll', { password: 'setup', label: 'Laptop' });

    expect(result.result).toEqual({ burrowId: BURROW_ID });
    expect(requests.map((request) => request.url)).toEqual([`${ORIGIN}${API_ROUTES.burrowEnroll}`]);
    expect(requestBody(0)).toEqual({ password: 'setup', origin: ORIGIN });
    expect(store.enrollment?.burrowToken).toBe('tok');
    expect(sockets).toHaveLength(1);
  });

  it('is refused by a Relay served from another origin, which saves nothing', async () => {
    // A Relay whose DORMOUSE_ORIGIN is not the origin this build was made for
    // would send every phone somewhere else; the mismatch is named, both ways.
    enrollReportedOrigin = 'https://relay.example.com';
    createService();
    const result = await command('enroll', { password: 'setup', label: 'Laptop' });

    expect(result.error).toBe(
      `The Relay says its origin is https://relay.example.com, but this build was made for ${ORIGIN}. ` +
        `Rebuild Dormouse with DORMOUSE_RELAY_ORIGIN=https://relay.example.com, or set the Relay's ` +
        `DORMOUSE_ORIGIN to ${ORIGIN}.`,
    );
    expect(store.enrollment).toBeNull();
    expect(sockets).toEqual([]);
    expect(statusEvents()).toEqual([]);
  });

  it('names a console call with no label by the suggested one, before the exchange', async () => {
    // `window.dormouseBurrow.enroll(password)` passes whatever it was given;
    // an enrollment is never stored without a label, so it is resolved before
    // the one request that spends the credential.
    createService();
    const result = await command('enroll', { password: 'setup' });

    expect(result.result).toEqual({ burrowId: BURROW_ID });
    expect(requests).toHaveLength(1);
    expect(store.enrollment?.label).toBe(suggestedBurrowLabel('vscode'));

    offer = OFFER;
    createService();
    expect((await command('enrollOffer', { label: '   ' })).result).toEqual({ burrowId: BURROW_ID });
    expect(store.enrollment?.label).toBe(suggestedBurrowLabel('vscode'));
  });

  it('refuses what a Relay enrolled for another origin, naming the row it left', async () => {
    // It answered for an origin the request did not name, so its
    // `burrows.json` already holds a row nobody has the token for.
    relayChecksOrigin = false;
    enrollReportedOrigin = 'https://relay.example.com';
    createService();
    const result = await command('enroll', { password: 'setup', label: 'Laptop' });

    expect(result.error).toContain('The Relay says its origin is https://relay.example.com');
    expect(result.error).toContain(
      `The Relay has already recorded Burrow ${BURROW_ID}; remove it from burrows.json.`,
    );
    expect(store.enrollment).toBeNull();
    expect(sockets).toEqual([]);
    expect(statusEvents()).toEqual([]);
  });

  it('replaces a running Burrow rather than adding one', async () => {
    createService({ enrollment: ENROLLMENT });
    await service.start();
    sockets[0]!.open();

    await command('enroll', { password: 'setup', label: 'Laptop' });
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

    const result = await command('enroll', { password: 'setup', label: 'Laptop' });

    expect(result.error).toContain('keychain is locked');
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.readyState).toBe(1);
    expect((await command('status')).result).toMatchObject({
      enrolled: true,
      burrowId: ENROLLMENT.burrowId,
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

    await command('enroll', { password: 'setup', label: 'Laptop' });

    expect(statusEvents()).toEqual([true, false, true]);
  });
});

describe('enrollOffer', () => {
  it('redeems the installer’s token, and sends no password', async () => {
    offer = OFFER;
    createService();

    const result = await command('enrollOffer', { label: 'Laptop' });

    expect(result.result).toEqual({ burrowId: BURROW_ID });
    expect(requests).toHaveLength(1);
    // The credential and the baked origin: the label the operator typed stays local.
    expect(requestBody(0)).toEqual({ enrollToken: OFFER.token, origin: ORIGIN });
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

    const result = await command('enrollOffer', { label: 'Laptop' });

    expect(result.error).toMatch(/no enrollment offer for .* on this machine/i);
    expect(requests).toEqual([]);
    expect(store.enrollment).toBeNull();
  });

  it('refuses an offer for any origin but the baked one, rewritten at the click included', async () => {
    // A Relay installed on this machine is not thereby one this build may reach,
    // and the one-time token must not leave before that is checked.
    offer = OFFER;
    createService();
    await command('status');
    offer = { ...OFFER, origin: 'https://relay.example.com' };

    const result = await command('enrollOffer', { label: 'Laptop' });

    expect(result.error).toMatch(/no enrollment offer for/i);
    expect(result.error).toContain(ORIGIN);
    expect(requests).toEqual([]);
    expect(store.enrollment).toBeNull();
  });

  it('refuses in a Hosted build, before the offer is read', async () => {
    offer = { ...OFFER, origin: HOSTED_ORIGIN };
    createHostedService();

    const result = await command('enrollOffer', { label: 'Laptop' });

    expect(result.error).toMatch(/Dormouse Hosted/);
    expect(offerReads).toBe(0);
    expect(requests).toEqual([]);
  });

  it('refuses an offer whose Relay reports another origin, saving nothing', async () => {
    offer = OFFER;
    enrollReportedOrigin = 'https://relay.example.com';
    createService();

    const result = await command('enrollOffer', { label: 'Laptop' });

    expect(result.error).toContain('https://relay.example.com');
    expect(result.error).toContain(ORIGIN);
    expect(store.enrollment).toBeNull();
  });
});

describe('start', () => {
  it('keeps a Burrow whose Noise static halves disagree down, loudly, touching nothing', async () => {
    // A corrupt or hand-edited state file: starting would present an identity
    // every paired Client reads as changed (docs/specs/remote-security-model.md
    // → Burrow identity).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const other = await mintNoiseStaticKeyPair();
    const corrupt = { ...ENROLLMENT, noiseStaticPublicKey: other.publicKey };
    createService({ enrollment: corrupt });
    await service.start();

    expect(sockets).toEqual([]);
    expect(store.enrollment).toEqual(corrupt);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not match its public half'));
    warn.mockRestore();
  });

  it('reads an enrollment for another origin as none, loudly, and keeps it on disk', async () => {
    // Enrolled by another build — a stock one, or one baked for a Relay that
    // moved. Nothing connects to it, and switching back restores it
    // (docs/specs/relay.md → "Relay origin").
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const elsewhere = { ...ENROLLMENT, relayUrl: 'https://relay.example.com' };
    createService({ enrollment: elsewhere });
    await service.start();

    expect(sockets).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect((await command('status')).result).toMatchObject({ enrolled: false, connection: 'stopped' });
    expect(statusEvents()).toEqual([false]);
    expect(store.enrollment).toEqual(elsewhere);
    warn.mockRestore();
  });

  it('reads an enrollment whose phone-facing origin is another as none', async () => {
    // One from before the single baked origin could name its Relay here and
    // send phones elsewhere; the warning names both.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const split = { ...ENROLLMENT, origin: 'https://phones.example.com' };
    createService({ enrollment: split });
    await service.start();

    expect(sockets).toEqual([]);
    expect(String(warn.mock.calls[0]?.[0])).toContain(ENROLLMENT.relayUrl);
    expect(String(warn.mock.calls[0]?.[0])).toContain('https://phones.example.com');
    expect(store.enrollment).toEqual(split);
    warn.mockRestore();
  });

  it('reads an enrollment for its own origin, however it was spelled', async () => {
    createService({ enrollment: { ...ENROLLMENT, relayUrl: `${ORIGIN}/` } });
    await service.start();

    expect(sockets).toHaveLength(1);
  });

  it('asks the Relay about a refused upgrade through its guarded fetch, and reports what it said', async () => {
    for (const [status, error, connection] of [
      [401, UNAUTHORIZED_ERROR, 'removed'],
      [403, NOT_ENTITLED_ERROR, 'not-entitled'],
    ] as const) {
      requests.length = 0;
      sockets.length = 0;
      createService(
        { enrollment: ENROLLMENT },
        {
          fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
            requests.push({ url: String(input), init });
            return new Response(JSON.stringify({ error }), { status });
          }) as unknown as typeof globalThis.fetch,
        },
      );
      await service.start();
      sockets[0]!.emitError();
      sockets[0]!.closeWith(1006);
      await vi.waitFor(async () =>
        expect(((await command('status')).result as BurrowConsoleStatus).connection).toBe(connection),
      );
      expect(requests.map((request) => request.url)).toEqual([`${ORIGIN}${API_ROUTES.pushDevices}`]);
      expect(sockets).toHaveLength(1);
      service.dispose();
    }
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
    // Only what a start says at once, before the disposal: its one-time state.
    expect(sent.map((message) => message.data)).toEqual([
      { name: 'one-time', state: { status: 'unavailable', reason: 'self-host' } },
    ]);
  });

  it('persists a UV demand the Relay raised after enrollment, so a restart keeps it', async () => {
    createService({ enrollment: ENROLLMENT });
    await service.start();
    sockets[0]!.open();
    sockets[0]!.receive({ t: 'policy', requireUserVerification: true });
    await vi.waitFor(() => expect(store.enrollment).toEqual({ ...ENROLLMENT, requireUserVerification: true }));
  });

  it('writes no raise onto an enrollment cleared while it waited', async () => {
    createService({ enrollment: ENROLLMENT });
    await service.start();
    sockets[0]!.open();
    // The delete is in flight, the Burrow still running, when the Relay speaks.
    let release!: () => void;
    const clear = store.clearEnrollment;
    store.clearEnrollment = async () => {
      await new Promise<void>((resolve) => (release = resolve));
      await clear();
    };
    const cleared = command('clearEnrollment');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    sockets[0]!.receive({ t: 'policy', requireUserVerification: true });
    release();
    await cleared;
    // Past every serialized task the raise could have queued.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.enrollment).toBeNull();
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
      burrowId: ENROLLMENT.burrowId,
      connection: 'connected',
    });
    expect(statusEvents()).toEqual([true]);
  });
});

describe('status events', () => {
  it('announces a Burrow that started, and one that was cleared', async () => {
    // What every webview arms its outbound work on: an installation that never
    // enrolls arms nothing (`enrolled-gate.ts`).
    createService({ enrollment: ENROLLMENT });
    await service.start();
    expect(statusEvents()).toEqual([true]);

    await command('clearEnrollment');
    expect(statusEvents()).toEqual([true, false]);
  });

  it('says only that nothing runs when there is no Burrow to run', async () => {
    // Its one-time state and its instance, for a webview that outlived the one
    // before it; nothing arms on either.
    createService();
    await service.start();
    await command('status');
    expect(uiEvents()).toEqual([
      { name: 'one-time', state: { status: 'unavailable', reason: 'self-host' } },
      { name: 'status', enrolled: false, serving: false, serviceId: service.statusEvent().serviceId },
    ]);
  });

  it('announces its one-time state as it starts, before its enrollment is read', async () => {
    // A webview that outlived the instance before this one — a VS Code window
    // taking the broker over from one with a phone connected — shows that
    // one's connection, with End, until it is told otherwise.
    createService({ enrollment: ENROLLMENT });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = store.loadEnrollment;
    store.loadEnrollment = async () => {
      await gate;
      return load();
    };

    const starting = service.start();
    // Once the policy is read, the enrollment read still held.
    await flushUntil(() => (uiEvents().length > 0 ? true : undefined));
    expect(uiEvents()).toEqual([{ name: 'one-time', state: { status: 'unavailable', reason: 'self-host' } }]);
    release();
    await starting;
    expect(statusEvents()).toEqual([true]);
  });

  it('names its own instance in every status event, a new one for each service', async () => {
    createService({ enrollment: ENROLLMENT });
    await service.start();
    await command('clearEnrollment');
    const { serviceId } = service.statusEvent();
    expect(serviceId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const named = uiEvents().filter((event): event is BurrowStatusEvent => event.name === 'status');
    expect(named.map((event) => event.serviceId)).toEqual([serviceId, serviceId]);

    service.dispose();
    createService();
    expect(service.statusEvent().serviceId).not.toBe(serviceId);
  });

  it('announces the Burrow an enroll started', async () => {
    createService();
    await command('enroll', { password: 'setup', label: 'Laptop' });
    expect(statusEvents()).toEqual([true]);
  });
});

describe('enqueuePending', () => {
  const request = (clientId: string): PendingPairing => ({ clientId }) as PendingPairing;
  const full = () => {
    const queue = new Map<string, PendingPairing>();
    for (let i = 0; i < MAX_PENDING_PAIRINGS; i += 1) enqueuePending(queue, request(`c${i}`));
    return queue;
  };

  it('holds the cap: one more evicts the oldest', () => {
    const queue = full();
    enqueuePending(queue, request('late'));
    expect([...queue.keys()]).toEqual([
      ...Array.from({ length: MAX_PENDING_PAIRINGS - 1 }, (_, i) => `c${i + 1}`),
      'late',
    ]);
  });

  it('coalesces a re-sent request before evicting, so it displaces only its own entry', () => {
    const queue = full();
    const resent = request('c3');
    enqueuePending(queue, resent);
    expect(queue.size).toBe(MAX_PENDING_PAIRINGS);
    expect(queue.has('c0')).toBe(true);
    // The newer request queues behind the ones already waiting.
    expect([...queue.keys()].at(-1)).toBe('c3');
    expect(queue.get('c3')).toBe(resent);
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
    await command('enroll', { password: 'setup', label: 'Laptop' });
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

  it('sends nothing once the Burrow stops mid-seal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createService({ enrollment: ENROLLMENT, acl: { [BURROW_ID]: [aclRecord('device-1')] } });
    await service.start();

    // Sealing awaits WebCrypto; the change to Nothing lands first.
    const pushing = service.push('pty-1', 'x');
    await setPolicy(nothingPolicy());
    await pushing;
    expect(requests.some((request) => request.url.endsWith('/api/push/send'))).toBe(false);
    warn.mockRestore();
  });

  it('sends nothing with no Burrow running', async () => {
    createService();
    await service.push('pty-1', 'x');
    expect(requests).toEqual([]);
  });

  it('sends nothing, and mints no setup code, once the Relay removed this Burrow', async () => {
    createService({ enrollment: ENROLLMENT, acl: { [BURROW_ID]: [aclRecord('device-1')] } });
    await service.start();
    sockets[0]!.open();
    sockets[0]!.closeWith(WS_CLOSE_BURROW_REVOKED);

    await service.push('pty-1', 'x');
    expect(await command('setupQr')).toMatchObject({ error: expect.stringContaining('not connected') });
    expect(requests).toEqual([]);
  });

  it('warns rather than rejecting when the Relay refuses the send', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createService(
      { enrollment: ENROLLMENT, acl: { [BURROW_ID]: [aclRecord('device-1')] } },
      { fetch: (async () => ({ ok: false, status: 401 })) as unknown as typeof globalThis.fetch },
    );
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
    createService(
      { enrollment: ENROLLMENT, acl: { [BURROW_ID]: [aclRecord('device-1')] } },
      { fetch: (async () => ({ ok: false, status: 500 })) as unknown as typeof globalThis.fetch },
    );
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
    createService(
      { enrollment: ENROLLMENT, acl: { [BURROW_ID]: [aclRecord('device-1')] } },
      { fetch: (async () => ({ ok: false, status: 500 })) as unknown as typeof globalThis.fetch },
    );
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
    const link = await parseOneTimeLinkUrl(url, HOSTED_ORIGIN);
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

  /** Open a link and have a phone confirm it, its outcome `ok`. */
  async function approvedPhone(): Promise<TestOneTimePhone> {
    const phone = await join((await open()).url);
    await approve(await request(phone));
    expect(await phone.next()).toMatchObject({ ok: true });
    return phone;
  }

  /** Open a link, have a phone confirm it, and switch onto the direct path. */
  async function connectPhone(): Promise<void> {
    await switchDirect(await approvedPhone());
  }

  it('is idle on a machine that never enrolled, serving nothing', async () => {
    createHostedService();
    await service.start();

    expect((await command('oneTimeStatus')).result).toEqual({ status: 'idle' });
    expect(service.oneTimeEvent()).toEqual({ name: 'one-time', state: { status: 'idle' } });
    expect((await command('status')).result).toMatchObject({ enrolled: false, serving: false });
    expect(service.statusEvent()).toEqual({
      name: 'status',
      enrolled: false,
      serving: false,
      serviceId: expect.any(String),
    });
  });

  it('opens a link un-enrolled, on the baked origin whatever the webview sends', async () => {
    createHostedService();
    await service.start();

    // The command takes no parameters: an origin in them reaches nothing.
    const { result } = await command('oneTimeOpen', { origin: 'https://evil.example' });
    const waiting = result as Waiting;
    expect(waiting.status).toBe('waiting');
    expect(rendezvous.rooms).toHaveLength(1);
    expect(rendezvous.room().burrowUrl).toBe('wss://relay.dormouse.sh/api/one-time/burrow');
    expect((await parseOneTimeLinkUrl(waiting.url, HOSTED_ORIGIN))?.roomId).toBe(
      rendezvous.room().roomId,
    );
    // No enrollment: no relay socket, and nothing sent to a Relay.
    expect(sockets).toEqual([]);
    expect(requests).toEqual([]);

    // The start's announcement, once the policy is read, then the open.
    expect(oneTimeStates().map((state) => state.status)).toEqual(['idle', 'opening', 'waiting']);
    expect((await command('oneTimeStatus')).result).toEqual(waiting);
    expect(service.oneTimeEvent().state).toEqual(waiting);
  });

  it('serves while a connection is open, and announces each flip', async () => {
    createHostedService();
    await service.start();
    await open();
    // `serving` rose at `opening` from the start's announcement; `enrolled` never did.
    expect(servingEvents()).toEqual([false, true]);
    expect(statusEvents()).toEqual([false, false]);
    expect((await command('status')).result).toMatchObject({ enrolled: false, serving: true });

    // End: the room goes, and so does `serving`.
    expect((await command('oneTimeEnd')).result).toEqual({});
    expect(oneTimeStates().at(-1)).toEqual({ status: 'ended', reason: 'user-ended' });
    expect(rendezvous.room().burrow.closeCode).toBe(1000);
    expect(servingEvents()).toEqual([false, true, false]);

    // Done: back to idle, which moves no gate.
    await command('oneTimeEnd');
    expect(oneTimeStates().at(-1)).toEqual({ status: 'idle' });
    expect(servingEvents()).toEqual([false, true, false]);
    // And an idle one has nothing to end.
    const quiet = uiEvents().length;
    expect((await command('oneTimeEnd')).result).toEqual({});
    expect(uiEvents()).toHaveLength(quiet);
  });

  it('is unavailable, and opens nothing, in a self-host build', async () => {
    // Its one origin is the user's own Relay, which serves no rendezvous, and it
    // reaches nothing of Dormouse's (docs/specs/relay.md → "Relay origin").
    createService();

    expect((await command('oneTimeStatus')).result).toEqual({
      status: 'unavailable',
      reason: 'self-host',
    });
    expect((await command('oneTimeOpen')).error).toMatch(/self-host build/);
    expect(rendezvous.rooms).toEqual([]);
    expect(oneTimeStates()).toEqual([]);
    // The same answers a window with no service gives (`vscode-ext/src/burrow.ts`).
    expect(idleOneTimeState(null)).toEqual({ status: 'unavailable', reason: 'self-host' });
    expect(idleOneTimeState(HOSTED_ORIGIN)).toEqual({ status: 'idle' });
  });

  it('joins an open in flight rather than minting a second room', async () => {
    createHostedService();
    const [first, second] = await Promise.all([command('oneTimeOpen'), command('oneTimeOpen')]);
    expect(rendezvous.rooms).toHaveLength(1);
    expect(first.result).toMatchObject({ status: 'waiting' });
    expect(second.result).toEqual(first.result);
  });

  it('replaces a waiting link, whose room goes with it unannounced', async () => {
    createHostedService();
    const first = await open();
    const firstRoom = rendezvous.room();

    const second = await open();
    expect(rendezvous.rooms).toHaveLength(2);
    expect(second.url).not.toBe(first.url);
    expect(firstRoom.burrow.closeCode).toBe(1000);
    // The replaced runtime's ending is not announced as this service's: the
    // replacement's `opening` is, and `serving` never dropped between them.
    // (The first `idle` is the policy's first read.)
    expect(oneTimeStates().map((state) => state.status)).toEqual([
      'idle',
      'opening',
      'waiting',
      'opening',
      'waiting',
    ]);
    expect(servingEvents()).toEqual([true]);
  });

  it('replaces a link a phone is confirming, and its modal with it', async () => {
    createHostedService();
    const phone = await join((await open()).url);
    const item = await request(phone);

    await open();
    expect(queueEvents().at(-1)!.queue).toEqual([]);
    // The old modal's ticket names nothing now.
    expect((await approve(item)).error).toContain('no longer pending');
    expect(phone.socket.closeCode).not.toBeNull();
  });

  it('queues the request in its own slot, and routes the answer by kind', async () => {
    createHostedService();
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
    createHostedService();
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
    createHostedService();
    const phone = await join((await open()).url);
    const item = await request(phone);
    const relay = Promise.withResolvers<Response>();
    vi.stubGlobal('fetch', () => relay.promise);
    const enrolling = command('enroll', { password: 'setup', label: 'Laptop' });
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
    createHostedService(undefined, {
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
    const phone = await approvedPhone();
    const { peer, inbound } = await negotiateOneTimeDirect(phone, network);
    phone.sendControl({ v: 1, t: 'direct-switch' });
    await settleUntil(() => oneTimeStates().at(-1)?.status === 'connected');
    const attach = { requestId: 'a-1', method: 'surface.attach', params: { surfaceId: 's1', cols: 51, rows: 14 } };
    for (const ct of phone.session.sendApp(utf8Encode(JSON.stringify(attach)))) peer.send(ct);
    await settleUntil(() => holds.length > 0);
    // The pane is held under the phone's own label, an id only this session
    // has, and this service instance.
    expect(holds[0]).toMatchObject({ label: 'iPhone', serviceId: service.statusEvent().serviceId });

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

  describe('under Local networks', () => {
    it('hands the attempt a policy over the allowed networks and no ICE server, and connects over them', async () => {
      const handed: Handed[] = [];
      createHostedService(undefined, { createDirectPeer: answererTo('192.168.1.3', handed) });
      await connectPhone();

      expect(handed).toHaveLength(1);
      const [pathPolicy, stun] = handed[0]!;
      expect(stun).toBe(false);
      expect(pathPolicy!.refusal({ local: '192.168.1.2', remote: '192.168.1.3' })).toBeNull();
      expect(pathPolicy!.refusal({ local: '192.168.1.2', remote: '10.0.0.3' })).not.toBeNull();
    });

    it('ends network-not-allowed when the phone’s end of the pair is off them, naming it', async () => {
      createHostedService(undefined, { createDirectPeer: answererTo('10.0.0.3', []) });
      const phone = await approvedPhone();

      await offerOneTimeDirect(phone, network);
      await settleUntil(() => oneTimeStates().at(-1)?.status === 'ended');
      const refusal = {
        at: expect.any(Number),
        kind: 'path-refused',
        end: 'remote',
        address: '10.0.0.3',
        addressSource: 'observed',
      };
      expect(oneTimeStates().at(-1)).toEqual({ status: 'ended', reason: 'network-not-allowed', refusal });
      expect(servingEvents().at(-1)).toBe(false);

      // Held for Settings → Network too, the one record either runtime reports,
      // until it is dismissed.
      const events = () => uiEvents().filter((event) => event.name === 'network-policy');
      expect(events().at(-1)).toMatchObject({ refusal });
      expect((await command('networkPolicy')).result).toMatchObject({ refusal });
      const dismissed = (await command('dismissPathRefusal')).result as Record<string, unknown>;
      expect(dismissed).not.toHaveProperty('refusal');
      expect(events().at(-1)).not.toHaveProperty('refusal');
      expect((await command('networkPolicy')).result).not.toHaveProperty('refusal');
    });

    it('dismisses only the refusal held when Dismiss arrived, keeping one recorded meanwhile', async () => {
      const answerers: Array<ReturnType<FakeDirectNetwork['createAnswerer']>> = [];
      const remotes = ['10.0.0.3', '192.168.1.3'];
      createHostedService(undefined, {
        createDirectPeer: () => {
          const answerer = network.createAnswerer();
          answerer.selectedPair = { local: '192.168.1.2', remote: remotes[answerers.length]! };
          answerers.push(answerer);
          return answerer;
        },
      });
      await offerOneTimeDirect(await approvedPhone(), network);
      await settleUntil(() => oneTimeStates().at(-1)?.status === 'ended');
      expect((await command('networkPolicy')).result).toMatchObject({ refusal: { address: '10.0.0.3' } });

      // A second phone, on the allowed network, then moved off it in the same
      // tick as a Dismiss of the first refusal: the second is news, and stays.
      network = new FakeDirectNetwork();
      const second = await join((await open()).url);
      const queued = queueEvents().length;
      second.sendControl({ code: '42', label: 'iPhone' });
      const event = await flushUntil(() => queueEvents().slice(queued).find((e) => e.queue.length > 0));
      await approve(event.queue[0]!);
      expect(await second.next()).toMatchObject({ ok: true });
      await switchDirect(second);
      answerers[1]!.setConnectionState('connected');
      const dismissing = service.handleCommand({ burrowRequestId: 'dismiss', cmd: 'dismissPathRefusal' });
      answerers[1]!.reselect({ local: '192.168.1.2', remote: '10.0.0.9' });
      await dismissing;
      expect((await command('networkPolicy')).result).toMatchObject({ refusal: { address: '10.0.0.9' } });
    });

    it('rests that ending, its runtime gone, on a change of path, so no other level reports it', async () => {
      createHostedService(undefined, { createDirectPeer: answererTo('10.0.0.3', []) });
      await offerOneTimeDirect(await approvedPhone(), network);
      await settleUntil(() => oneTimeStates().at(-1)?.status === 'ended');

      // `autoUpdate` alone changes no path, so the ending stays to report.
      await setPolicy({ ...LOCAL_ON, autoUpdate: true });
      expect(oneTimeStates().at(-1)).toMatchObject({ status: 'ended', reason: 'network-not-allowed' });
      await setPolicy(ANYWHERE_ON);
      expect(oneTimeStates().at(-1)).toEqual({ status: 'idle' });
    });
  });

  describe('under Anywhere', () => {
    it('opens a link with no network allowed, its attempt unrestricted and gathering through Cloudflare STUN', async () => {
      const handed: Handed[] = [];
      // A public address, which no allowed network holds and Anywhere never reads.
      createHostedService({ network: ANYWHERE_ON }, { createDirectPeer: answererTo('203.0.113.7', handed) });
      await connectPhone();

      expect(handed).toEqual([[undefined, true]]);
    });

    it('chooses a new link’s STUN with its path policy, from the level at its open', async () => {
      const handed: Handed[] = [];
      createHostedService({ network: ANYWHERE_ON }, { createDirectPeer: answererTo('192.168.1.3', handed) });
      await connectPhone();

      await setPolicy(LOCAL_ON);
      // Forgotten, so the second request is read off its own approval item.
      sent = [];
      await connectPhone();

      // Anywhere's link: STUN and no hold; Local networks': a hold and no STUN.
      expect(handed.map(([pathPolicy, stun]) => [pathPolicy !== undefined, stun])).toEqual([
        [false, true],
        [true, false],
      ]);
    });

    it('keeps a live session through a change to the allowed networks, which govern no path here', async () => {
      createHostedService({ network: ANYWHERE_ON });
      await connectPhone();

      expect((await setPolicy({ ...ANYWHERE_ON, allowed: [LAN] })).error).toBeUndefined();
      expect(oneTimeStates().at(-1)).toMatchObject({ status: 'connected' });
    });
  });

  it('refuses a new link while a phone holds this one, connecting or connected', async () => {
    createHostedService();
    const phone = await approvedPhone();

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
      new Set(['idle', 'opening', 'waiting', 'confirming', 'connecting', 'connected', 'ended']),
    );
    expect(oneTimeStates().every(isOneTimeState)).toBe(true);
    for (const malformed of [
      null,
      { status: 'waiting', expiresAt: 1 },
      { status: 'connected', label: 'x' },
      { status: 'ended' },
      { status: 'ended', reason: 'network-not-allowed', refusal: { at: 1, kind: 'deadline', address: 'phone.local', addressSource: 'observed' } },
      { status: 'unheard-of' },
    ]) {
      expect(isOneTimeState(malformed), JSON.stringify(malformed)).toBe(false);
    }
  });

  it('survives the enrollment going, and a reconnect', async () => {
    // Local networks runs the enrolled Burrow beside the link.
    createHostedService({ enrollment: ENROLLMENT });
    await service.start();
    const waiting = await open();

    await command('clearEnrollment');
    await command('reconnect');
    expect((await command('oneTimeStatus')).result).toEqual(waiting);
    expect(rendezvous.room().burrow.readyState).toBe(1);
    expect(sockets[0]!.readyState).toBe(3);
    // The enrollment gate cycled; the serving one never dropped once up.
    expect(statusEvents()).toEqual([true, false]);
    expect(servingEvents()).toEqual([true, true]);

    // And the link still works end to end, the phone told the enrolled name
    // the connection opened under.
    const phone = await join(waiting.url);
    await approve(await request(phone));
    expect(await phone.next()).toEqual({ ok: true, burrowLabel: ENROLLMENT.label });
  });

  it('keeps its request through a clearEnrollment', async () => {
    createHostedService({ enrollment: ENROLLMENT });
    await service.start();
    const phone = await join((await open()).url);
    await request(phone);

    await command('clearEnrollment');
    expect(queueEvents().at(-1)!.queue.map((item) => item.kind)).toEqual(['one-time']);
    expect(oneTimeStates().at(-1)).toMatchObject({ status: 'confirming' });
  });

  it('ends with the service, and says nothing after', async () => {
    createHostedService();
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
      createHostedService(undefined, { relay: { origin, mode: 'hosted' }, createWebSocket: undefined });
      expect(await open()).toMatchObject({ status: 'waiting' });
      expect(upgrades).toEqual([{ url: ONE_TIME_WS_ROUTES.burrow, origin: undefined }]);
    } finally {
      service.dispose();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

/**
 * The network policy (`docs/specs/remote-network.md` → "Policy"): its default,
 * its setter, and what `nothing` keeps the Burrow service from opening.
 */
describe('network policy', () => {
  function policyEvents(): NetworkPolicyEvent[] {
    return uiEvents().filter((event): event is NetworkPolicyEvent => event.name === 'network-policy');
  }

  describe('its first read', () => {
    it('saves Nothing for a machine that never enrolled', async () => {
      createService({ network: null });
      await service.start();

      expect(store.network).toEqual(NOTHING);
      expect((await command('networkPolicy')).result).toEqual({
        policy: NOTHING,
        levels: ['nothing', 'relay'],
        interfaces: INTERFACES,
      });
    });

    it('saves My Relay only for an enrollment this build reaches, which keeps running', async () => {
      // An upgraded self-host install: dropping its phones would read as breakage.
      createService({ enrollment: ENROLLMENT, network: null });
      await service.start();

      expect(store.network).toEqual(RELAY_ON);
      expect(sockets).toHaveLength(1);
    });

    it('saves Nothing for an enrollment for another origin, which reads as none', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      createService({
        enrollment: { ...ENROLLMENT, relayUrl: 'https://other.example', origin: 'https://other.example' },
        network: null,
      });
      await service.start();
      expect(store.network).toEqual(NOTHING);
      warn.mockRestore();
    });

    it('offers a Hosted build Nothing, Local networks, and Anywhere, starting at Nothing', async () => {
      createHostedService({ network: null });
      expect((await command('networkPolicy')).result).toEqual({
        policy: NOTHING,
        levels: levelsFor('hosted'),
        interfaces: INTERFACES,
      });
    });

    it('reads a level this build does not offer as Nothing, and leaves it on disk', async () => {
      // A Hosted build's choice, read by a self-host build on the same machine.
      createService({ enrollment: ENROLLMENT, network: LOCAL_ON });
      await service.start();

      expect(((await command('networkPolicy')).result as { policy: NetworkPolicy }).policy).toEqual({
        ...LOCAL_ON,
        level: 'nothing',
      });
      expect(store.network).toEqual(LOCAL_ON);
      expect(sockets).toEqual([]);
    });

    it('leaves the Burrow down when the policy cannot be read', async () => {
      createService({ enrollment: ENROLLMENT });
      store.loadNetworkPolicy = async () => {
        throw new Error('EACCES');
      };
      await expect(service.start()).rejects.toThrow('EACCES');
      expect(sockets).toEqual([]);
      expect(await service.networkAllowed()).toBe(false);
    });

    it('saves a choice over a policy it cannot read, and acts on it', async () => {
      createService({ enrollment: ENROLLMENT });
      store.loadNetworkPolicy = async () => {
        throw new Error('EACCES');
      };
      await expect(service.start()).rejects.toThrow('EACCES');

      expect((await setPolicy(RELAY_ON)).error).toBeUndefined();
      expect(store.network).toEqual(RELAY_ON);
      expect(sockets).toHaveLength(1);
    });
  });

  describe('Nothing', () => {
    function enrolledUnderNothing() {
      createService({
        enrollment: ENROLLMENT,
        acl: { [BURROW_ID]: [aclRecord('device-1')] },
        network: NOTHING,
      });
    }

    it('keeps an enrolled Burrow stopped, reporting its enrollment', async () => {
      enrolledUnderNothing();
      await service.start();

      expect(sockets).toEqual([]);
      expect((await command('status')).result).toMatchObject({
        enrolled: true,
        serving: false,
        burrowId: BURROW_ID,
        connection: 'stopped',
      });
      expect(service.statusEvent()).toMatchObject({ enrolled: true, serving: false });
      // And a reconnect does not reopen it.
      await command('reconnect');
      expect(sockets).toEqual([]);
    });

    it('makes no request for push, the device list, a test push, or a setup code', async () => {
      enrolledUnderNothing();
      await service.start();

      await service.push('pty-1', 'build finished');
      expect((await command('pushDevices')).result).toBeNull();
      expect((await command('pushTest')).error).toContain('set to Nothing');
      expect((await command('setupQr')).error).toContain('set to Nothing');
      expect(requests).toEqual([]);
    });

    it('refuses to enroll before any request, the offer file unread', async () => {
      offer = OFFER;
      createService({ network: NOTHING });

      expect((await command('enroll', { password: 'setup', label: 'Laptop' })).error).toContain(
        'set to Nothing',
      );
      expect((await command('enrollOffer', { label: 'Laptop' })).error).toContain('set to Nothing');
      expect(requests).toEqual([]);
      expect(offerReads).toBe(0);
      expect(store.enrollment).toBeNull();
    });

    it('offers no one-time link, and opens none', async () => {
      createHostedService({ network: NOTHING });
      await service.start();

      expect((await command('oneTimeStatus')).result).toEqual({
        status: 'unavailable',
        reason: 'network-off',
      });
      expect((await command('oneTimeOpen')).error).toContain('set to Nothing');
      expect(rendezvous.rooms).toEqual([]);
    });

    it('refuses a socket, a request, or a direct peer at the transport, for a path that forgot its check', async () => {
      createService({ network: RELAY_ON });
      expect((await command('enroll', { password: 'setup', label: 'Laptop' })).error).toBeUndefined();
      const { createWebSocket, directPeering, fetch } = handedTransport;
      expect(sockets).toHaveLength(1);
      const made = requests.length;
      const answerers = vi.spyOn(network, 'createAnswerer');

      await setPolicy(NOTHING);
      expect(() => createWebSocket!(`${ORIGIN.replace(/^http/, 'ws')}/ws/burrow`)).toThrow('set to Nothing');
      await expect(fetch!(`${ORIGIN}${API_ROUTES.pushDevices}`)).rejects.toThrow('set to Nothing');
      // Its `null` declines the direct path, as a host without one does.
      expect(directPeering!.createPeer!()).toBeNull();
      expect(sockets).toHaveLength(1);
      expect(requests).toHaveLength(made);
      expect(answerers).not.toHaveBeenCalled();
    });

    it('refuses managed voice', async () => {
      createHostedService({ network: NOTHING });
      expect(await service.networkAllowed()).toBe(false);

      createHostedService({ network: LOCAL_ON });
      expect(await service.networkAllowed()).toBe(true);
    });
  });

  it('runs a Hosted enrollment under Local networks, holding its sessions to the allowed networks with no STUN', async () => {
    const handed: Handed[] = [];
    createHostedService({ enrollment: ENROLLMENT, network: LOCAL_ON }, { createDirectPeer: answererTo('192.168.1.3', handed) });
    await service.start();
    expect(sockets).toHaveLength(1);
    expect(socketUrls[0]).toMatch(/^wss:\/\/relay\.dormouse\.sh\/ws\/burrow\?/);
    expect((await command('status')).result).toMatchObject({ enrolled: true, connection: 'connecting' });
    const { createPeer, pathPolicy } = handedTransport.directPeering!;
    expect(pathPolicy).toBeDefined();
    expect(createPeer!(pathPolicy)).not.toBeNull();
    expect(handed).toEqual([[pathPolicy, false]]);

    // And again on entering Local networks from Nothing.
    await setPolicy(NOTHING);
    expect(sockets[0]!.readyState).toBe(3);
    await setPolicy(LOCAL_ON);
    expect(sockets).toHaveLength(2);
  });

  it('runs a Hosted enrollment under Anywhere through STUN with no hold, and pushes through relay.dormouse.sh', async () => {
    const handed: Handed[] = [];
    createHostedService(
      { enrollment: ENROLLMENT, network: ANYWHERE_ON, acl: { [BURROW_ID]: [aclRecord('1')] } },
      { createDirectPeer: answererTo('203.0.113.7', handed) },
    );
    await service.start();
    expect(sockets).toHaveLength(1);
    const { createPeer, pathPolicy } = handedTransport.directPeering!;
    expect(pathPolicy).toBeUndefined();
    expect(createPeer!()).not.toBeNull();
    expect(handed).toEqual([[undefined, true]]);

    await service.push('session-1', 'Build finished');
    expect(requests.map((request) => request.url)).toContain(`${HOSTED_ORIGIN}${API_ROUTES.pushSend}`);
  });

  it('restarts the running Burrow on any change to its paths, and on nothing else', async () => {
    createHostedService({ enrollment: ENROLLMENT, network: LOCAL_ON });
    await service.start();
    expect(sockets).toHaveLength(1);

    // `autoUpdate` changes no path.
    await setPolicy({ ...LOCAL_ON, autoUpdate: true });
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.readyState).not.toBe(3);

    // The allowed networks under Local networks do: a runtime holds the ones it started on.
    await setPolicy({ ...LOCAL_ON, allowed: ['10.0.0.0/8'] });
    expect(sockets[0]!.readyState).toBe(3);
    expect(sockets).toHaveLength(2);
    expect(handedTransport.directPeering!.pathPolicy).toBeDefined();

    // So does the level, Anywhere gathering through STUN with no hold.
    await setPolicy(ANYWHERE_ON);
    expect(sockets[1]!.readyState).toBe(3);
    expect(sockets).toHaveLength(3);
    expect(handedTransport.directPeering!.pathPolicy).toBeUndefined();

    // Anywhere's allowed networks hold nothing, so they restart nothing.
    await setPolicy({ ...ANYWHERE_ON, allowed: ['10.0.0.0/8'] });
    expect(sockets).toHaveLength(3);
    expect((await command('status')).result).toMatchObject({ enrolled: true });
  });

  it('opens no one-time link under Local networks with no network allowed', async () => {
    createHostedService({ network: { ...LOCAL_ON, allowed: [] } });
    expect((await command('oneTimeStatus')).result).toEqual({ status: 'idle' });
    expect((await command('oneTimeOpen')).error).toContain('No network is allowed');
    expect(rendezvous.rooms).toEqual([]);
  });

  it('hands the running Burrow’s direct peers no ICE server and no hold under My Relay only', async () => {
    const handed: Handed[] = [];
    createService({ enrollment: ENROLLMENT, network: RELAY_ON }, { createDirectPeer: answererTo('192.168.1.3', handed) });
    await service.start();
    const { createPeer, pathPolicy } = handedTransport.directPeering!;
    expect(pathPolicy).toBeUndefined();
    expect(createPeer!()).not.toBeNull();
    expect(handed).toEqual([[undefined, false]]);
  });

  describe('setNetworkPolicy', () => {
    it('starts the enrolled Burrow out of Nothing, and stops it again, keeping the enrollment', async () => {
      createService({ enrollment: ENROLLMENT, network: NOTHING });
      await service.start();
      expect(sockets).toEqual([]);

      const { result } = await setPolicy(RELAY_ON);
      expect(result).toEqual({ policy: RELAY_ON, levels: ['nothing', 'relay'], interfaces: INTERFACES });
      expect(store.network).toEqual(RELAY_ON);
      expect(sockets).toHaveLength(1);
      expect(servingEvents().at(-1)).toBe(true);

      await setPolicy(NOTHING);
      expect(sockets[0]!.readyState).toBe(3);
      expect(sockets).toHaveLength(1);
      expect(servingEvents().at(-1)).toBe(false);
      expect(store.enrollment).toEqual(ENROLLMENT);
      expect((await command('status')).result).toMatchObject({ enrolled: true, connection: 'stopped' });
      expect(policyEvents().map((event) => event.policy)).toEqual([RELAY_ON, NOTHING]);
    });

    it('lets an enroll through once the level allows a Relay', async () => {
      createService({ network: NOTHING });
      await setPolicy(RELAY_ON);
      expect((await command('enroll', { password: 'setup', label: 'Laptop' })).error).toBeUndefined();
      expect(sockets).toHaveLength(1);
    });

    it('ends a live one-time link on a change of level or Local networks’ networks, never on autoUpdate alone', async () => {
      createHostedService();
      await service.start();
      expect((await command('oneTimeOpen')).result).toMatchObject({ status: 'waiting' });

      await setPolicy({ ...LOCAL_ON, autoUpdate: true });
      expect(oneTimeStates().at(-1)).toMatchObject({ status: 'waiting' });
      expect(rendezvous.room().burrow.closeCode).toBeNull();

      await setPolicy({ ...LOCAL_ON, allowed: ['10.0.0.0/8'] });
      expect(rendezvous.room().burrow.closeCode).toBe(1000);
      expect(oneTimeStates().slice(-2)).toEqual([{ status: 'ended', reason: 'user-ended' }, { status: 'idle' }]);

      await command('oneTimeOpen');
      await setPolicy(NOTHING);
      expect(rendezvous.rooms).toHaveLength(2);
      expect(rendezvous.room().burrow.closeCode).toBe(1000);
      expect(oneTimeStates().at(-1)).toEqual({ status: 'unavailable', reason: 'network-off' });
      expect(servingEvents().at(-1)).toBe(false);

      await setPolicy(LOCAL_ON);
      expect(oneTimeStates().at(-1)).toEqual({ status: 'idle' });
    });

    it('opens no one-time link for a click that lands while a change to Nothing saves', async () => {
      createHostedService();
      await service.start();
      let saved!: () => void;
      const saving = new Promise<void>((resolve) => {
        saved = resolve;
      });
      store.saveNetworkPolicy = (policy) => {
        store.network = policy;
        return saving;
      };
      const set = setPolicy(NOTHING);
      await flushUntil(() => (store.network?.level === 'nothing' ? true : undefined));

      // The save lands first, then the click reads the policy it resumed on.
      saved();
      const open = command('oneTimeOpen');
      await set;
      expect((await open).error).toContain('set to Nothing');
      expect(rendezvous.rooms).toEqual([]);
      expect(oneTimeStates().at(-1)).toEqual({ status: 'unavailable', reason: 'network-off' });
    });

    describe('a dispose() that lands during the first policy read', () => {
      /** Holds every policy read until the returned release runs. */
      function holdPolicyRead(): () => void {
        const read = Promise.withResolvers<void>();
        store.loadNetworkPolicy = async () => {
          await read.promise;
          return store.network;
        };
        return read.resolve;
      }

      it('opens no one-time link', async () => {
        createHostedService();
        const release = holdPolicyRead();
        const open = service.handleCommand({ burrowRequestId: 'open', cmd: 'oneTimeOpen' });
        service.dispose();
        release();
        await open;
        expect(rendezvous.rooms).toEqual([]);
      });

      it('tells managed voice the network is off', async () => {
        createHostedService();
        const release = holdPolicyRead();
        const allowed = service.networkAllowed();
        service.dispose();
        release();
        expect(await allowed).toBe(false);
      });

      it('sends no enrollment', async () => {
        createService();
        const release = holdPolicyRead();
        const enroll = service.handleCommand({
          burrowRequestId: 'enroll',
          cmd: 'enroll',
          params: { password: 'setup', label: 'Laptop' },
        });
        service.dispose();
        release();
        await enroll;
        expect(requests).toEqual([]);
        expect(sockets).toEqual([]);
      });
    });

    it('rejects anything but an exact policy this build offers, changing nothing', async () => {
      createService({ enrollment: ENROLLMENT });
      await service.start();
      const bad: unknown[] = [
        undefined,
        { ...RELAY_ON, level: 'local' },
        { ...RELAY_ON, level: 'anywhere' },
        { ...RELAY_ON, extra: true },
        { level: 'relay', allowed: [] },
        { ...RELAY_ON, autoUpdate: 'yes' },
        { ...RELAY_ON, allowed: ['example.com/24'] },
        { ...RELAY_ON, allowed: ['192.168.1.0/33'] },
        { ...RELAY_ON, allowed: ['fe80::1%en0/64'] },
        { ...RELAY_ON, allowed: [LAN, LAN] },
        // The same range twice, once as its canonical form spells it.
        { ...RELAY_ON, allowed: [LAN, '192.168.1.7/24'] },
        { ...RELAY_ON, allowed: Array.from({ length: 33 }, (_, i) => `10.${i}.0.0/16`) },
      ];
      for (const policy of bad) {
        expect((await setPolicy(policy)).error, JSON.stringify(policy)).toBeTruthy();
      }
      expect((await command('setNetworkPolicy')).error).toBeTruthy();
      expect(store.network).toEqual(RELAY_ON);
      expect(policyEvents()).toEqual([]);
      expect(sockets).toHaveLength(1);

      // The bound itself is allowed, in either family.
      const allowed = [...Array.from({ length: 31 }, (_, i) => `10.${i}.0.0/16`), '2001:db8::/32'];
      expect((await setPolicy({ ...RELAY_ON, allowed })).error).toBeUndefined();
    });

    it('saves each allowed network in its canonical form, and answers that', async () => {
      createHostedService();
      await service.start();
      const typed = { ...LOCAL_ON, allowed: ['192.168.1.7/24', '2001:DB8:0:0::1/32', '10.8.0.0/24'] };
      const canonical = { ...LOCAL_ON, allowed: [LAN, '2001:db8::/32', '10.8.0.0/24'] };

      const { result, error } = await setPolicy(typed);
      expect(error).toBeUndefined();
      expect((result as { policy: NetworkPolicy }).policy).toEqual(canonical);
      expect(store.network).toEqual(canonical);
      expect(policyEvents().at(-1)!.policy).toEqual(canonical);
    });

    it('announces a saved policy even when the Burrow it allows cannot start', async () => {
      createService({ enrollment: ENROLLMENT, network: NOTHING });
      await service.start();
      store.loadAcl = async () => {
        throw new Error('EIO');
      };

      expect((await setPolicy(RELAY_ON)).error).toBe('EIO');
      expect(store.network).toEqual(RELAY_ON);
      expect(policyEvents().map((event) => event.policy)).toEqual([RELAY_ON]);
    });

    it('changes nothing when the save fails', async () => {
      createService({ enrollment: ENROLLMENT });
      await service.start();
      store.saveNetworkPolicy = async () => {
        throw new Error('disk full');
      };

      expect((await setPolicy(NOTHING)).error).toBe('disk full');
      expect(sockets[0]!.readyState).not.toBe(3);
      expect(((await command('networkPolicy')).result as { policy: NetworkPolicy }).policy).toEqual(RELAY_ON);
      expect(policyEvents()).toEqual([]);
    });
  });
});

describe('Hosted enrollment', () => {
  const USER_CODE = '23AB-YZ9K';
  const DEVICE_CODE = 'D'.repeat(RELAY_BEARER_LENGTH);
  const INTERVAL_S = 5;
  const TTL_MS = 10 * 60_000;

  type PollAnswer = { status: number; body: unknown };
  /** What the fake Hosted Relay's begin answers, and its queue of poll answers. */
  let begin: Record<string, unknown>;
  /** A promise is a poll held on the wire until the test settles it. */
  let polls: Array<PollAnswer | Error | Response | Promise<PollAnswer>>;

  const reply = (status: number, body: unknown) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as Response;

  /** `relay.dormouse.sh` serving begin and poll; an empty poll queue is `pending`. */
  function hostedFetch(): typeof globalThis.fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith(API_ROUTES.burrowEnrollBegin)) return reply(200, begin);
      if (url.endsWith(API_ROUTES.burrowEnrollPoll)) {
        const next = await (polls.shift() ?? { status: 200, body: { status: 'pending' } });
        if (next instanceof Error) throw next;
        if (next instanceof Response) return next;
        return reply(next.status, next.body);
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof globalThis.fetch;
  }

  const enrolledAnswer = (burrowId = BURROW_ID) => ({
    status: 200,
    body: {
      status: 'enrolled',
      enrollment: {
        burrowId,
        burrowToken: 'hosted-token',
        origin: HOSTED_ORIGIN,
        rpId: new URL(HOSTED_ORIGIN).hostname,
      },
    },
  });

  function hosted(seed?: Seed, over: Partial<BurrowServiceOptions> = {}): BurrowService {
    return createHostedService(seed, { fetch: hostedFetch(), ...over });
  }

  const pollRequests = () => requests.filter((request) => request.url.endsWith(API_ROUTES.burrowEnrollPoll));
  const beginRequests = () => requests.filter((request) => request.url.endsWith(API_ROUTES.burrowEnrollBegin));

  /** Queue a poll the fake Relay holds on the wire until the test answers it. */
  function heldPoll(): (answer: PollAnswer) => void {
    let settle: (answer: PollAnswer) => void = () => {};
    polls.push(new Promise<PollAnswer>((resolve) => (settle = resolve)));
    return settle;
  }

  /** The sentence a redemption this machine could not keep ends with. */
  const stranded = (burrowId: string) =>
    `Your account holds Burrow ${burrowId}, which this computer could not keep; remove it at https://hosted.dormouse.sh/account.`;

  async function hostedEnrollment(): Promise<unknown> {
    return ((await command('status')).result as BurrowConsoleStatus).hostedEnrollment;
  }

  /** Let the work a fired timer started finish: fetches, WebCrypto, the store. */
  async function drain(until: () => boolean): Promise<void> {
    for (let turn = 0; turn < 500 && !until(); turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** Fire the next poll and wait for it to have asked. */
  async function nextPoll(): Promise<void> {
    const asked = pollRequests().length;
    await vi.advanceTimersByTimeAsync(INTERVAL_S * 1000);
    await drain(() => pollRequests().length > asked);
    // And for what the answer started.
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    begin = {
      deviceCode: DEVICE_CODE,
      userCode: USER_CODE,
      // Followed in no release build: the account page is the Burrow's to compose.
      verificationUrl: `https://hosted.example/enroll#${USER_CODE}`,
      expiresAt: Date.now() + TTL_MS,
      interval: INTERVAL_S,
    };
    polls = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('begins at the baked origin and shows a code it composed the account page for, never the device code', async () => {
    hosted();
    const { result, error } = await command('beginHostedEnrollment', { label: 'Work laptop' });

    expect(error).toBeUndefined();
    const waiting = {
      status: 'waiting',
      userCode: USER_CODE,
      verificationUrl: `https://hosted.dormouse.sh/enroll#${USER_CODE}`,
      expiresAt: Date.now() + TTL_MS,
      accountFull: false,
    };
    expect(result).toEqual(waiting);
    expect(requests.map((request) => request.url)).toEqual([`${HOSTED_ORIGIN}${API_ROUTES.burrowEnrollBegin}`]);
    expect(requestBody(0)).toEqual({ origin: HOSTED_ORIGIN });
    expect(await hostedEnrollment()).toEqual(waiting);
    expect(statusEvents()).toEqual([false]);
    // The device code is a bearer, held like `burrowToken`.
    expect(JSON.stringify(sent)).not.toContain(DEVICE_CODE);
  });

  it('polls every interval and starts the enrollment it redeems, under Local networks', async () => {
    hosted();
    await service.start();
    await command('beginHostedEnrollment', { label: 'Work laptop' });

    await nextPoll();
    expect(pollRequests()).toHaveLength(1);
    expect(JSON.parse(pollRequests()[0]!.init!.body as string)).toEqual({ deviceCode: DEVICE_CODE });
    expect(pollRequests()[0]!.init!.redirect).toBe('error');

    polls.push(enrolledAnswer());
    await nextPoll();
    await drain(() => store.enrollment !== null);

    expect(store.enrollment).toMatchObject({
      relayUrl: HOSTED_ORIGIN,
      burrowId: BURROW_ID,
      burrowToken: 'hosted-token',
      origin: HOSTED_ORIGIN,
      label: 'Work laptop',
    });
    expect(store.enrollment?.noiseStaticPublicKey).toEqual(expect.any(String));
    expect((await command('status')).result).toMatchObject({
      enrolled: true,
      connection: 'connecting',
      hostedEnrollment: null,
    });
    expect(statusEvents().at(-1)).toBe(true);
    // Local networks runs the persistent Burrow on the enrollment's own Relay,
    // and polling is over.
    expect(sockets).toHaveLength(1);
    expect(socketUrls[0]).toMatch(/^wss:\/\/relay\.dormouse\.sh\/ws\/burrow\?/);
    await vi.advanceTimersByTimeAsync(INTERVAL_S * 3000);
    expect(pollRequests()).toHaveLength(2);
  });

  it('is refused in a self-host build, and under Nothing, before any request', async () => {
    createService({ network: RELAY_ON }, { fetch: hostedFetch() });
    expect((await command('beginHostedEnrollment', { label: 'x' })).error).toContain('setup password');

    hosted({ network: NOTHING });
    expect((await command('beginHostedEnrollment', { label: 'x' })).error).toContain('set to Nothing');
    expect(requests).toEqual([]);
  });

  it('says which host it could not reach and why, never undici’s bare `fetch failed`', async () => {
    const unresolved = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND relay.dormouse.sh'), { code: 'ENOTFOUND' }),
    });
    hosted(undefined, { fetch: () => Promise.reject(unresolved) });
    expect((await command('beginHostedEnrollment', { label: 'x' })).error).toBe(
      'Couldn’t reach relay.dormouse.sh: the name doesn’t resolve.',
    );
  });

  it('refuses a begin answer that is not an enrollment code, waiting on nothing', async () => {
    begin = { ...begin, interval: 0 };
    hosted();

    expect((await command('beginHostedEnrollment', { label: 'x' })).error).toContain('not an enrollment code');
    expect(await hostedEnrollment()).toBeNull();
  });

  it('ends on an account not entitled, and polls on through a full one, which the Relay keeps', async () => {
    hosted();
    await command('beginHostedEnrollment', { label: 'x' });
    polls.push({ status: 409, body: { error: 'this account already has 32 computers enrolled' } });
    await nextPoll();
    expect(await hostedEnrollment()).toMatchObject({ status: 'waiting', accountFull: true });

    // A computer removed at the account, and the kept approval redeems.
    polls.push(enrolledAnswer());
    await nextPoll();
    await drain(() => store.enrollment !== null);
    expect(store.enrollment?.burrowId).toBe(BURROW_ID);

    service.dispose();
    hosted();
    await command('beginHostedEnrollment', { label: 'x' });
    polls.push({ status: 403, body: { error: NOT_ENTITLED_ERROR } });
    await nextPoll();
    expect(await hostedEnrollment()).toEqual({ status: 'ended', reason: 'not-entitled' });
    const asked = pollRequests().length;
    await vi.advanceTimersByTimeAsync(INTERVAL_S * 3000);
    expect(pollRequests()).toHaveLength(asked);
  });

  it('keeps polling through an unreachable Relay and a 5xx, and slows down on a 429', async () => {
    hosted();
    await command('beginHostedEnrollment', { label: 'x' });
    polls.push(new Error('offline'), { status: 503, body: {} }, { status: 429, body: {} });
    await nextPoll();
    await nextPoll();
    await nextPoll();
    expect(pollRequests()).toHaveLength(3);
    expect(await hostedEnrollment()).toMatchObject({ status: 'waiting' });

    // The interval grew by five seconds.
    await vi.advanceTimersByTimeAsync(INTERVAL_S * 1000);
    await drain(() => false);
    expect(pollRequests()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5_000);
    await drain(() => pollRequests().length > 3);
    expect(pollRequests()).toHaveLength(4);
  });

  it('ends at the Relay’s expired, and at its own deadline', async () => {
    hosted();
    await command('beginHostedEnrollment', { label: 'x' });
    polls.push({ status: 200, body: { status: 'expired' } });
    await nextPoll();
    expect(await hostedEnrollment()).toEqual({ status: 'ended', reason: 'expired' });

    // A Relay whose code would outlive the bound is held to it by this clock.
    begin = { ...begin, expiresAt: Date.now() + 24 * 60 * 60_000 };
    const { result } = await command('beginHostedEnrollment', { label: 'x' });
    expect((result as { expiresAt: number }).expiresAt).toBe(Date.now() + 15 * 60_000);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await drain(() => false);
    expect(await hostedEnrollment()).toEqual({ status: 'ended', reason: 'expired' });
    const asked = pollRequests().length;
    await vi.advanceTimersByTimeAsync(INTERVAL_S * 3000);
    expect(pollRequests()).toHaveLength(asked);
  });

  it('stops polling on cancel, on Nothing, and on dispose', async () => {
    hosted();
    await command('beginHostedEnrollment', { label: 'x' });
    expect((await command('cancelHostedEnrollment')).result).toEqual({});
    expect(await hostedEnrollment()).toBeNull();
    await vi.advanceTimersByTimeAsync(INTERVAL_S * 3000);
    expect(pollRequests()).toEqual([]);

    await command('beginHostedEnrollment', { label: 'x' });
    await setPolicy(NOTHING);
    expect(await hostedEnrollment()).toBeNull();
    await vi.advanceTimersByTimeAsync(INTERVAL_S * 3000);
    expect(pollRequests()).toEqual([]);

    await setPolicy(LOCAL_ON);
    await command('beginHostedEnrollment', { label: 'x' });
    expect(vi.getTimerCount()).toBe(1);
    service.dispose();
    // No timer left to ask, even of a transport that would refuse it.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL_S * 3000);
    expect(pollRequests()).toEqual([]);
  });

  it.each(['cancel', 'Nothing'] as const)('starts a fresh begin after %s while the old request is pending', async (stop) => {
    const settle: Array<(response: Response) => void> = [];
    const arrivals = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    hosted(undefined, {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        if (settle.length >= arrivals.length) throw new Error('a joined begin asked for a third code');
        return new Promise<Response>((resolve) => {
          settle.push(resolve);
          arrivals[settle.length - 1]!.resolve();
        });
      }) as typeof globalThis.fetch,
    });
    const old = command('beginHostedEnrollment', { label: 'old' });
    // WebCrypto runs on real worker threads: event-loop spins do not bound
    // how long it takes to mint the Noise static before fetch is reached.
    await arrivals[0]!.promise;
    if (stop === 'cancel') await command('cancelHostedEnrollment');
    else {
      await setPolicy(NOTHING);
      await setPolicy(LOCAL_ON);
    }
    const fresh = command('beginHostedEnrollment', { label: 'fresh' });
    await arrivals[1]!.promise;
    expect(settle).toHaveLength(2);

    // The old finally must not clear the replacement begin's promise.
    settle[0]!(reply(200, begin));
    expect((await old).error).toContain('cancelled');
    const joined = command('beginHostedEnrollment', { label: 'joined' });
    // Both commands await the cached policy. This later read resumes after
    // joined has passed that await and observed the still-pending begin.
    await command('networkPolicy');
    expect(settle).toHaveLength(2);
    settle[1]!(reply(200, { ...begin, userCode: '9999-ZZZZ' }));
    expect((await fresh).result).toMatchObject({ status: 'waiting', userCode: '9999-ZZZZ' });
    expect((await joined).result).toEqual((await fresh).result);
    expect(beginRequests()).toHaveLength(2);
  });

  it('holds an enrollment a poll in flight redeems after a cancel: the Relay already spent it', async () => {
    hosted();
    await command('beginHostedEnrollment', { label: 'Work laptop' });
    const answer = heldPoll();
    await nextPoll();
    await command('cancelHostedEnrollment');
    expect(await hostedEnrollment()).toBeNull();
    answer(enrolledAnswer());
    await drain(() => store.enrollment !== null);

    expect(store.enrollment).toMatchObject({ burrowId: BURROW_ID, label: 'Work laptop' });
    expect((await command('status')).result).toMatchObject({ enrolled: true, hostedEnrollment: null });
    // And polls nothing more.
    await vi.advanceTimersByTimeAsync(INTERVAL_S * 3000);
    expect(pollRequests()).toHaveLength(1);
  });

  it('holds one a cancelled code’s poll redeems, and drops the code begun after it', async () => {
    hosted();
    await command('beginHostedEnrollment', { label: 'x' });
    const answer = heldPoll();
    await nextPoll();
    await command('cancelHostedEnrollment');
    begin = { ...begin, deviceCode: 'E'.repeat(RELAY_BEARER_LENGTH), userCode: '9999-ZZZZ' };
    await command('beginHostedEnrollment', { label: 'x' });
    expect(await hostedEnrollment()).toMatchObject({ status: 'waiting', userCode: '9999-ZZZZ' });
    answer(enrolledAnswer());
    await drain(() => store.enrollment !== null);
    await drain(() => vi.getTimerCount() === 0);

    expect(store.enrollment?.burrowId).toBe(BURROW_ID);
    expect(await hostedEnrollment()).toBeNull();
    await vi.advanceTimersByTimeAsync(INTERVAL_S * 3000);
    expect(pollRequests()).toHaveLength(1);
  });

  it('names the Burrow left at the account when a late redemption finds this machine enrolled', async () => {
    const OTHER = 'T7lzkkrPT8nx4m9zf90V4h';
    hosted();
    await command('beginHostedEnrollment', { label: 'x' });
    const late = heldPoll();
    await nextPoll();
    await command('cancelHostedEnrollment');
    begin = { ...begin, deviceCode: 'E'.repeat(RELAY_BEARER_LENGTH), userCode: '9999-ZZZZ' };
    await command('beginHostedEnrollment', { label: 'x' });
    polls.push(enrolledAnswer());
    await nextPoll();
    await drain(() => store.enrollment !== null);

    late(enrolledAnswer(OTHER));
    await drain(() => false);
    expect(store.enrollment?.burrowId).toBe(BURROW_ID);
    expect((await command('status')).result).toMatchObject({
      enrolled: true,
      hostedEnrollment: {
        status: 'ended',
        reason: 'failed',
        message: expect.stringContaining(stranded(OTHER)),
      },
    });
  });

  it('warns, holding nothing, when a redemption lands after disposal', async () => {
    hosted();
    await command('beginHostedEnrollment', { label: 'x' });
    const answer = heldPoll();
    await nextPoll();
    service.dispose();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer(enrolledAnswer());
    await drain(() => warn.mock.calls.length > 0);

    expect(store.enrollment).toBeNull();
    expect(String(warn.mock.calls[0]![0])).toContain(stranded(BURROW_ID));
    warn.mockRestore();
  });

  it('reports redeeming until the redeemed enrollment is saved and started', async () => {
    hosted();
    await command('beginHostedEnrollment', { label: 'x' });
    const save = store.saveEnrollment.bind(store);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    store.saveEnrollment = async (enrollment) => {
      await held;
      return save(enrollment);
    };
    polls.push(enrolledAnswer());
    await nextPoll();

    // Never a status with neither a code nor an enrollment.
    expect((await command('status')).result).toMatchObject({
      enrolled: false,
      hostedEnrollment: { status: 'redeeming' },
    });
    // Nor does a Cancel or a begin void it.
    await command('cancelHostedEnrollment');
    expect((await command('beginHostedEnrollment', { label: 'x' })).result).toEqual({
      status: 'redeeming',
    });
    expect(beginRequests()).toHaveLength(1);
    release();
    await drain(() => store.enrollment !== null);
    await drain(() => false);
    expect((await command('status')).result).toMatchObject({ enrolled: true, hostedEnrollment: null });
  });

  it('names the account origin in status: the fixed one in a release build, the begin’s in a dev one', async () => {
    hosted();
    expect((await command('status')).result).toMatchObject({ accountOrigin: 'https://hosted.dormouse.sh' });
    service.dispose();

    hosted(undefined, { relay: { origin: 'http://localhost:8787', mode: 'hosted' } });
    expect((await command('status')).result).toMatchObject({ accountOrigin: null });
    await command('beginHostedEnrollment', { label: 'x' });
    // The origin the panel's waiting view opens, so Manage computers matches it.
    expect((await command('status')).result).toMatchObject({
      accountOrigin: 'https://hosted.example',
      hostedEnrollment: { verificationUrl: `https://hosted.example/enroll#${USER_CODE}` },
    });
  });

  it('is refused on an enrolled machine, before any request', async () => {
    hosted({ enrollment: ENROLLMENT });
    await service.start();
    expect((await command('beginHostedEnrollment', { label: 'x' })).error).toContain(
      `already enrolled as Burrow ${BURROW_ID}`,
    );
    expect(requests).toEqual([]);
  });

  it('ends answer-lost when the Relay says an earlier poll redeemed the code', async () => {
    hosted();
    await command('beginHostedEnrollment', { label: 'x' });
    const lost = 'A'.repeat(22);
    polls.push({ status: 200, body: { status: 'redeemed', burrowId: lost } });
    await nextPoll();

    // Naming the Burrow the account must remove.
    expect(await hostedEnrollment()).toEqual({ status: 'ended', reason: 'answer-lost', burrowId: lost });
    expect(store.enrollment).toBeNull();
    await vi.advanceTimersByTimeAsync(INTERVAL_S * 3000);
    expect(pollRequests()).toHaveLength(1);
  });

  it('polls again when a 200’s body is lost mid-read, and hears the redemption it spent', async () => {
    hosted();
    await command('beginHostedEnrollment', { label: 'x' });
    // Headers arrive; the body stream breaks before the enrollment does.
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":"enrolled","enrol'));
        controller.error(new TypeError('connection reset'));
      },
    });
    polls.push(new Response(broken, { status: 200, headers: { 'content-type': 'application/json' } }));
    await nextPoll();
    expect(await hostedEnrollment()).toMatchObject({ status: 'waiting' });

    const lost = 'A'.repeat(22);
    polls.push({ status: 200, body: { status: 'redeemed', burrowId: lost } });
    await nextPoll();
    expect(await hostedEnrollment()).toEqual({ status: 'ended', reason: 'answer-lost', burrowId: lost });
    expect(pollRequests()).toHaveLength(2);
  });

  it('ends failed on a complete 200 body that is not JSON', async () => {
    hosted();
    await command('beginHostedEnrollment', { label: 'x' });
    polls.push(new Response('<html>', { status: 200 }));
    await nextPoll();
    expect(await hostedEnrollment()).toMatchObject({ status: 'ended', reason: 'failed' });
  });

  it('refuses a redemption for another origin, saving nothing, and says so', async () => {
    hosted();
    await command('beginHostedEnrollment', { label: 'x' });
    const answer = enrolledAnswer();
    (answer.body.enrollment as { origin: string }).origin = 'https://relay.example.com';
    polls.push(answer);
    await nextPoll();
    await drain(() => store.enrollment !== null);

    expect(store.enrollment).toBeNull();
    expect(await hostedEnrollment()).toEqual({
      status: 'ended',
      reason: 'failed',
      message: expect.stringContaining('The Relay says its origin is https://relay.example.com'),
    });
    expect(((await hostedEnrollment()) as { message: string }).message).toContain(stranded(BURROW_ID));
  });

  it('ends failed when the redeemed enrollment cannot be saved', async () => {
    hosted();
    await command('beginHostedEnrollment', { label: 'x' });
    store.saveEnrollment = async () => {
      throw new Error('keychain is locked');
    };
    polls.push(enrolledAnswer());
    await nextPoll();

    // A fixed sentence naming the Burrow the Relay recorded, and where to remove it.
    expect(await hostedEnrollment()).toEqual({
      status: 'ended',
      reason: 'failed',
      message: `keychain is locked ${stranded(BURROW_ID)}`,
    });
    expect((await command('status')).result).toMatchObject({ enrolled: false });
  });

  it('retains a saved redemption when startup fails, with recovery guidance rather than removal advice', async () => {
    hosted();
    await command('beginHostedEnrollment', { label: 'x' });
    store.loadAcl = async () => {
      throw new Error('ACL store is unavailable');
    };
    polls.push(enrolledAnswer());
    await nextPoll();

    expect(store.enrollment).toMatchObject({ burrowId: BURROW_ID });
    expect((await command('status')).result).toMatchObject({ enrolled: true });
    expect(await hostedEnrollment()).toEqual({
      status: 'ended',
      reason: 'failed',
      message: 'ACL store is unavailable This computer saved its enrollment; restart Dormouse to try connecting again.',
    });
    expect((await command('beginHostedEnrollment', { label: 'again' })).error).toContain('already enrolled');
    // An explicit reconnect can also use the retained credential once storage recovers.
    store.loadAcl = async () => [];
    expect((await command('reconnect')).error).toBeUndefined();
    expect(sockets).toHaveLength(1);
  });

  it('answers the code already waiting to a second begin', async () => {
    // Another VS Code window's Enroll lands on this service: voiding the code
    // the first window shows would leave it approving nothing.
    hosted();
    const first = (await command('beginHostedEnrollment', { label: 'x' })).result;
    begin = { ...begin, deviceCode: 'E'.repeat(RELAY_BEARER_LENGTH), userCode: '9999-ZZZZ' };
    expect((await command('beginHostedEnrollment', { label: 'y' })).result).toEqual(first);
    expect(beginRequests()).toHaveLength(1);
  });

  it('joins a begin already in flight rather than asking twice', async () => {
    hosted();
    const both = [1, 2].map((n) =>
      service.handleCommand({ burrowRequestId: `join-${n}`, cmd: 'beginHostedEnrollment', params: { label: 'x' } }),
    );
    await Promise.all(both);
    const answers = sent
      .filter((message) => message.event === 'burrow:result')
      .filter((message) => String(message.data.burrowRequestId).startsWith('join-'));
    expect(answers.map((message) => message.data.result)).toEqual([
      expect.objectContaining({ userCode: USER_CODE }),
      expect.objectContaining({ userCode: USER_CODE }),
    ]);
    expect(beginRequests()).toHaveLength(1);
  });

  it('keeps one that ended until a new begin has a code, then replaces it, saying so', async () => {
    hosted();
    await command('beginHostedEnrollment', { label: 'x' });
    polls.push({ status: 200, body: { status: 'expired' } });
    await nextPoll();
    expect(await hostedEnrollment()).toEqual({ status: 'ended', reason: 'expired' });

    // "Get a new code" is a begin: one that fails keeps the ending on screen.
    const events = statusEvents().length;
    const good = begin;
    begin = { ...begin, interval: 0 };
    expect((await command('beginHostedEnrollment', { label: 'x' })).error).toContain('not an enrollment code');
    expect(await hostedEnrollment()).toEqual({ status: 'ended', reason: 'expired' });
    expect(statusEvents()).toHaveLength(events);

    begin = { ...good, deviceCode: 'E'.repeat(RELAY_BEARER_LENGTH), userCode: '9999-ZZZZ' };
    await command('beginHostedEnrollment', { label: 'x' });
    expect(statusEvents()).toHaveLength(events + 1);
    await nextPoll();
    expect(JSON.parse(pollRequests().at(-1)!.init!.body as string)).toEqual({
      deviceCode: 'E'.repeat(RELAY_BEARER_LENGTH),
    });
    expect(await hostedEnrollment()).toMatchObject({ status: 'waiting', userCode: '9999-ZZZZ' });
  });
});

describe('enrollVerificationUrl', () => {
  const code = '23AB-YZ9K';
  const release = { origin: HOSTED_ORIGIN, mode: 'hosted' } as const;
  const dev = { origin: 'http://localhost:8787', mode: 'hosted' } as const;

  it('composes the account page in a release build, whatever the Relay names', () => {
    for (const verificationUrl of [undefined, `https://hosted.example/enroll#${code}`, 'javascript:alert(1)']) {
      expect(enrollVerificationUrl(release, { userCode: code, verificationUrl })).toBe(
        `https://hosted.dormouse.sh/enroll#${code}`,
      );
    }
  });

  it('follows the Relay’s account origin in a dev build, held to the link’s checks', () => {
    expect(enrollVerificationUrl(dev, { userCode: code, verificationUrl: `http://localhost:5173/enroll#${code}` }))
      .toBe(`http://localhost:5173/enroll#${code}`);
    expect(enrollVerificationUrl(dev, { userCode: code, verificationUrl: `https://hosted-pr-7.example.dev/enroll#${code}` }))
      .toBe(`https://hosted-pr-7.example.dev/enroll#${code}`);
    for (const verificationUrl of [
      undefined,
      `http://192.168.1.4:5173/enroll#${code}`,
      `https://hosted.example/account#${code}`,
      `https://hosted.example/enroll?x=1#${code}`,
      `https://user@hosted.example/enroll#${code}`,
      `https://hosted.example/enroll#9999-ZZZZ`,
      `https://hosted.example/enroll#${code}x`,
      `javascript:alert(1)//enroll#${code}`,
    ]) {
      expect(() => enrollVerificationUrl(dev, { userCode: code, verificationUrl }), String(verificationUrl)).toThrow(
        /named no account page/,
      );
    }
  });

  it('composes none in a self-host build', () => {
    expect(() => enrollVerificationUrl({ origin: ORIGIN, mode: 'self-host' }, { userCode: code })).toThrow(
      /setup password/,
    );
  });
});
