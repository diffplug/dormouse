// @vitest-environment node
/**
 * Settings → Network's promises, run against the real sidecar host: under
 * Nowhere Dormouse opens no connection on its own, and under every other level
 * it opens exactly what `connectionsFor` lists (`docs/specs/security-local.md`
 * -> "Network policy"). `vscode-ext/test/outbound.test.ts` runs the same
 * against the VS Code binding.
 *
 * Booted the way the sidecar boots it — `createSidecarHost`, with its
 * file-backed state, its real `BurrowService`, its managed-voice host, and its
 * native direct-peer factory — with nothing injected but the PTY manager. The
 * network is observed at the Node layer (`test-outbound.ts`), so a path that
 * skips the globals the service reaches for is still caught.
 *
 * Not driven here: the Cloudflare STUN row and the phone rows, which need a
 * phone's handshake through the relay (`one-time-runtime.test.ts`,
 * `direct-peering.test.ts`); and the updater, which lives in the Tauri webview
 * (`standalone/src/updater.test.ts`).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintNoiseStaticKeyPair } from 'remote-lib-common';

import { connectionsFor } from '../../components/NetworkSettings';
import type { BurrowEnrollment } from '../../remote/burrow/enrollment';
import type { NetworkPolicy } from '../../remote/network-policy';
import { MANAGED_VOICE_FILE } from '../managed-voice-host';
import { DEFAULT_RELAY_ORIGIN } from '../relay-origin';
import { FileBurrowStateStore } from './burrow-state-store';
import type { BurrowConsoleStatus } from './service-protocol';
import type { SidecarHost } from './sidecar-entry';
import { recordOutbound, type OutboundRecorder } from './test-outbound';

/** The build the host reads at its entry point; the runner has no esbuild define. */
const build = vi.hoisted(() => ({ origin: '', mode: 'hosted' as 'hosted' | 'self-host' }));
vi.mock('../relay-origin', async (importOriginal) => {
  const real = await importOriginal<typeof import('../relay-origin')>();
  return { ...real, bakedRelay: () => ({ origin: build.origin || real.DEFAULT_RELAY_ORIGIN, mode: build.mode }) };
});

/** The installer's offer file is the one other thing read off the real disk. */
vi.mock('./enroll-offer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./enroll-offer')>()),
  readEnrollmentOffer: () => Promise.resolve({
    origin: 'https://ned-mac.tail9c2f1.ts.net',
    token: 'a'.repeat(64),
    mintedAt: '2026-08-31T00:00:00.000Z',
  }),
}));

const SELF_HOST_ORIGIN = 'https://ned-mac.tail9c2f1.ts.net';
const VOICE_TOKEN = `dmv_${'A'.repeat(43)}`;
const LAN = '192.168.1.0/24';

let noise: { privateKeyPkcs8: string; publicKey: string };
let dir: string;
let net: OutboundRecorder;
let host: SidecarHost | null;
let sent: Array<{ event: string; data: unknown }>;
let seq = 0;

beforeAll(async () => {
  noise = await mintNoiseStaticKeyPair();
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'outbound-'));
  sent = [];
  host = null;
  build.origin = '';
  build.mode = 'hosted';
  net = recordOutbound();
  // Timers only: the state store's file I/O must still settle.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(async () => {
  host?.dispose();
  vi.useRealTimers();
  net.restore();
  await rm(dir, { recursive: true, force: true });
});

function origin(): string {
  return build.mode === 'self-host' ? SELF_HOST_ORIGIN : DEFAULT_RELAY_ORIGIN;
}

async function enroll(): Promise<void> {
  const relay = origin();
  const enrollment: BurrowEnrollment = {
    relayUrl: relay,
    burrowId: 'S6kyjjqOS7mw3l8ye89U3g',
    burrowToken: 'tok',
    origin: relay,
    rpId: new URL(relay).hostname,
    label: 'Laptop',
    noiseStaticPrivateKey: noise.privateKeyPkcs8,
    noiseStaticPublicKey: noise.publicKey,
  };
  await new FileBurrowStateStore(dir).saveEnrollment(enrollment);
  await writeFile(join(dir, MANAGED_VOICE_FILE), JSON.stringify({ token: VOICE_TOKEN, voiceId: 'abc' }));
}

async function writePolicy(policy: NetworkPolicy | string): Promise<void> {
  await writeFile(join(dir, 'network-policy.json'), typeof policy === 'string' ? policy : JSON.stringify(policy));
}

/**
 * A fresh host module graph per case: the direct-peer factory remembers a
 * refused load for the life of its module, which would hide a later case's.
 */
async function boot(): Promise<SidecarHost> {
  vi.resetModules();
  const { createSidecarHost } = await import('./sidecar-entry');
  host = createSidecarHost({
    send: (event, data) => void sent.push({ event, data }),
    mgr: {
      write: () => {},
      resize: () => {},
      hasPty: () => false,
      spawn: () => {},
      kill: () => {},
      gracefulKill: () => {},
      list: () => {},
    },
    stateDir: dir,
  });
  return host;
}

/** Let the I/O and every timer the host arms run, an hour of them. */
async function elapse(ms = 60 * 60_000): Promise<void> {
  for (let step = 0; step < 60; step += 1) await vi.advanceTimersByTimeAsync(ms / 60);
}

