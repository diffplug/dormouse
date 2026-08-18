/**
 * The single-Host lease. VS Code can show several Dormouse webviews over one
 * extension host; without this gate each would start its own `RemoteHost`
 * against the same enrollment, fight over the one `/ws/host` socket, and arm
 * its own alarm push.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('./alert-push', () => ({
  startAlertPush: () => () => {},
  refreshPushDevices: async () => {},
}));
vi.mock('../../lib/push-devices', () => ({
  resetPushDevices: () => {},
  setPushDevicesRefresher: () => {},
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
// A host with peers is exactly a host that arbitrates the role, so the lease
// arrives through the same optional member (`PeerBridge`); no peers means
// single-instance.
vi.mock('../../lib/platform', () => ({
  getPlatform: () => ({ peers: claimSingleton ? { claimSingleton } : undefined }),
}));

async function freshModule() {
  vi.resetModules();
  return import('./activation');
}

beforeEach(() => {
  started.length = 0;
  claimSingleton = undefined;
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
