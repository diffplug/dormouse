/**
 * The single-Host lease. VS Code can show several Dormouse webviews over one
 * extension host; without this gate each would start its own `RemoteHost`
 * against the same enrollment, fight over the one `/ws/host` socket, and arm
 * its own alarm push.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const started: Array<{ stopped: boolean }> = [];

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
  getEnrollment: () => ({
    serverUrl: 'https://relay.example.ts.net',
    hostId: 'host-1',
    hostToken: 'token',
    origin: 'https://relay.example.ts.net',
    rpId: 'relay.example.ts.net',
  }),
  clearEnrollment: () => {},
  enrollHost: async () => ({}),
}));

let claimSingleton: ((name: string, onChange: (held: boolean) => void) => void) | undefined;
vi.mock('../../lib/platform', () => ({
  getPlatform: () => ({ claimSingleton }),
}));

async function freshModule() {
  vi.resetModules();
  return import('./activation');
}

beforeEach(() => {
  started.length = 0;
  claimSingleton = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('remote host activation lease', () => {
  it('activates immediately on a host with no lease (standalone)', async () => {
    const mod = await freshModule();
    mod.installRemoteHostConsoleHook();
    expect(started).toHaveLength(1);
  });

  it('waits for the lease on a host that arbitrates', async () => {
    let grant: ((held: boolean) => void) | null = null;
    claimSingleton = (_name, onChange) => {
      grant = onChange;
    };

    const mod = await freshModule();
    mod.installRemoteHostConsoleHook();

    // Mount alone must not start a Host — the answer has not arrived yet.
    expect(started).toHaveLength(0);

    grant!(true);
    expect(started).toHaveLength(1);
    expect(started[0].stopped).toBe(false);
  });

  it('stops when the lease is revoked and restarts when re-granted', async () => {
    let grant: ((held: boolean) => void) | null = null;
    claimSingleton = (_name, onChange) => {
      grant = onChange;
    };

    const mod = await freshModule();
    mod.installRemoteHostConsoleHook();
    grant!(true);
    expect(started).toHaveLength(1);

    grant!(false);
    expect(started[0].stopped).toBe(true);

    grant!(true);
    expect(started).toHaveLength(2);
  });

  it('a repeated grant does not start a second Host', async () => {
    const mod = await freshModule();
    mod.installRemoteHostConsoleHook();
    mod.setRemoteHostOwnership(true);
    mod.setRemoteHostOwnership(true);
    expect(started).toHaveLength(1);
  });

  it('claims under the shared role name', async () => {
    const names: string[] = [];
    claimSingleton = (name) => void names.push(name);

    const mod = await freshModule();
    mod.installRemoteHostConsoleHook();

    expect(names).toEqual(['remote-host']);
  });
});
