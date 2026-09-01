/**
 * The Node-resident Host, driven the way both of its neighbours drive it: the
 * webview through `handleCommand`, and the relay through a fake `/ws/host`
 * socket. The point of most cases here is that nothing a webview says can widen
 * access — recipients, the ACL, and the allowlist are all read on this side.
 */

import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_ROUTES,
  type EnrollmentOffer,
  type HostAclRecord,
  type PairingRequest,
} from 'server-lib-common';
import type { HostEnrollment } from '../../remote/host/enrollment';
import type { HostSurfaceProvider } from '../../remote/host/host-surface-provider';
import { FakeSocket } from '../../remote/test-fake-socket';
import { createEphemeralHostStateStore, type HostStateStore } from './host-state-store';
import { RemoteHostService } from './service';
import type {
  HostStatusEvent,
  PairingQueueEvent,
  RemoteHostConsoleStatus,
  SetupQrResult,
  SetupTokenRedeemedEvent,
} from './service-protocol';

const CONNECT_SRC = 'https://*.dormouse.sh wss://*.dormouse.sh';

const ENROLLMENT: HostEnrollment = {
  serverUrl: 'https://relay.dormouse.sh',
  hostId: 'host-1',
  hostToken: 'tok',
  origin: 'https://relay.dormouse.sh',
  rpId: 'relay.dormouse.sh',
};

const PAIRING: PairingRequest = {
  accountId: 'owner',
  passkeyCredentialId: 'cred-1',
  passkeyPublicKeyHash: 'hash-1',
  devicePublicKey: 'device-1',
  requestedLabel: 'iPhone Safari',
};

