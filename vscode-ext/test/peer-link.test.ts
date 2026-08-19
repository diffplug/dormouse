/**
 * Bind-as-lease, driven end to end: two independent module instances standing
 * in for two VS Code windows, contending for one socket in a temp directory.
 * The frames and the routing table are unit-tested in
 * `lib/src/lib/vscode-peer-link-protocol.test.ts`; this covers the parts that
 * only exist once there is a socket — who wins the bind, what a loser does when
 * the winner dies, PTY routing, and the token.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { fakeContext, freshModule, removeDir, tempStorageDir, tick, waitFor, waitForFile } from './helpers';

type LinkModule = typeof import('../src/peer-link');

let dir: string;
/** Peer sockets live in the temp dir; point that at this test's own storage. */
let realTmp: string | undefined;
const opened: LinkModule[] = [];

/** Records what a window was asked to do on its own terminals. */
function fakeWindow(options: {
  entries?: unknown[];
  surfaces?: Record<string, { ptyId: string; cols: number; rows: number }>;
} = {}) {
  const dataListeners = new Set<(id: string, data: string) => void>();
  const exitListeners = new Set<(id: string, exitCode: number) => void>();
  return {
    entries: options.entries ?? [],
    surfaces: options.surfaces ?? {},
    writes: [] as Array<{ ptyId: string; data: string }>,
    resizes: [] as Array<{ ptyId: string; cols: number; rows: number }>,
    invalidations: 0,
    emitData(id: string, data: string) {
      for (const listener of dataListeners) listener(id, data);
    },
    emitExit(id: string, exitCode: number) {
      for (const listener of exitListeners) listener(id, exitCode);
    },
    deps() {
      return {
        // One generic fan-out covers every peer operation; `op` is opaque to
        // the link, so the window answers zero or more results per request.
        brokerRequest: async (op: string, params: unknown) => {
          if (op === 'directory') return this.entries;
          const { surfaceId } = params as { surfaceId: string };
          const surface = this.surfaces[surfaceId];
          return surface ? [surface] : [];
        },
        invalidateDirectory: () => {
          this.invalidations += 1;
        },
        onProcessedPtyData: (listener: (id: string, data: string) => void) => {
          dataListeners.add(listener);
          return () => dataListeners.delete(listener);
        },
        onProcessedPtyExit: (listener: (id: string, exitCode: number) => void) => {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
        writePty: (ptyId: string, data: string) => void this.writes.push({ ptyId, data }),
        resizePty: (ptyId: string, cols: number, rows: number) =>
          void this.resizes.push({ ptyId, cols, rows }),
      };
    },
  };
}

/**
 * The one path every window of an installation contends for, mirroring
 * `socketPath()`. Duplicated here on purpose: a derivation that drifted would
 * silently give each window its own lease and its own Host.
 */
function derivedSocketPath(): string {
  const id = createHash('sha256').update(dir).digest('hex').slice(0, 12);
  return join(dir, `dormouse-peer-${id}.sock`);
}

async function openWindow(deps: ReturnType<typeof fakeWindow>): Promise<LinkModule> {
  const mod = await freshModule<LinkModule>(() => import('../src/peer-link'));
  mod.initPeerLink(fakeContext(dir));
  mod.configurePeerLink(deps.deps());
  opened.push(mod);
  return mod;
}

/** A sink standing in for whatever the broker streams a routed PTY into. */
function fakeSink() {
  return {
    data: [] as string[],
    exits: [] as number[],
    onData(chunk: string) {
      this.data.push(chunk);
    },
    onExit(code: number) {
      this.exits.push(code);
    },
  };
}

/** Attach to the terminal {@link farWindow} owns, which is what places its route. */
const attachFar = (broker: LinkModule) =>
  broker.remoteRequest('surfaceOp', { surfaceId: 'far-1', op: 'attach', cols: 80, rows: 24 });

/** A window owning one terminal, which is what most of these tests need. */
const farWindow = () =>
  fakeWindow({
    entries: [{ surfaceId: 'far-1' }],
    surfaces: { 'far-1': { ptyId: 'pty-far', cols: 80, rows: 24 } },
  });

/**
 * Start two windows in order and wait until they can actually talk. The second
 * always reports at least one entry, because an answered directory request is
 * how we detect the handshake landed.
 */
async function linkedPair(
  brokerSide = fakeWindow(),
  peerSide = fakeWindow({ entries: [{ surfaceId: 'far-default' }] }),
) {
  const brokerRoles: boolean[] = [];
  const broker = await openWindow(brokerSide);
  await broker.ensurePeerNet((held) => brokerRoles.push(held));
  expect(brokerRoles).toEqual([true]);

  const peerRoles: boolean[] = [];
  const peer = await openWindow(peerSide);
  await peer.ensurePeerNet((held) => peerRoles.push(held));
  // The loser is told nothing: a role only ever changes upward.
  expect(peerRoles).toEqual([]);

  await waitFor(async () => (await broker.remoteRequest('directory', {})).length > 0);
  return { broker, brokerSide, peer, peerSide, peerRoles };
}

beforeEach(async () => {
  dir = await tempStorageDir();
  realTmp = process.env.TMPDIR;
  process.env.TMPDIR = dir;
});

afterEach(async () => {
  // Clients first: disposing the broker while one is still live sends it back
  // into the contention, which would recreate files under `dir` as it is
  // removed.
  for (const mod of [...opened].reverse()) await mod.disposePeerLink();
  opened.length = 0;
  // Assigning `undefined` would set the literal string, and a Linux runner has
  // no TMPDIR to put back — which the *next* test's mkdtemp would wear.
  if (realTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmp;
  await removeDir(dir);
});

describe('bind-as-lease', () => {
  it('rejects when the peer socket cannot be bound', async () => {
    const mod = await openWindow(fakeWindow());
    const failingServer = createServer();

    await expect(mod.listenServer(failingServer, join(dir, 'missing', 'peer.sock')))
      .rejects.toHaveProperty('code');
  });

  it('makes the first window to bind the broker and the second a client', async () => {
    const { broker, peer } = await linkedPair();
    expect(broker.isPeerBroker()).toBe(true);
    expect(peer.isPeerBroker()).toBe(false);
  });

  it('is idempotent — a second call re-announces the role it already holds', async () => {
    const broker = await openWindow(fakeWindow());
    const roles: boolean[] = [];
    await broker.ensurePeerNet((held) => roles.push(held));
    await broker.ensurePeerNet((held) => roles.push(held));
    expect(roles).toEqual([true, true]);
  });

  it('takes over a socket whose broker died without unlinking it', async () => {
    const path = derivedSocketPath();
    // A killed process leaves the inode behind — `close()` would unlink it, so
    // the only way to produce this state is to not let the owner close.
    const corpse = spawn(process.execPath, [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(path)})`,
    ]);
    await waitForFile(path);
    corpse.kill('SIGKILL');
    await new Promise((resolve) => corpse.on('exit', resolve));
    // Still there, and nothing is listening on it.
    await expect(access(path)).resolves.toBeUndefined();

    const mod = await openWindow(fakeWindow());
    const roles: boolean[] = [];
    await mod.ensurePeerNet((held) => roles.push(held));

    expect(roles).toEqual([true]);
    expect(mod.isPeerBroker()).toBe(true);
  });

  it('collects directory entries from the other window', async () => {
    const peerSide = fakeWindow({ entries: [{ surfaceId: 'far-1' }, { surfaceId: 'far-2' }] });
    const { broker } = await linkedPair(fakeWindow(), peerSide);

    expect(await broker.remoteRequest('directory', {})).toEqual([
      { surfaceId: 'far-1' },
      { surfaceId: 'far-2' },
    ]);
  });

  it('invalidates the broker directory when a peer announces a change', async () => {
    const { brokerSide, peer } = await linkedPair();
    const before = brokerSide.invalidations;

    peer.remoteNotifyPeerChange('directory');

    await waitFor(() => brokerSide.invalidations > before);
  });

  it('returns nothing when no other window is connected', async () => {
    const broker = await openWindow(fakeWindow());
    await broker.ensurePeerNet(() => {});
    expect(await broker.remoteRequest('directory', {})).toEqual([]);
  });

  it('drives a surface owned by the other window and remembers where it lives', async () => {
    const peerSide = fakeWindow({
      entries: [{ surfaceId: 'far-1' }],
      surfaces: { 'far-1': { ptyId: 'pty-far', cols: 100, rows: 30 } },
    });
    const { broker } = await linkedPair(fakeWindow(), peerSide);

    const results = await broker.remoteRequest('surfaceOp', {
      surfaceId: 'far-1', op: 'attach', cols: 100, rows: 30,
    });
    expect(results).toEqual([{ ptyId: 'pty-far', cols: 100, rows: 30 }]);
    // Input and resizes have to reach that window afterwards.
    expect(broker.isRemotePty('pty-far')).toBe(true);
  });

  it('reports a surface nobody owns', async () => {
    const { broker } = await linkedPair(fakeWindow(), fakeWindow({ entries: [{ s: 1 }] }));
    // Nothing answered, which is the only "not mine" signal there is.
    expect(await broker.remoteRequest('surfaceOp', {
      surfaceId: 'nobody', op: 'attach', cols: 80, rows: 24,
    })).toEqual([]);
    expect(broker.isRemotePty('nobody')).toBe(false);
  });

  it('streams a subscribed PTY from the owning window', async () => {
    const peerSide = farWindow();
    const { broker } = await linkedPair(fakeWindow(), peerSide);
    await attachFar(broker);

    const sink = fakeSink();
    broker.remoteSubscribe('pty-far', sink);
    await tick();
    peerSide.emitData('pty-far', 'output from the other window');

    await waitFor(() => sink.data.length > 0);
    expect(sink.data).toEqual(['output from the other window']);
  });

  it('does not stream PTYs it never subscribed to', async () => {
    const peerSide = farWindow();
    const { broker } = await linkedPair(fakeWindow(), peerSide);
    await attachFar(broker);

    const sink = fakeSink();
    broker.remoteSubscribe('pty-far', sink);
    await tick();
    peerSide.emitData('pty-other', 'not subscribed');
    await tick(100);
    expect(sink.data).toEqual([]);
  });

  it('forwards a subscribed PTY exit and forgets its route', async () => {
    const peerSide = farWindow();
    const { broker } = await linkedPair(fakeWindow(), peerSide);
    await attachFar(broker);
    const sink = fakeSink();
    broker.remoteSubscribe('pty-far', sink);
    await tick();

    peerSide.emitExit('pty-far', 17);

    await waitFor(() => sink.exits.length > 0);
    expect(sink.exits).toEqual([17]);
    expect(broker.isRemotePty('pty-far')).toBe(false);
  });

  it('stops the stream on unsubscribe', async () => {
    const peerSide = farWindow();
    const { broker } = await linkedPair(fakeWindow(), peerSide);
    await attachFar(broker);
    const sink = fakeSink();
    broker.remoteSubscribe('pty-far', sink);
    await tick();

    broker.remoteUnsubscribe('pty-far');
    await tick();
    peerSide.emitData('pty-far', 'after unsubscribe');
    await tick(100);

    expect(sink.data).toEqual([]);
    // Unsubscribing also forgets the route, so a later write is not misrouted.
    expect(broker.isRemotePty('pty-far')).toBe(false);
  });

  it('routes input and resize to the owning window', async () => {
    const peerSide = farWindow();
    const { broker } = await linkedPair(fakeWindow(), peerSide);
    await attachFar(broker);

    expect(broker.remoteWrite('pty-far', 'ls\r')).toBe(true);
    expect(broker.remoteResize('pty-far', 120, 40)).toBe(true);

    await waitFor(() => peerSide.writes.length > 0 && peerSide.resizes.length > 0);
    expect(peerSide.writes).toEqual([{ ptyId: 'pty-far', data: 'ls\r' }]);
    expect(peerSide.resizes).toEqual([{ ptyId: 'pty-far', cols: 120, rows: 40 }]);
  });

  it('refuses to route a PTY it has never placed', async () => {
    const { broker } = await linkedPair();
    // False tells the caller to fall back to the local pty manager.
    expect(broker.remoteWrite('pty-local', 'x')).toBe(false);
    expect(broker.remoteResize('pty-local', 80, 24)).toBe(false);
  });

  it('reports terminals as exited when their window disconnects', async () => {
    const peerSide = farWindow();
    const { broker, peer } = await linkedPair(fakeWindow(), peerSide);
    await attachFar(broker);
    const sink = fakeSink();
    broker.remoteSubscribe('pty-far', sink);
    await tick();

    // The window was closed: its terminals are gone, and a later write must not
    // be posted into a dead socket.
    await peer.disposePeerLink();

    await waitFor(() => sink.exits.length > 0);
    expect(sink.exits).toEqual([0]);
    expect(broker.isRemotePty('pty-far')).toBe(false);
    expect(broker.remoteWrite('pty-far', 'x')).toBe(false);
  });

  it('hands the Host to a surviving window when the broker dies', async () => {
    const { broker, peer, peerRoles } = await linkedPair();

    // The broker window closed. Its socket closes with it, and every client
    // races to bind; there is exactly one, so it wins.
    await broker.disposePeerLink();

    await waitFor(() => peerRoles.length > 0, 10_000);
    expect(peerRoles).toEqual([true]);
    expect(peer.isPeerBroker()).toBe(true);
  });

  it('rejects a client that does not know the token', async () => {
    const brokerSide = fakeWindow();
    const broker = await openWindow(brokerSide);
    await broker.ensurePeerNet(() => {});

    // The socket path is derived from the storage location, so it is guessable;
    // the token in the 0600 file beside it is the only secret.
    expect((await readFile(join(dir, 'remote-host.peer-token'), 'utf8')).trim()).toBeTruthy();

    const socket = createConnection({ path: derivedSocketPath() });
    await new Promise((resolve) => socket.on('connect', resolve));
    socket.write(`${JSON.stringify({ kind: 'hello', token: 'wrong' })}\n`);

    // The server drops it rather than answering anything.
    await new Promise((resolve) => socket.on('close', resolve));
    expect(await broker.remoteRequest('directory', {})).toEqual([]);
    socket.destroy();
  });
});
