/**
 * The webview's end of the Host service (`lib/src/host/remote/service.ts`): it
 * forwards console commands, mirrors the pairing queue, reports rings, and
 * hands over a Host it persisted before the service existed. It starts no
 * `RemoteHost` of its own — there is no webview-resident mode left to fall back
 * to, so a host with no service behind it gets nothing at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairingRequest } from 'server-lib-common';
import type { RemoteHostLink } from '../../lib/platform/types';

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

const pushWatch = vi.hoisted(() => ({
  fire: undefined as ((sessionId: string, title: string) => void) | undefined,
  loads: [] as Array<() => Promise<unknown>>,
}));
vi.mock('./alert-push', () => ({
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
}));

let remoteHostLink: RemoteHostLink | undefined;
// A host with `remoteHost` has a Host service behind it; without one (the
// website) there is no Host anywhere.
vi.mock('../../lib/platform', () => ({
  getPlatform: () => ({ remoteHost: remoteHostLink }),
}));

beforeEach(() => {
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
  it('does nothing at all with no service behind the host', async () => {
    // The website: no `remoteHost`, so no console hook and no commands. There
    // is no webview-resident Host to fall back to.
    remoteHostLink = undefined;
    vi.resetModules();
    const mod = await import('./activation');
    mod.installRemoteHostConsoleHook();
    expect((globalThis as { dormouseRemoteHost?: unknown }).dormouseRemoteHost).toBeUndefined();
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
