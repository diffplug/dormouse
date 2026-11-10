/**
 * Settings → Network's promises against the VS Code binding — the extension
 * host's `BurrowService`, started by the real contention over the real peer
 * link — as `lib/src/host/remote/outbound.test.ts` runs them against the
 * sidecar's (`docs/specs/security-local.md` -> "Network policy").
 *
 * The network is observed at the Node layer (`test-outbound.ts`); the peer
 * link's Unix socket or named pipe is local and passes. Managed voice is driven
 * through this window's own host, gated by `burrowNetworkAllowed` as the router
 * wires it; VS Code has no updater, so none is driven. Real timers: the peer
 * link's contention runs on them, so the run waits on answers rather than
 * advancing a clock past the relay socket's backoff, which the sidecar suite
 * does.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectionsFor } from '../../lib/src/components/NetworkSettings';
import { hostOf } from '../../lib/src/components/remote-control-shared';
import { DEFAULT_RELAY_ORIGIN, HOSTED_VOICE_ORIGIN } from '../../lib/src/host/relay-origin';
import type { BurrowConsoleStatus } from '../../lib/src/host/remote/service-protocol';
import {
  ANYWHERE_ON,
  LOCAL_ON,
  RELAY_ON,
  SELF_HOST_RELAY_ORIGIN,
} from '../../lib/src/host/remote/test-burrow-link';
import {
  WEBVIEW_COMMANDS,
  listedHosts,
  mintTestNoiseStatic,
  recordOutbound,
  testEnrollment,
  type OutboundRecorder,
} from '../../lib/src/host/remote/test-outbound';
import { CLOUDFLARE_STUN_HOST } from '../../lib/src/remote/direct/ice-servers';
import type { NetworkPolicy } from '../../lib/src/remote/network-policy';
import { ENROLLMENT_KEY } from '../../lib/src/remote/burrow/store';
import { NETWORK_POLICY_KEY } from '../src/burrow-store';
import { MANAGED_VOICE_ID_KEY, MANAGED_VOICE_TOKEN_KEY } from '../src/managed-voice';
import type { ExtensionMessage } from '../src/message-types';
import { freshModule, removeDir, tempStorageDir, tick, waitFor } from './helpers';

type BurrowModule = typeof import('../src/burrow');
type LinkModule = typeof import('../src/peer-link');
type VoiceModule = typeof import('../src/managed-voice');

const relayBuild = vi.hoisted(() => ({ origin: 'https://relay.dormouse.sh', mode: 'hosted' as 'hosted' | 'self-host' }));
vi.mock('../../lib/src/host/relay-origin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/src/host/relay-origin')>()),
  bakedRelay: () => ({ ...relayBuild }),
}));

/** The installer's offer file is the one other thing read off the real disk. */
vi.mock('../../lib/src/host/remote/enroll-offer', async (importOriginal) => {
  const { SELF_HOST_RELAY_ORIGIN: origin } = await import('../../lib/src/host/remote/test-burrow-link');
  return {
    ...(await importOriginal<typeof import('../../lib/src/host/remote/enroll-offer')>()),
    readEnrollmentOffer: () => Promise.resolve({ origin, token: 'a'.repeat(64), mintedAt: '2026-08-31T00:00:00.000Z' }),
  };
});

/** Real time each case may take: CI is slower than a laptop, and these wait on answers. */
const CASE_TIMEOUT_MS = 60_000;

let noise: { privateKeyPkcs8: string; publicKey: string };
let dir: string;
let realTmp: string | undefined;
let net: OutboundRecorder;
let link: LinkModule | null;
let mod: BurrowModule | null;
let voice: VoiceModule | null;
let activation: { dispose(): void } | null;
let voiceActivation: { dispose(): void } | null;
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
  voice = null;
  activation = null;
  voiceActivation = null;
  net = recordOutbound();
});

