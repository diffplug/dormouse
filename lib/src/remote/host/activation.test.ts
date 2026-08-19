/**
 * Legacy mode: the single-Host lease. VS Code can show several Dormouse webviews
 * over one extension host; without this gate each would start its own
 * `RemoteHost` against the same enrollment, fight over the one `/ws/host`
 * socket, and arm its own alarm push.
 *
 * Bridge mode (bottom): the Host runs in another process, so this module starts
 * none of that and is a client of the service instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairingRequest } from 'server-lib-common';
import type { RemoteHostLink } from '../../lib/platform/types';

const started: Array<{ stopped: boolean }> = [];
const enrollmentState = vi.hoisted(() => ({
  current: {
    serverUrl: 'https://relay.example.ts.net',
    hostId: 'host-1',
    hostToken: 'token',
    origin: 'https://relay.example.ts.net',
    rpId: 'relay.example.ts.net',
  } as {
    serverUrl: string;
    hostId: string;
    hostToken: string;
    origin: string;
    rpId: string;
  } | null,
}));

vi.mock('./remote-host', () => ({
  RemoteHost: class {
    activeRecords: never[] = [];
    status = 'connecting';
    #self = { stopped: false };
    constructor() {
      started.push(this.#self);
    }
    start() {}
    stop() {
      this.#self.stopped = true;
    }
  },
}));
vi.mock('./remote-api', () => ({ RemoteApiSession: class {} }));
const pushWatch = vi.hoisted(() => ({
  fire: undefined as ((sessionId: string, title: string) => void) | undefined,
  loads: [] as Array<() => Promise<unknown>>,
}));
vi.mock('./alert-push', () => ({
  startAlertPush: () => () => {},
  refreshPushDevices: async () => {},
  watchPushRings: (fire: (sessionId: string, title: string) => void) => {
    pushWatch.fire = fire;
    return () => {};
  },
  commitPushDevices: async (load: () => Promise<unknown>) => {
    pushWatch.loads.push(load);
    await load();
  },
}));
const pushRefreshers = vi.hoisted(() => ({ current: [] as Array<() => void> }));
vi.mock('../../lib/push-devices', () => ({
  resetPushDevices: () => {},
  setPushDevicesRefresher: (refresh: () => void) => void pushRefreshers.current.push(refresh),
}));
const aclState = vi.hoisted(() => ({
  records: [] as unknown[],
  cleared: [] as string[],
}));
vi.mock('./acl', () => ({
  loadAclRecords: () => aclState.records,
  clearAclRecords: (hostId: string) => void aclState.cleared.push(hostId),
}));
vi.mock('./enrollment', () => ({
  getEnrollment: () => enrollmentState.current,
  clearEnrollment: () => {
    enrollmentState.current = null;
  },
  enrollHost: async (serverUrl: string) => {
    enrollmentState.current = {
      serverUrl,
      hostId: 'host-1',
      hostToken: 'token',
      origin: serverUrl,
      rpId: new URL(serverUrl).hostname,
    };
    return enrollmentState.current;
  },
}));

let claimSingleton: ((name: string, onChange: (held: boolean) => void) => void) | undefined;
let remoteHostLink: RemoteHostLink | undefined;
// A host with peers is exactly a host that arbitrates the role, so the lease
// arrives through the same optional member (`PeerBridge`); no peers means
// single-instance. A host with `remoteHost` runs the Host elsewhere entirely.
vi.mock('../../lib/platform', () => ({
  getPlatform: () => ({
    peers: claimSingleton ? { claimSingleton } : undefined,
    remoteHost: remoteHostLink,
  }),
}));

async function freshModule() {
  vi.resetModules();
  return import('./activation');
}

beforeEach(() => {
  started.length = 0;
  claimSingleton = undefined;
  remoteHostLink = undefined;
  pushWatch.fire = undefined;
  pushWatch.loads.length = 0;
  pushRefreshers.current.length = 0;
  aclState.records = [];
  aclState.cleared.length = 0;
  enrollmentState.current = {
    serverUrl: 'https://relay.example.ts.net',
    hostId: 'host-1',
    hostToken: 'token',
    origin: 'https://relay.example.ts.net',
    rpId: 'relay.example.ts.net',
  };
  // The console hook lives on globalThis and outlives `vi.resetModules()`;
  // leaving it set would make the next test call the previous module's closure.
  delete (globalThis as { dormouseRemoteHost?: unknown }).dormouseRemoteHost;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function installWithLease() {
  let grant!: (held: boolean) => void;
  claimSingleton = (_name, onChange) => {
    grant = onChange;
  };
  const mod = await freshModule();
  mod.installRemoteHostConsoleHook();
  return { mod, grant: (held: boolean) => grant(held) };
}

describe('remote host activation lease', () => {
  it('activates immediately on a host with no lease (standalone)', async () => {
    const mod = await freshModule();
    mod.installRemoteHostConsoleHook();
    expect(started).toHaveLength(1);
  });

  it('waits for the lease on a host that arbitrates', async () => {
    const { grant } = await installWithLease();

    // Mount alone must not start a Host — the answer has not arrived yet.
    expect(started).toHaveLength(0);

    grant(true);
    expect(started).toHaveLength(1);
    expect(started[0].stopped).toBe(false);
  });

  it('stops when the lease is revoked and restarts when re-granted', async () => {
    const { grant } = await installWithLease();
    grant(true);
    expect(started).toHaveLength(1);

    grant(false);
    expect(started[0].stopped).toBe(true);

    grant(true);
    expect(started).toHaveLength(2);
  });

  it('a repeated grant does not start a second Host', async () => {
    const { grant } = await installWithLease();
    grant(true);
    grant(true);
    expect(started).toHaveLength(1);
  });

  it('claims under the shared role name', async () => {
    const names: string[] = [];
    claimSingleton = (name) => void names.push(name);

    const mod = await freshModule();
    mod.installRemoteHostConsoleHook();

    expect(names).toEqual(['remote-host']);
  });

  it('does not claim the lease before an enrollment exists', async () => {
    enrollmentState.current = null;
    const names: string[] = [];
    claimSingleton = (name) => void names.push(name);

    const mod = await freshModule();
    mod.installRemoteHostConsoleHook();

    expect(names).toEqual([]);
    expect(started).toHaveLength(0);
  });

  it('claims after a successful first enrollment', async () => {
    enrollmentState.current = null;
    const names: string[] = [];
    let grant!: (held: boolean) => void;
    claimSingleton = (name, onChange) => {
      names.push(name);
      grant = onChange;
    };
    const mod = await freshModule();
    mod.installRemoteHostConsoleHook();
    const hook = (globalThis as {
      dormouseRemoteHost?: { enroll: (a: string, b: string, c: string) => Promise<unknown> };
    }).dormouseRemoteHost!;

    await hook.enroll('https://relay.example.ts.net', 'password', 'Laptop');
    expect(names).toEqual(['remote-host']);
    expect(started).toHaveLength(0);

    grant(true);
    expect(started).toHaveLength(1);
  });

  it('enrolling from a non-holder does not start a competing Host', async () => {
    await installWithLease();
    const hook = (globalThis as { dormouseRemoteHost?: { enroll: (a: string, b: string, c: string) => Promise<unknown> } })
      .dormouseRemoteHost!;

    await hook.enroll('https://relay.example.ts.net', 'password', 'Laptop');

    expect(started).toHaveLength(0);
  });
});

// --- Bridge mode ---

const PAIRING_REQUEST = {
  accountId: 'owner',
  passkeyCredentialId: 'cred-1',
  passkeyPublicKeyHash: 'hash-1',
  devicePublicKey: 'device-1',
  requestedLabel: 'iPhone Safari',
} satisfies PairingRequest;

interface FakeLink extends RemoteHostLink {
  commands: Array<{ cmd: string; params?: unknown }>;
  emit(name: string, data: unknown): void;
  results: Record<string, unknown>;
}

function fakeLink(): FakeLink {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const link: FakeLink = {
    commands: [],
    results: {},
    command: async (cmd, params) => {
      link.commands.push({ cmd, params });
      return link.results[cmd];
    },
    respond: () => {},
    notify: () => {},
    on: (name, listener) => {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => void set.delete(listener);
    },
    emit: (name, data) => {
      for (const listener of listeners.get(name) ?? []) listener(data);
    },
  };
  return link;
}

/** Install in bridge mode and hand back the module's fresh pairing store. */
async function installBridge(link: FakeLink) {
  remoteHostLink = link;
  vi.resetModules();
  const mod = await import('./activation');
  const pairing = await import('./pairing-approval');
  mod.installRemoteHostConsoleHook();
  // The adoption round trip gates the queue seed.
  await Promise.resolve();
  await Promise.resolve();
  return { mod, pairing };
}

