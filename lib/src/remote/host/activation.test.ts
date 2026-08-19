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
  stopped: 0,
  invalidated: 0,
  loads: [] as Array<() => Promise<unknown>>,
}));
vi.mock('./alert-push', () => ({
  watchPushRings: (fire: (sessionId: string, title: string) => void) => {
    pushWatch.fire = fire;
    return () => {
      pushWatch.fire = undefined;
      pushWatch.stopped += 1;
    };
  },
  commitPushDevices: async (load: () => Promise<unknown>) => {
    pushWatch.loads.push(load);
    await load();
  },
  invalidatePushDeviceRefreshes: () => {
    pushWatch.invalidated += 1;
  },
}));
const pushRefreshers = vi.hoisted(() => ({ current: [] as Array<() => void>, resets: 0 }));
vi.mock('../../lib/push-devices', () => ({
  setPushDevicesRefresher: (refresh: () => void) => void pushRefreshers.current.push(refresh),
  resetPushDevices: () => {
    pushRefreshers.resets += 1;
  },
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
  pushWatch.stopped = 0;
  pushWatch.invalidated = 0;
  pushWatch.loads.length = 0;
  pushRefreshers.current.length = 0;
  pushRefreshers.resets = 0;
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

/**
 * Install in bridge mode and hand back the module's fresh pairing store.
 * Enrolled unless a test says otherwise: that is the state everything but the
 * gate's own cases is about.
 */
async function installBridge(link: FakeLink) {
  link.results.status ??= { enrolled: true };
  // A store that survives a restart, which is what lets the webview drop its
  // own copy of an adopted Host.
  link.results.adopt ??= { persisted: true };
  remoteHostLink = link;
  vi.resetModules();
  const mod = await import('./activation');
  const pairing = await import('./pairing-approval');
  mod.installRemoteHostConsoleHook();
  // The adoption round trip gates the queue seed, and the `status` seed gates
  // the ring watch.
  await settle();
  return { mod, pairing };
}

/** Let the boot round trips land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
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
    // The service is holding it somewhere durable now, so this copy is obsolete
    // — leaving it would be a second ACL for the same hostId.
    expect(enrollmentState.current).toBeNull();
    expect(aclState.cleared).toEqual(['host-1']);
  });

  it('keeps the local copy when the service could not persist it', async () => {
    // The dev harness with no state directory holds the Host in memory only:
    // this copy is the one that survives the process, and clearing it would
    // lose the Host at the next launch.
    aclState.records = [{ hostId: 'host-1' }];
    const link = fakeLink();
    link.results.adopt = { persisted: false };
    await installBridge(link);

    expect(link.commands.some((c) => c.cmd === 'adopt')).toBe(true);
    expect(enrollmentState.current).not.toBeNull();
    expect(aclState.cleared).toEqual([]);
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

  it('re-mirrors a request the service replaced under the same clientId', async () => {
    // The service coalesces a re-sent pair by clientId, so the same id can come
    // to name a different device. Approving authorizes what the *service*
    // holds, so a mirror that skipped the update would show device #1 while
    // Approve wrote device #2 (docs/specs/remote-security-model.md).
    const link = fakeLink();
    const { pairing } = await installBridge(link);
    const second = {
      ...PAIRING_REQUEST,
      devicePublicKey: 'device-2',
      requestedLabel: 'Android Chrome',
    };

    link.emit('pairing-queue', {
      name: 'pairing-queue',
      queue: [{ clientId: 'c1', request: PAIRING_REQUEST, requestedAt: 5 }],
    });
    link.emit('pairing-queue', {
      name: 'pairing-queue',
      queue: [{ clientId: 'c1', request: second, requestedAt: 9 }],
    });

    const head = pairing.getPairingApprovalSnapshot();
    expect(head).toHaveLength(1);
    expect(head[0]).toMatchObject({ clientId: 'c1', request: second, requestedAt: 9 });
  });

  it('leaves an unchanged request alone, so the modal does not churn', async () => {
    // Every snapshot arrives as fresh JSON, so "unchanged" has to be decided by
    // value — comparing identity would re-render the modal on every event.
    const link = fakeLink();
    const { pairing } = await installBridge(link);
    const snapshot = () => ({
      name: 'pairing-queue',
      queue: [{ clientId: 'c1', request: { ...PAIRING_REQUEST }, requestedAt: 5 }],
    });

    link.emit('pairing-queue', snapshot());
    const first = pairing.getPairingApprovalSnapshot()[0];
    link.emit('pairing-queue', snapshot());
    expect(pairing.getPairingApprovalSnapshot()[0]).toBe(first);
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

  it('arms nothing at all on a host that never enrolled', async () => {
    // The common case: no ring watch, no device fetch, and no crossing per
    // activity change — only the one `status` that says so.
    const link = fakeLink();
    link.results.status = { enrolled: false };
    await installBridge(link);

    expect(pushWatch.fire).toBeUndefined();
    expect(link.commands.some((c) => c.cmd === 'pushDevices')).toBe(false);
    expect(link.commands.some((c) => c.cmd === 'status')).toBe(true);
  });

  it('arms when the service announces a Host, and disarms when it goes', async () => {
    const link = fakeLink();
    link.results.status = { enrolled: false };
    await installBridge(link);

    // An enroll from any webview reaches every webview as this event.
    link.emit('status', { name: 'status', enrolled: true });
    await settle();
    expect(pushWatch.fire).toBeDefined();
    expect(link.commands.some((c) => c.cmd === 'pushDevices')).toBe(true);

    // `clearEnrollment` announces the same way.
    link.emit('status', { name: 'status', enrolled: false });
    expect(pushWatch.fire).toBeUndefined();
    expect(pushWatch.stopped).toBe(1);
    // The dialog must stop naming devices nothing can push to — including any
    // list still on the wire, which would otherwise put them back on arrival.
    expect(pushWatch.invalidated).toBe(1);
    expect(pushRefreshers.resets).toBe(1);
    // And the refresher goes back in: the dialog may still open on an
    // un-enrolled machine, where asking is one command that answers `no-host`.
    expect(pushRefreshers.current.at(-1)).toBeDefined();
    link.commands.length = 0;
    pushRefreshers.current.at(-1)!();
    await settle();
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