afterEach(async () => {
  voiceActivation?.dispose();
  activation?.dispose();
  await link?.disposePeerLink();
  net.restore();
  if (realTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmp;
  await removeDir(dir);
});

/** The slice of `ExtensionContext` the store and the link read, in memory. */
function storageContext(secrets: Map<string, string>, global: Map<string, unknown>) {
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

function setBuild(mode: 'hosted' | 'self-host'): void {
  relayBuild.mode = mode;
  relayBuild.origin = mode === 'self-host' ? SELF_HOST_RELAY_ORIGIN : DEFAULT_RELAY_ORIGIN;
}

/** One window activated as VS Code activates it, with `secrets` and `global` as its storage. */
async function activate(secrets: Map<string, string>, global: Map<string, unknown>): Promise<void> {
  mod = await freshModule<BurrowModule>(() => import('../src/burrow'));
  link = await import('../src/peer-link');
  const context = storageContext(secrets, global);
  link.initPeerLink(context);
  mod.configureBurrow({
    brokerRequest: async () => [],
    broadcastToWebviews: (message) => void posted.push(message),
    writePty: () => {},
    resizePty: () => {},
    streamPty: () => ({ stop: () => {}, ready: Promise.resolve() }) as never,
  });
  activation = mod.initBurrow(context);
  voice = await import('../src/managed-voice');
  voice.configureManagedVoice({ broadcastStatus: () => {}, networkAllowed: mod.burrowNetworkAllowed });
  voiceActivation = voice.initManagedVoice(context);
}

/** A member's saved voice token, as an approval leaves it in `SecretStorage`. */
function saveVoiceToken(secrets: Map<string, string>): void {
  secrets.set(MANAGED_VOICE_TOKEN_KEY, `dmv_${'A'.repeat(43)}`);
  secrets.set(MANAGED_VOICE_ID_KEY, 'abc');
}

function send(cmd: string, params?: unknown): string {
  const burrowRequestId = `outbound-${++seq}`;
  mod!.handleBurrowCommand({ burrowRequestId, cmd, ...(params === undefined ? {} : { params }) });
  return burrowRequestId;
}

async function command(cmd: string, params?: unknown): Promise<{ result?: unknown; error?: string }> {
  const burrowRequestId = send(cmd, params);
  const find = () =>
    posted
      .filter((message) => message.type === 'burrow:result')
      .map((message) => (message as { payload: { burrowRequestId: string; result?: unknown; error?: string } }).payload)
      .find((payload) => payload.burrowRequestId === burrowRequestId);
  await waitFor(() => find() !== undefined, 15_000);
  return find()!;
}

/** {@link WEBVIEW_COMMANDS}, `oneTimeOpen`, and a managed-voice speak, then a moment for anything they started. */
async function exercise(): Promise<void> {
  for (const [cmd, params] of WEBVIEW_COMMANDS) await command(cmd, params);
  send('oneTimeOpen');
  await voice!.handleVoiceCommand({ op: 'speak', text: 'build finished' });
  await tick(300);
}

const SETUPS: Array<[string, (secrets: Map<string, string>, global: Map<string, unknown>) => void]> = [
  ['a fresh install', () => {}],
  ['an enrollment and a managed-voice token at Nowhere', (secrets, global) => {
    secrets.set(ENROLLMENT_KEY, JSON.stringify(testEnrollment(relayBuild.origin, noise)));
    saveVoiceToken(secrets);
    global.set(NETWORK_POLICY_KEY, { level: 'nothing', allowed: [], autoUpdate: true });
  }],
  ['an unreadable policy over an enrollment', (secrets, global) => {
    secrets.set(ENROLLMENT_KEY, JSON.stringify(testEnrollment(relayBuild.origin, noise)));
    saveVoiceToken(secrets);
    global.set(NETWORK_POLICY_KEY, { level: 'anywhere', allowed: 'everything' });
  }],
];

describe.each(['hosted', 'self-host'] as const)('a %s build, under Nowhere', (mode) => {
  it.each(SETUPS)('opens no connection with %s', async (_name, setup) => {
    setBuild(mode);
    const secrets = new Map<string, string>();
    const global = new Map<string, unknown>();
    setup(secrets, global);
    await activate(secrets, global);
    await exercise();

    expect(net.offMachine()).toEqual([]);
    expect(((await command('networkPolicy')).result as { policy: NetworkPolicy }).policy.level).toBe('nothing');
  }, CASE_TIMEOUT_MS);
});

describe('under every other level, exactly the listed connections', () => {
  it.each([
    ['hosted', LOCAL_ON],
    ['hosted', ANYWHERE_ON],
    ['self-host', RELAY_ON],
  ] as const)('a %s build at %j', async (mode, policy) => {
    setBuild(mode);
    const secrets = new Map([[ENROLLMENT_KEY, JSON.stringify(testEnrollment(relayBuild.origin, noise))]]);
    saveVoiceToken(secrets);
    const global = new Map<string, unknown>([[NETWORK_POLICY_KEY, { level: 'nothing', allowed: [], autoUpdate: false }]]);
    await activate(secrets, global);
    await command('status');
    expect(net.offMachine()).toEqual([]);

    expect((await command('setNetworkPolicy', { policy })).error).toBeUndefined();
    await exercise();

    const status = (await command('status')).result as BurrowConsoleStatus;
    const listed = listedHosts(connectionsFor({ policy, status, managedVoice: true, updater: false }));
    const contacted = net.hosts();
    for (const host of contacted) expect(listed).toContain(host);
    expect(contacted).toContain(hostOf(relayBuild.origin));
    if (mode === 'hosted') expect(contacted).toContain(hostOf(HOSTED_VOICE_ORIGIN));
    expect(contacted).not.toContain(CLOUDFLARE_STUN_HOST);
    expect(net.offMachine().filter((attempt) => !attempt.via.startsWith('globalThis.'))).toEqual([]);
  }, CASE_TIMEOUT_MS);
});