/** One webview command, answered. */
async function command(cmd: string, params?: unknown): Promise<{ result?: unknown; error?: string }> {
  const burrowRequestId = `outbound-${++seq}`;
  host!.handleCommand('burrow:command', { burrowRequestId, cmd, ...(params === undefined ? {} : { params }) });
  for (let i = 0; i < 200; i += 1) {
    const answer = sent.find(
      (message) => message.event === 'burrow:result' && (message.data as { burrowRequestId?: string }).burrowRequestId === burrowRequestId,
    );
    if (answer) return answer.data as { result?: unknown; error?: string };
    await vi.advanceTimersByTimeAsync(50);
  }
  throw new Error(`no answer to ${cmd}`);
}

async function speak(): Promise<unknown> {
  const requestId = `voice-${++seq}`;
  host!.handleCommand('voice:command', { op: 'speak', text: 'build finished', requestId });
  for (let i = 0; i < 200; i += 1) {
    const answer = sent.find(
      (message) => message.event === 'voice:result' && (message.data as { requestId?: string }).requestId === requestId,
    );
    if (answer) return (answer.data as { result?: unknown }).result;
    await vi.advanceTimersByTimeAsync(50);
  }
  throw new Error('no answer to speak');
}

/** Every request the webview sends at startup and when Settings opens, and each one a click sends. */
async function exercise(): Promise<void> {
  for (const cmd of ['networkPolicy', 'status', 'oneTimeStatus', 'pairingQueue', 'pushDevices', 'pushTest', 'setupQr', 'reconnect']) {
    await command(cmd);
  }
  await command('enroll', { password: 'p'.repeat(32), label: 'Laptop' });
  await command('enrollOffer', { label: 'Laptop' });
  await command('beginHostedEnrollment', { label: 'Laptop' });
  await command('oneTimeOpen');
  await speak();
  await elapse();
}

const SETUPS: Array<[string, () => Promise<void>]> = [
  ['a fresh install', async () => {}],
  ['an enrollment and a managed-voice token at Nowhere', async () => {
    await enroll();
    await writePolicy({ level: 'nothing', allowed: [], autoUpdate: true });
  }],
  ['an unparseable policy file over an enrollment', async () => {
    await enroll();
    await writePolicy('{ "level": "anywhere", ');
  }],
];

describe.each(['hosted', 'self-host'] as const)('a %s build, under Nowhere', (mode) => {
  it.each(SETUPS)('opens no connection with %s', async (_name, setup) => {
    build.mode = mode;
    build.origin = mode === 'self-host' ? SELF_HOST_ORIGIN : '';
    await setup();
    await boot();
    await exercise();

    expect(net.offMachine()).toEqual([]);
    const policy = (await command('networkPolicy')).result as { policy: NetworkPolicy };
    expect(policy.policy.level).toBe('nothing');
    // The stored-but-unoffered or unparseable record stays as it was.
  });
});

/** Every host a `connectionsFor` row names, from its `to`. */
function listedHosts(rows: ReturnType<typeof connectionsFor>): Set<string> {
  const hosts = new Set<string>();
  for (const row of rows) {
    const first = row.to.split(/\s/)[0]!;
    if (/^[\w-]+(?:\.[\w-]+)+$/.test(first)) hosts.add(first);
  }
  return hosts;
}

describe('under every other level, exactly the listed connections', () => {
  const LEVELS: Array<['hosted' | 'self-host', NetworkPolicy]> = [
    ['hosted', { level: 'local', allowed: [LAN], autoUpdate: false }],
    ['hosted', { level: 'anywhere', allowed: [], autoUpdate: false }],
    ['self-host', { level: 'relay', allowed: [], autoUpdate: false }],
  ];

  it.each(LEVELS)('a %s build at %j', async (mode, policy) => {
    build.mode = mode;
    build.origin = mode === 'self-host' ? SELF_HOST_ORIGIN : '';
    await enroll();
    await writePolicy({ level: 'nothing', allowed: [], autoUpdate: false });
    await boot();
    await elapse(60_000);
    expect(net.offMachine()).toEqual([]);

    expect((await command('setNetworkPolicy', { policy })).error).toBeUndefined();
    await exercise();

    const status = (await command('status')).result as BurrowConsoleStatus;
    const rows = connectionsFor({ policy, status, managedVoice: true, updater: false });
    const listed = listedHosts(rows);
    const contacted = net.hosts();
    // Nothing unlisted…
    for (const contactedHost of contacted) expect(listed).toContain(contactedHost);
    // …and every listed host this test can drive was reached.
    const relay = new URL(origin()).hostname;
    expect(contacted).toContain(relay);
    if (mode === 'hosted') expect(contacted).toContain('voice.dormouse.sh');
    // STUN is listed for when a phone connects, and no phone did.
    expect(contacted).not.toContain('stun.cloudflare.com');
    // Every attempt went through the globals the service guards: nothing reached
    // a socket, a lookup, or the addon on its own.
    expect(net.offMachine().filter((attempt) => !attempt.via.startsWith('globalThis.'))).toEqual([]);
  });
});
