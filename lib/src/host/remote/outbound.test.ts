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

import { connectionsFor } from '../../components/NetworkSettings';
import { hostOf } from '../../components/remote-control-shared';
import { CLOUDFLARE_STUN_HOST } from '../../remote/direct/ice-servers';
import type { NetworkPolicy } from '../../remote/network-policy';
import { MANAGED_VOICE_FILE } from '../managed-voice-host';
import { DEFAULT_RELAY_ORIGIN, HOSTED_VOICE_ORIGIN } from '../relay-origin';
import { FileBurrowStateStore } from './burrow-state-store';
import type { BurrowConsoleStatus } from './service-protocol';
import type { SidecarHost } from './sidecar-entry';
import { ANYWHERE_ON, LOCAL_ON, RELAY_ON, SELF_HOST_RELAY_ORIGIN } from './test-burrow-link';
import {
  WEBVIEW_COMMANDS,
  listedHosts,
  mintTestNoiseStatic,
  recordOutbound,
  testEnrollment,
  type OutboundRecorder,
} from './test-outbound';

/** The build the host reads at its entry point; the runner has no esbuild define. */
const build = vi.hoisted(() => ({ origin: '', mode: 'hosted' as 'hosted' | 'self-host' }));
vi.mock('../relay-origin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../relay-origin')>()),
  bakedRelay: () => ({ ...build }),
}));

/** The installer's offer file is the one other thing read off the real disk. */
vi.mock('./enroll-offer', async (importOriginal) => {
  const { SELF_HOST_RELAY_ORIGIN: origin } = await import('./test-burrow-link');
  return {
    ...(await importOriginal<typeof import('./enroll-offer')>()),
    readEnrollmentOffer: () => Promise.resolve({ origin, token: 'a'.repeat(64), mintedAt: '2026-08-31T00:00:00.000Z' }),
  };
});

const VOICE_TOKEN = `dmv_${'A'.repeat(43)}`;
/** Real time a command may take to answer: the state store's file I/O is real, and CI is slow. */
const ANSWER_BUDGET_MS = 20_000;
/** Each case's real-time budget, past the defaults, for the same reason. */
const CASE_TIMEOUT_MS = 60_000;
/** Captured before any case fakes timers. */
const realSetTimeout = globalThis.setTimeout;

let noise: { privateKeyPkcs8: string; publicKey: string };
let dir: string;
let net: OutboundRecorder;
let host: SidecarHost | null;
let sent: Array<{ event: string; data: Record<string, unknown> }>;
let seq = 0;

beforeAll(async () => {
  noise = await mintTestNoiseStatic();
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'outbound-'));
  sent = [];
  host = null;
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

function setBuild(mode: 'hosted' | 'self-host'): void {
  build.mode = mode;
  build.origin = mode === 'self-host' ? SELF_HOST_RELAY_ORIGIN : DEFAULT_RELAY_ORIGIN;
}

async function enroll(): Promise<void> {
  await new FileBurrowStateStore(dir).saveEnrollment(testEnrollment(build.origin, noise));
  await writeFile(join(dir, MANAGED_VOICE_FILE), JSON.stringify({ token: VOICE_TOKEN, voiceId: 'abc' }));
}

async function writePolicy(policy: NetworkPolicy | string): Promise<void> {
  await writeFile(join(dir, 'network-policy.json'), typeof policy === 'string' ? policy : JSON.stringify(policy));
}

/**
 * A fresh host module graph per case: the direct-peer factory remembers a
 * refused load, and a teardown, for the life of its module, which would hide a
 * later case's load.
 */
async function boot(): Promise<void> {
  vi.resetModules();
  const { createSidecarHost } = await import('./sidecar-entry');
  host = createSidecarHost({
    send: (event, data) => void sent.push({ event, data: data as Record<string, unknown> }),
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
}

/** Let the I/O and every timer the host arms run, an hour of them. */
async function elapse(ms = 60 * 60_000): Promise<void> {
  for (let step = 0; step < 60; step += 1) await vi.advanceTimersByTimeAsync(ms / 60);
}

/**
 * The `event` the host sent whose `idKey` is `id`, advancing the fake clock
 * while real time lets the host's file I/O finish.
 */
async function awaitSent(event: string, idKey: string, id: string): Promise<Record<string, unknown>> {
  const deadline = performance.now() + ANSWER_BUDGET_MS;
  while (performance.now() < deadline) {
    const answer = sent.find((message) => message.event === event && message.data[idKey] === id);
    if (answer) return answer.data;
    await vi.advanceTimersByTimeAsync(50);
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  throw new Error(`no ${event} for ${id}`);
}

function send(cmd: string, params?: unknown): string {
  const burrowRequestId = `outbound-${++seq}`;
  host!.handleCommand('burrow:command', { burrowRequestId, cmd, ...(params === undefined ? {} : { params }) });
  return burrowRequestId;
}

/** One webview command, answered. */
async function command(cmd: string, params?: unknown): Promise<{ result?: unknown; error?: string }> {
  return awaitSent('burrow:result', 'burrowRequestId', send(cmd, params));
}

async function speak(): Promise<void> {
  const requestId = `voice-${++seq}`;
  host!.handleCommand('voice:command', { op: 'speak', text: 'build finished', requestId });
  await awaitSent('voice:result', 'requestId', requestId);
}

/** {@link WEBVIEW_COMMANDS}, `oneTimeOpen`, and a managed-voice speak, then an hour. */
async function exercise(): Promise<void> {
  for (const [cmd, params] of WEBVIEW_COMMANDS) await command(cmd, params);
  send('oneTimeOpen');
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
    setBuild(mode);
    await setup();
    await boot();
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
    await enroll();
    await writePolicy({ level: 'nothing', allowed: [], autoUpdate: false });
    await boot();
    await elapse(60_000);
    expect(net.offMachine()).toEqual([]);

    expect((await command('setNetworkPolicy', { policy })).error).toBeUndefined();
    await exercise();

    const status = (await command('status')).result as BurrowConsoleStatus;
    const listed = listedHosts(connectionsFor({ policy, status, managedVoice: true, updater: false }));
    const contacted = net.hosts();
    // Nothing unlisted…
    for (const contactedHost of contacted) expect(listed).toContain(contactedHost);
    // …and every listed host this test can drive was reached.
    expect(contacted).toContain(hostOf(build.origin));
    if (mode === 'hosted') expect(contacted).toContain(hostOf(HOSTED_VOICE_ORIGIN));
    // STUN is listed for when a phone connects, and no phone did.
    expect(contacted).not.toContain(CLOUDFLARE_STUN_HOST);
    // Every attempt went through the globals the service guards: nothing reached
    // a socket, a lookup, or the addon on its own.
    expect(net.offMachine().filter((attempt) => !attempt.via.startsWith('globalThis.'))).toEqual([]);
  }, CASE_TIMEOUT_MS);
});