function aclRecord(devicePublicKey: string, label = 'iPhone Safari'): HostAclRecord {
  return {
    hostId: 'host-1',
    accountId: 'owner',
    passkeyCredentialId: 'cred',
    passkeyPublicKeyHash: 'hash',
    devicePublicKey,
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
                token: `setup-token-${++setupTokensMinted}`,
                expiresAt: Date.now() + setupTokenTtlMs,
              },
      } as Response;
    }
    if (url.endsWith('/api/host/enroll')) {
      return {
        ok: true,
        json: async () => ({
          hostId: 'host-1',
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
            { devicePublicKey: 'device-1', subscribedAt: 1 },
            { devicePublicKey: 'device-revoked', subscribedAt: 1 },
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

function uiEvents(): Array<PairingQueueEvent | HostStatusEvent | SetupTokenRedeemedEvent> {
  return sent
    .filter((message) => message.event === 'remoteHost:event')
    .map(
      (message) =>
        message.data as unknown as PairingQueueEvent | HostStatusEvent | SetupTokenRedeemedEvent,
    );
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
    // shape (SECURITY.md), so it must not appear anywhere in what was sent.
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
    createService({ enrollment: ENROLLMENT, acl: { 'host-1': [aclRecord('device-1')] } });
    await service.start();
    sockets[0]!.open();

    expect((await command('status')).result).toEqual({
      enrolled: true,
      serverUrl: ENROLLMENT.serverUrl,
      hostId: 'host-1',
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

    expect(result.result).toEqual({ hostId: 'host-1', serverUrl: 'https://relay.dormouse.sh' });
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

    expect(result.result).toEqual({ hostId: 'host-1', serverUrl: OFFER.origin });
    expect(requests).toHaveLength(1);
    expect(requestBody(0)).toEqual({ enrollToken: OFFER.token, label: 'Laptop' });
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

  it('builds one Host when a start and an adopt race', async () => {
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
    const adopted = service.handleCommand({ rhId: 'race', cmd: 'adopt', params: { enrollment: ENROLLMENT, aclRecords: [] } });
    release();
    await Promise.all([started, adopted]);

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
    createService({ enrollment: ENROLLMENT, acl: { 'host-1': [aclRecord('device-1')] } });
    await service.start();

    await command('clearEnrollment');
    expect(store.enrollment).toBeNull();
    // The records stay filed under their hostId: re-enrolling onto the same
    // host must not silently de-pair every device.
    expect(store.acl['host-1']).toHaveLength(1);
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

describe('adopt', () => {
  it('takes a webview-persisted Host when there is none, and starts it', async () => {
    createService();
    const result = await command('adopt', {
      enrollment: ENROLLMENT,
      aclRecords: [aclRecord('device-1')],
    });

    // `persisted` is what tells the webview it may drop its own copy.
    expect(result.result).toEqual({ persisted: true });
    expect(store.enrollment).toEqual(ENROLLMENT);
    expect(store.acl['host-1']).toHaveLength(1);
    expect(sockets).toHaveLength(1);
  });

  it('keeps the Host it already has', async () => {
    createService({ enrollment: ENROLLMENT });
    await service.start();

    const other = { ...ENROLLMENT, hostId: 'host-2', hostToken: 'other' };
    const result = await command('adopt', { enrollment: other, aclRecords: [] });

    expect(store.enrollment).toEqual(ENROLLMENT);
    expect(sockets).toHaveLength(1);
    // The webview's copy is obsolete regardless: a second copy of one hostId is
    // a second ACL, and this store is holding a Host that survives a restart.
    expect(result.result).toEqual({ persisted: true });
  });

  it('refuses an origin outside the build’s allowed sources', async () => {
    // A Host handed over from an older build's localStorage may name a relay
    // this build may not reach; adopting it would connect there anyway.
    createService();
    const result = await command('adopt', {
      enrollment: { ...ENROLLMENT, serverUrl: 'https://relay.example.com' },
      aclRecords: [],
    });

    expect(result.error).toContain(CONNECT_SRC);
    expect(store.enrollment).toBeNull();
    expect(sockets).toEqual([]);
  });

  it('persists no enrollment when the ACL write fails', async () => {
    // Order matters: the records go first, so a failure here leaves the store
    // with no enrollment and the next launch re-adopts from the webview's copy
    // rather than running a Host whose devices were silently dropped.
    createService();
    store.saveAcl = async () => {
      throw new Error('globalState is full');
    };

    const result = await command('adopt', {
      enrollment: ENROLLMENT,
      aclRecords: [aclRecord('device-1')],
    });

    expect(result.error).toContain('globalState is full');
    expect(store.enrollment).toBeNull();
    expect(sockets).toEqual([]);
  });

  it('runs a session Host from an in-memory store, and says it did not persist', async () => {
    // The dev harness with no state directory: the Host has to work for the
    // session, but the webview's copy is the only one that outlives it.
    const warnings: string[] = [];
    const ephemeral = createEphemeralHostStateStore((message) => warnings.push(message));
    service = new RemoteHostService({
      store: ephemeral,
      provider: fakeProvider(),
      sendToUi: (event, data) => sent.push({ event, data: data as Record<string, unknown> }),
      connectSrc: CONNECT_SRC,
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: fakeFetch(),
    });

    const result = await command('adopt', {
      enrollment: ENROLLMENT,
      aclRecords: [aclRecord('device-1')],
    });

    expect(result.result).toEqual({ persisted: false });
    expect(sockets).toHaveLength(1);
    expect(await ephemeral.loadAcl('host-1')).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  it('drops records that name another host', async () => {
    createService();
    await command('adopt', {
      enrollment: ENROLLMENT,
      aclRecords: [{ ...aclRecord('device-1'), hostId: 'somebody-else' }],
    });
    expect(store.acl['host-1']).toBeUndefined();
  });

  it('ignores an enrollment that does not have the shape', async () => {
    createService();
    await command('adopt', { enrollment: { hostId: 'x' }, aclRecords: [] });
    expect(store.enrollment).toBeNull();
    expect(sockets).toEqual([]);
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

  it('announces the Host an enroll and an adopt each started', async () => {
    createService();
    await command('enroll', {
      serverUrl: 'https://relay.dormouse.sh',
      password: 'setup',
      label: 'Laptop',
    });
    expect(statusEvents()).toEqual([true]);

    createService();
    sent.length = 0;
    await command('adopt', { enrollment: ENROLLMENT, aclRecords: [] });
    expect(statusEvents()).toEqual([true]);
  });
});

describe('pairing queue', () => {
  async function running(): Promise<FakeSocket> {
    createService({ enrollment: ENROLLMENT });
    await service.start();
    const socket = sockets[0]!;
    socket.open();
    return socket;
  }

  it('pushes a snapshot when a pairing arrives, and answers a seed request', async () => {
    const socket = await running();
    socket.receive({ t: 'pair', clientId: 'c1', request: PAIRING });

    const event = queueEvents().at(-1)!;
    expect(event.name).toBe('pairing-queue');
    expect(event.queue).toHaveLength(1);
    expect(event.queue[0]).toMatchObject({ clientId: 'c1', request: PAIRING });
    expect(typeof event.queue[0]!.pairingId).toBe('string');
    expect(typeof event.queue[0]!.requestedAt).toBe('number');

    // A webview that reloaded mid-pairing seeds from the same snapshot.
    expect((await command('pairingQueue')).result).toEqual(event.queue);
  });

  it('approve runs the real ceremony, persists, and empties the queue', async () => {
    const socket = await running();
    socket.receive({ t: 'pair', clientId: 'c1', request: PAIRING });
    const pairingId = queueEvents().at(-1)!.queue[0]!.pairingId;

    await command('approve', { clientId: 'c1', pairingId, label: 'Ned iPhone' });

    const result = socket.frames('pair-result')[0]!;
    expect(result).toMatchObject({ clientId: 'c1', approved: true });
    expect((result.record as HostAclRecord).label).toBe('Ned iPhone');
    expect(store.acl['host-1']).toHaveLength(1);
    expect(queueEvents().at(-1)!.queue).toEqual([]);
  });

  it('deny answers the client and writes no ACL', async () => {
    const socket = await running();
    socket.receive({ t: 'pair', clientId: 'c1', request: PAIRING });
    const pairingId = queueEvents().at(-1)!.queue[0]!.pairingId;

    await command('deny', { clientId: 'c1', pairingId });

    expect(socket.frames('pair-result')[0]).toMatchObject({ approved: false });
    expect(store.acl['host-1']).toBeUndefined();
    expect(queueEvents().at(-1)!.queue).toEqual([]);
  });

  it('drops a client that went away, and a queue the socket took with it', async () => {
    const socket = await running();
    socket.receive({ t: 'pair', clientId: 'c1', request: PAIRING });
    socket.receive({ t: 'client-gone', clientId: 'c1' });
    expect(queueEvents().at(-1)!.queue).toEqual([]);

    socket.receive({ t: 'pair', clientId: 'c2', request: PAIRING });
    expect(queueEvents().at(-1)!.queue).toHaveLength(1);
    socket.close();
    expect(queueEvents().at(-1)!.queue).toEqual([]);
  });

  it('rejects approval for something already resolved', async () => {
    const socket = await running();
    socket.receive({ t: 'pair', clientId: 'c1', request: PAIRING });
    const pairingId = queueEvents().at(-1)!.queue[0]!.pairingId;
    await command('approve', { clientId: 'c1', pairingId });
    expect((await command('approve', { clientId: 'c1', pairingId })).error).toContain(
      'no longer pending',
    );
    expect(socket.frames('pair-result')).toHaveLength(1);
  });

  it('rejects stale modal actions after the client replaces its pairing request', async () => {
    const socket = await running();
    socket.receive({ t: 'pair', clientId: 'c1', request: PAIRING });
    const firstId = queueEvents().at(-1)!.queue[0]!.pairingId;

    const replacement = {
      ...PAIRING,
      devicePublicKey: 'device-2',
      requestedLabel: 'Android Chrome',
    };
    socket.receive({ t: 'pair', clientId: 'c1', request: replacement });
    const replacementItem = queueEvents().at(-1)!.queue[0]!;
    expect(replacementItem.pairingId).not.toBe(firstId);

    // Both buttons from the still-rendered first modal are now stale. Neither
    // may resolve or authorize the replacement request before it is shown.
    expect((await command('approve', { clientId: 'c1', pairingId: firstId })).error).toContain(
      'no longer pending',
    );
    expect((await command('deny', { clientId: 'c1', pairingId: firstId })).error).toContain(
      'no longer pending',
    );
    expect(socket.frames('pair-result')).toEqual([]);
    expect(store.acl['host-1']).toBeUndefined();
    expect(queueEvents().at(-1)!.queue).toEqual([replacementItem]);

    await command('approve', { clientId: 'c1', pairingId: replacementItem.pairingId });
    expect(socket.frames('pair-result')[0]).toMatchObject({
      clientId: 'c1',
      approved: true,
      record: { devicePublicKey: 'device-2' },
    });
  });
});

describe('setup QR', () => {
  /**
   * An enrollment whose `hostToken` cannot be confused with anything else in an
   * assertion — the shared fixture's `tok` is a substring of `#setup?token=`,
   * which is exactly the string this suite has to prove stays out of the webview.
   */
  const QR_ENROLLMENT: HostEnrollment = { ...ENROLLMENT, hostToken: 'host-bearer-secret' };

  async function running(
    enrollment: HostEnrollment = QR_ENROLLMENT,
  ): Promise<FakeSocket> {
    createService({ enrollment });
    await service.start();
    const socket = sockets[0]!;
    socket.open();
    return socket;
  }

  /** Mint a code and pull the token back out of the URL a phone would open. */
  async function mint(): Promise<{ url: string; expiresAt: number; token: string }> {
    const result = (await command('setupQr')).result as SetupQrResult;
    const token = new URL(result.url).hash.replace('#setup?token=', '');
    return { ...result, token: decodeURIComponent(token) };
  }

  function pair(socket: FakeSocket, clientId: string, setupNonce?: string) {
    socket.receive({
      t: 'pair',
      clientId,
      request: { ...PAIRING, devicePublicKey: `device-${clientId}`, setupNonce },
    });
    return queueEvents().at(-1)!.queue.find((item) => item.clientId === clientId)!;
  }

  it('mints over the Host’s own authenticated channel and composes the URL here', async () => {
    await running();
    const result = await mint();

    const posted = requests.at(-1)!;
    expect(posted.url).toBe(`${QR_ENROLLMENT.serverUrl}${API_ROUTES.hostSetupToken}`);
    expect((posted.init!.headers as Record<string, string>).authorization).toBe(
      'Bearer host-bearer-secret',
    );
    // An allowed origin's open redirect must not carry the bearer elsewhere.
    expect(posted.init!.redirect).toBe('error');

    // The origin is the enrollment's — the phone-facing WebAuthn origin — and
    // the token rides in the URL, which is the whole point of the command.
    expect(result.url).toBe(`${QR_ENROLLMENT.origin}/#setup?token=setup-token-1`);
    expect(result.token).toBe('setup-token-1');
    // The `hostToken` is not what crosses: only the code a human will scan does.
    expect(JSON.stringify(sent)).not.toContain('host-bearer-secret');
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
    // An `undefined` token would go into the QR *and* into the set that decides
    // `verified` on the next pairing.
    expect((await command('setupQr')).error).toContain('not a setup token');
  });

  it('marks a pairing verified for a nonce it minted, and never mirrors the nonce', async () => {
    const socket = await running();
    const { token } = await mint();

    const item = pair(socket, 'c1', token);
    expect(item.verified).toBe(true);
    // The webview is told the verdict, not the proof behind it. Its own copy of
    // the code is the QR it asked for; the pairing must not hand it a second one.
    // Cast because `MirroredPairingRequest` has no such field — this is the
    // runtime half of that claim.
    expect((item.request as PairingRequest).setupNonce).toBeUndefined();
    expect(JSON.stringify(queueEvents())).not.toContain(token);
  });

  it('spends a nonce on the first pairing that uses it', async () => {
    const socket = await running();
    const { token } = await mint();

    expect(pair(socket, 'c1', token).verified).toBe(true);
    // Single use: one scan sets up one phone, so a replay is an ordinary
    // fingerprint-compare pairing rather than an error.
    expect(pair(socket, 'c2', token).verified).toBe(false);
    expect(socket.frames('pair-result')).toEqual([]);
  });

  it('treats an unknown or expired nonce as an ordinary pairing', async () => {
    const socket = await running();
    expect(pair(socket, 'c1', 'never-minted-here').verified).toBe(false);

    setupTokenTtlMs = -1;
    const { token } = await mint();
    expect(pair(socket, 'c2', token).verified).toBe(false);
    // A nonce-less phone — the QR-less path — pairs exactly as it always did.
    expect(pair(socket, 'c3').verified).toBe(false);
  });

  it('forgets its codes when the enrollment they belong to goes', async () => {
    const socket = await running();
    const { token } = await mint();
    expect(socket.frames('pair-result')).toEqual([]);

    await command('clearEnrollment');
    await command('enroll', {
      serverUrl: 'https://relay.dormouse.sh',
      password: 'setup',
      label: 'Laptop',
    });
    const reconnected = sockets.at(-1)!;
    reconnected.open();

    // The token was minted by the server this Host just left.
    expect(pair(reconnected, 'c1', token).verified).toBe(false);
  });

  it('tells the webview when a code it minted is spent', async () => {
    const socket = await running();
    socket.receive({ t: 'setup-token-redeemed' });
    expect(uiEvents()).toContainEqual({ name: 'setupTokenRedeemed' });
  });
});

describe('push', () => {
  const sendBody = (): Record<string, unknown> | null => {
    const request = requests.filter((r) => r.url.endsWith('/api/push/send')).at(-1);
    return request ? (JSON.parse(String(request.init?.body)) as Record<string, unknown>) : null;
  };

  it('addresses the Host’s own ACL, not anything the webview sent', async () => {
    createService({
      enrollment: ENROLLMENT,
      acl: { 'host-1': [aclRecord('device-1'), aclRecord('device-2', 'iPad')] },
    });
    await service.start();

    await command('push', { sessionId: 'pty-1', title: 'pnpm dev' });

    expect(sendBody()).toMatchObject({
      devicePublicKeys: ['device-1', 'device-2'],
      title: 'pnpm dev',
      tag: 'pty-1',
    });
  });

  it('bounds the title the webview supplied', async () => {
    createService({ enrollment: ENROLLMENT, acl: { 'host-1': [aclRecord('device-1')] } });
    await service.start();

    await command('push', { sessionId: 'pty-1', title: 'build finished' });
    expect(sendBody()).toMatchObject({ title: 'build finished' });
  });

  it('is a silent no-op with no Host running', async () => {
    createService();
    const result = await command('push', { sessionId: 'pty-1', title: 'x' });
    expect(result.error).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it('warns rather than failing the command when the server rejects it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store = memoryStore({ enrollment: ENROLLMENT, acl: { 'host-1': [aclRecord('device-1')] } });
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
    createService({ enrollment: ENROLLMENT, acl: { 'host-1': [aclRecord('device-1')] } });
    await service.start();

    // `device-revoked` is subscribed on the server but no longer in the ACL.
    expect((await command('pushDevices')).result).toEqual({
      devices: [{ devicePublicKey: 'device-1', label: 'iPhone Safari' }],
    });
  });

  it('answers null when no Host is running', async () => {
    createService();
    // "Nowhere to push" — not an empty list, and not a failed request.
    expect((await command('pushDevices')).result).toBeNull();
  });

  it('errors when the server cannot be asked', async () => {
    store = memoryStore({ enrollment: ENROLLMENT, acl: { 'host-1': [aclRecord('device-1')] } });
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
    createService({ enrollment: ENROLLMENT, acl: { 'host-1': [] } });
    await service.start();

    const { result } = await command('pushTest');
    // Distinct from a refused send: the Host is fine, nothing has opted in.
    expect(result).toEqual({ targeted: 0, delivered: 0, failed: 0 });
    expect(requests.some((request) => request.url.endsWith('/api/push/send'))).toBe(false);
  });

  it('sends through the real path and reports what was delivered', async () => {
    createService({ enrollment: ENROLLMENT, acl: { 'host-1': [aclRecord('device-1')] } });
    await service.start();

    const { result } = await command('pushTest');
    expect(result).toEqual({ targeted: 1, delivered: 1, failed: 0 });

    const send = requests.find((request) => request.url.endsWith('/api/push/send'));
    expect(send).toBeTruthy();
    const body = JSON.parse(String(send!.init?.body)) as Record<string, unknown>;
    // Recipients come from the ACL, exactly as a real ring does.
    expect(body.devicePublicKeys).toEqual(['device-1']);
    // A fixed collapse key, so repeated presses replace rather than stack.
    expect(body.tag).toBe('dormouse-push-test');
    expect(String(body.title)).toContain('test');
  });

  it('surfaces a refused send instead of swallowing it', async () => {
    store = memoryStore({ enrollment: ENROLLMENT, acl: { 'host-1': [aclRecord('device-1')] } });
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
