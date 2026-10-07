/**
 * Settings → Network's promises against the VS Code binding — the extension
 * host's `BurrowService`, started by the real contention over the real peer
 * link — as `lib/src/host/remote/outbound.test.ts` runs them against the
 * sidecar's (`docs/specs/security-local.md` -> "Network policy").
 *
 * The network is observed at the Node layer (`test-outbound.ts`); the peer
 * link's Unix socket or named pipe is local and passes. VS Code has no managed
 * voice and no updater, so neither is driven here. Real timers: the peer link's
 * contention runs on them, so the run waits on answers rather than advancing a
 * clock past the relay socket's backoff, which the sidecar suite does.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectionsFor } from '../../lib/src/components/NetworkSettings';
import { DEFAULT_RELAY_ORIGIN } from '../../lib/src/host/relay-origin';
import type { BurrowConsoleStatus } from '../../lib/src/host/remote/service-protocol';
import { mintTestNoiseStatic, recordOutbound, type OutboundRecorder } from '../../lib/src/host/remote/test-outbound';
import type { NetworkPolicy } from '../../lib/src/remote/network-policy';
import { ENROLLMENT_KEY } from '../../lib/src/remote/burrow/store';
import { NETWORK_POLICY_KEY } from '../src/burrow-store';
import type { ExtensionMessage } from '../src/message-types';
import { removeDir, tempStorageDir, tick, waitFor } from './helpers';

type BurrowModule = typeof import('../src/burrow');
type LinkModule = typeof import('../src/peer-link');

const SELF_HOST_ORIGIN = 'https://ned-mac.tail9c2f1.ts.net';

const relayBuild = vi.hoisted(() => ({ origin: 'https://relay.dormouse.sh', mode: 'hosted' as 'hosted' | 'self-host' }));
vi.mock('../../lib/src/host/relay-origin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/src/host/relay-origin')>()),
  bakedRelay: () => ({ ...relayBuild }),
}));

/** The installer's offer file is the one other thing read off the real disk. */
vi.mock('../../lib/src/host/remote/enroll-offer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/src/host/remote/enroll-offer')>()),
  readEnrollmentOffer: () =>
    Promise.resolve({ origin: SELF_HOST_ORIGIN, token: 'a'.repeat(64), mintedAt: '2026-08-31T00:00:00.000Z' }),
}));

let noise: { privateKeyPkcs8: string; publicKey: string };
let dir: string;
let realTmp: string | undefined;
let net: OutboundRecorder;
let link: LinkModule | null;
let mod: BurrowModule | null;
let activation: { dispose(): void } | null;
let posted: ExtensionMessage[];
let seq = 0;

beforeAll(async () => {
  noise = await mintTestNoiseStatic();
});

beforeEach(async () => {
  dir = await tempStorageDir();
  realTmp = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  relayBuild.origin = DEFAULT_RELAY_ORIGIN;
  relayBuild.mode = 'hosted';
  posted = [];
  link = null;
  mod = null;
  activation = null;
  net = recordOutbound();
});

afterEach(async () => {
  activation?.dispose();
  await link?.disposePeerLink();
  net.restore();
  if (realTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmp;
  await removeDir(dir);
});

/** The slice of `ExtensionContext` the store and the link read, in memory. */
function fakeContext(secrets: Map<string, string>, global: Map<string, unknown>) {
  return {
    globalStorageUri: { fsPath: dir },
    subscriptions: [] as unknown[],
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
      onDidChange: () => ({ dispose: () => {} }),
    },
    globalState: {
      get: (key: string) => global.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) global.delete(key);
        else global.set(key, value);
      },
      keys: () => [...global.keys()],
    },
  } as never;
}

function enrollmentJson(origin: string): string {
  return JSON.stringify({
    relayUrl: origin,
    burrowId: 'S6kyjjqOS7mw3l8ye89U3g',
    burrowToken: 'token',
    origin,
    rpId: new URL(origin).hostname,
    label: 'Laptop',
    noiseStaticPrivateKey: noise.privateKeyPkcs8,
    noiseStaticPublicKey: noise.publicKey,
  });
}

/** One window activated as VS Code activates it, with `secrets` and `global` as its storage. */
async function activate(secrets: Map<string, string>, global: Map<string, unknown>): Promise<void> {
  vi.resetModules();
  mod = (await import('../src/burrow')) as BurrowModule;
  link = (await import('../src/peer-link')) as LinkModule;
  const context = fakeContext(secrets, global);
  link.initPeerLink(context);
  mod.configureBurrow({
    brokerRequest: async () => [],
    broadcastToWebviews: (message) => void posted.push(message),
    writePty: () => {},
    resizePty: () => {},
    streamPty: () => ({ stop: () => {}, ready: Promise.resolve() }) as never,
  });
  activation = mod.initBurrow(context);
}