function consoleHook() {
  return (globalThis as {
    dormouseRemoteHost?: {
      enroll: (a: string, b: string, c: string) => Promise<unknown>;
      status: () => unknown;
      reconnect: () => unknown;
      clearEnrollment: () => unknown;
    };
  }).dormouseRemoteHost!;
}

describe('remote host bridge mode', () => {
  it('starts no Host of its own', async () => {
    await installBridge(fakeLink());
    expect(started).toHaveLength(0);
  });

  it('forwards every console method to the service', async () => {
    const link = fakeLink();
    link.results.status = { enrolled: true };
    await installBridge(link);

    await consoleHook().enroll('https://relay.dormouse.sh', 'password', 'Laptop');
    expect(await consoleHook().status()).toEqual({ enrolled: true });
    await consoleHook().reconnect();
    await consoleHook().clearEnrollment();

    expect(link.commands.map((c) => c.cmd)).toEqual(
      expect.arrayContaining(['enroll', 'status', 'reconnect', 'clearEnrollment']),
    );
    expect(link.commands.find((c) => c.cmd === 'enroll')?.params).toEqual({
      serverUrl: 'https://relay.dormouse.sh',
      password: 'password',
      label: 'Laptop',
    });
  });

  it('hands a webview-persisted Host over once, then clears its keys', async () => {
    aclState.records = [{ hostId: 'host-1' }];
    const link = fakeLink();
    await installBridge(link);

    const adopt = link.commands.find((c) => c.cmd === 'adopt');
    expect(adopt?.params).toMatchObject({
      enrollment: { hostId: 'host-1' },
      aclRecords: [{ hostId: 'host-1' }],
    });
    // Whatever the service decided, this copy is obsolete — leaving it would be
    // a second ACL for the same hostId.
    expect(enrollmentState.current).toBeNull();
    expect(aclState.cleared).toEqual(['host-1']);
  });

  it('adopts nothing when the webview never was a Host', async () => {
    enrollmentState.current = null;
    const link = fakeLink();
    await installBridge(link);
    expect(link.commands.some((c) => c.cmd === 'adopt')).toBe(false);
    expect(aclState.cleared).toEqual([]);
  });

  it('keeps the local copy when the hand-off fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const link = fakeLink();
    link.command = async (cmd, params) => {
      link.commands.push({ cmd, params });
      if (cmd === 'adopt') throw new Error('sidecar is down');
      return link.results[cmd];
    };
    await installBridge(link);

    expect(enrollmentState.current).not.toBeNull();
    expect(aclState.cleared).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('mirrors the service queue and answers by clientId', async () => {
    const link = fakeLink();
    const { pairing } = await installBridge(link);

    link.emit('pairing-queue', {
      name: 'pairing-queue',
      queue: [{ clientId: 'c1', request: PAIRING_REQUEST, requestedAt: 5 }],
    });

    const head = pairing.getPairingApprovalSnapshot()[0]!;
    expect(head).toMatchObject({ clientId: 'c1', request: PAIRING_REQUEST, requestedAt: 5 });

    head.approve('Ned iPhone');
    expect(link.commands.at(-1)).toEqual({
      cmd: 'approve',
      params: { clientId: 'c1', label: 'Ned iPhone' },
    });
    head.deny();
    expect(link.commands.at(-1)).toEqual({ cmd: 'deny', params: { clientId: 'c1' } });
  });

  it('replaces the mirror wholesale — the service is authoritative', async () => {
    const link = fakeLink();
    const { pairing } = await installBridge(link);
    const queue = (ids: string[]) => ({
      name: 'pairing-queue',
      queue: ids.map((clientId) => ({ clientId, request: PAIRING_REQUEST, requestedAt: 5 })),
    });

    link.emit('pairing-queue', queue(['c1', 'c2']));
    expect(pairing.getPairingApprovalSnapshot().map((p) => p.clientId)).toEqual(['c1', 'c2']);

    // c1 resolved on the service side; the snapshot that no longer names it is
    // the only signal, and the order of what remains must not churn.
    link.emit('pairing-queue', queue(['c2']));
    expect(pairing.getPairingApprovalSnapshot().map((p) => p.clientId)).toEqual(['c2']);

    link.emit('pairing-queue', queue([]));
    expect(pairing.getPairingApprovalSnapshot()).toEqual([]);
  });

  it('seeds the mirror once, for a webview that reloaded mid-pairing', async () => {
    const link = fakeLink();
    link.results.pairingQueue = [{ clientId: 'c1', request: PAIRING_REQUEST, requestedAt: 5 }];
    const { pairing } = await installBridge(link);

    expect(link.commands.some((c) => c.cmd === 'pairingQueue')).toBe(true);
    expect(pairing.getPairingApprovalSnapshot()).toHaveLength(1);
  });

  it('reports rings with the label the webview derived', async () => {
    const link = fakeLink();
    await installBridge(link);

    pushWatch.fire!('pty-1', 'pnpm dev');
    expect(link.commands.at(-1)).toEqual({
      cmd: 'push',
      params: { sessionId: 'pty-1', title: 'pnpm dev' },
    });
  });

  it('asks the service for the device list the dialog names', async () => {
    const link = fakeLink();
    await installBridge(link);

    expect(link.commands.some((c) => c.cmd === 'pushDevices')).toBe(true);
    // And the dialog can ask again later.
    link.commands.length = 0;
    pushRefreshers.current.at(-1)!();
    await Promise.resolve();
    expect(link.commands.map((c) => c.cmd)).toEqual(['pushDevices']);
  });

  it('is idempotent under a StrictMode double mount', async () => {
    const link = fakeLink();
    const { mod } = await installBridge(link);
    const before = link.commands.length;

    mod.installRemoteHostConsoleHook();
    await Promise.resolve();
    expect(link.commands).toHaveLength(before);
  });
});