async function command(cmd: string, params?: unknown): Promise<{ result?: unknown; error?: string }> {
  const burrowRequestId = `outbound-${++seq}`;
  mod!.handleBurrowCommand({ burrowRequestId, cmd, ...(params === undefined ? {} : { params }) });
  const find = () =>
    posted
      .filter((message) => message.type === 'burrow:result')
      .map((message) => (message as { payload: { burrowRequestId: string; result?: unknown; error?: string } }).payload)
      .find((payload) => payload.burrowRequestId === burrowRequestId);
  await waitFor(() => find() !== undefined, 15_000);
  return find()!;
}

/** Every request the webview sends at startup and when Settings opens, and each one a click sends. */
async function exercise(): Promise<void> {
  for (const cmd of ['networkPolicy', 'status', 'oneTimeStatus', 'pairingQueue', 'pushDevices', 'pushTest', 'setupQr', 'reconnect']) {
    await command(cmd);
  }
  await command('enroll', { password: 'p'.repeat(32), label: 'Laptop' });
  await command('enrollOffer', { label: 'Laptop' });
  await command('beginHostedEnrollment', { label: 'Laptop' });
  // Not awaited: where it is allowed, its answer waits on a rendezvous socket
  // that no relay here will ever open; what it reaches is what counts.
  mod!.handleBurrowCommand({ burrowRequestId: `outbound-${++seq}`, cmd: 'oneTimeOpen' });
  await tick(300);
}

const SETUPS: Array<[string, (secrets: Map<string, string>, global: Map<string, unknown>) => void]> = [
  ['a fresh install', () => {}],
  ['an enrollment at Nowhere', (secrets, global) => {
    secrets.set(ENROLLMENT_KEY, enrollmentJson(relayBuild.origin));
    global.set(NETWORK_POLICY_KEY, { level: 'nothing', allowed: [], autoUpdate: true });
  }],
  ['an unreadable policy over an enrollment', (secrets, global) => {
    secrets.set(ENROLLMENT_KEY, enrollmentJson(relayBuild.origin));
    global.set(NETWORK_POLICY_KEY, { level: 'anywhere', allowed: 'everything' });
  }],
];

describe.each(['hosted', 'self-host'] as const)('a %s build, under Nowhere', (mode) => {
  it.each(SETUPS)('opens no connection with %s', async (_name, setup) => {
    relayBuild.mode = mode;
    relayBuild.origin = mode === 'self-host' ? SELF_HOST_ORIGIN : DEFAULT_RELAY_ORIGIN;
    const secrets = new Map<string, string>();
    const global = new Map<string, unknown>();
    setup(secrets, global);
    await activate(secrets, global);
    await exercise();

    expect(net.offMachine()).toEqual([]);
    expect(((await command('networkPolicy')).result as { policy: NetworkPolicy }).policy.level).toBe('nothing');
  });
});

describe('under every other level, exactly the listed connections', () => {
  const LEVELS: Array<['hosted' | 'self-host', NetworkPolicy]> = [
    ['hosted', { level: 'local', allowed: ['192.168.1.0/24'], autoUpdate: false }],
    ['hosted', { level: 'anywhere', allowed: [], autoUpdate: false }],
    ['self-host', { level: 'relay', allowed: [], autoUpdate: false }],
  ];

  it.each(LEVELS)('a %s build at %j', async (mode, policy) => {
    relayBuild.mode = mode;
    relayBuild.origin = mode === 'self-host' ? SELF_HOST_ORIGIN : DEFAULT_RELAY_ORIGIN;
    const secrets = new Map([[ENROLLMENT_KEY, enrollmentJson(relayBuild.origin)]]);
    const global = new Map<string, unknown>([[NETWORK_POLICY_KEY, { level: 'nothing', allowed: [], autoUpdate: false }]]);
    await activate(secrets, global);
    await command('status');
    expect(net.offMachine()).toEqual([]);

    expect((await command('setNetworkPolicy', { policy })).error).toBeUndefined();
    await exercise();

    const status = (await command('status')).result as BurrowConsoleStatus;
    const listed = new Set(
      connectionsFor({ policy, status, managedVoice: false, updater: false })
        .map((row) => row.to.split(/\s/)[0]!)
        .filter((first) => /^[\w-]+(?:\.[\w-]+)+$/.test(first)),
    );
    const contacted = net.hosts();
    for (const host of contacted) expect(listed).toContain(host);
    expect(contacted).toContain(new URL(relayBuild.origin).hostname);
    expect(contacted).not.toContain('stun.cloudflare.com');
    expect(net.offMachine().filter((attempt) => !attempt.via.startsWith('globalThis.'))).toEqual([]);
  });
});
