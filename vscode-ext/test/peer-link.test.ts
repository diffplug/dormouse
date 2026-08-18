/**
 * The cross-window link, driven end to end: two independent module instances
 * standing in for two VS Code windows, talking over a real socket in a temp
 * directory. The frames and the routing table are unit-tested in
 * `lib/src/lib/vscode-peer-link-protocol.test.ts`; this covers the parts that
 * only exist once there is a socket — the rendezvous handshake, role switching,
 * PTY routing, and what happens when a window goes away.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fakeContext, freshModule, removeDir, tempStorageDir, tick, waitFor, waitForFile } from './helpers';

type LinkModule = typeof import('../src/peer-link');

let dir: string;
const opened: LinkModule[] = [];

/** Records what a window was asked to do on its own terminals. */
function fakeWindow(options: {
  entries?: unknown[];
  surfaces?: Record<string, { ptyId: string; cols: number; rows: number }>;
} = {}) {
  const dataListeners = new Set<(id: string, data: string) => void>();
  return {
    entries: options.entries ?? [],
    surfaces: options.surfaces ?? {},
    writes: [] as Array<{ ptyId: string; data: string }>,
    resizes: [] as Array<{ ptyId: string; cols: number; rows: number }>,
    delivered: [] as Array<{ ptyId: string; data: string }>,
    exits: [] as Array<{ ptyId: string; exitCode: number }>,
    emitData(id: string, data: string) {
      for (const listener of dataListeners) listener(id, data);
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
        deliverRemotePtyData: (ptyId: string, data: string) =>
          void this.delivered.push({ ptyId, data }),
        deliverRemotePtyExit: (ptyId: string, exitCode: number) =>
          void this.exits.push({ ptyId, exitCode }),
        onProcessedPtyData: (listener: (id: string, data: string) => void) => {
          dataListeners.add(listener);
          return () => dataListeners.delete(listener);
        },
        writePty: (ptyId: string, data: string) => void this.writes.push({ ptyId, data }),
        resizePty: (ptyId: string, cols: number, rows: number) =>
          void this.resizes.push({ ptyId, cols, rows }),
      };
    },
  };
}

async function openWindow(deps: ReturnType<typeof fakeWindow>): Promise<LinkModule> {
  const mod = await freshModule<LinkModule>(() => import('../src/peer-link'));
  mod.initPeerLink(fakeContext(dir));
  mod.configurePeerLink(deps.deps());
  opened.push(mod);
  return mod;
}

const waitForRendezvous = () => waitForFile(join(dir, 'remote-host.peer.json'));

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
 * Start a broker and a peer, and wait until they can actually talk. The peer
 * always reports at least one entry, because an answered directory request is
 * how we detect the handshake landed.
 */
async function linkedPair(
  brokerSide = fakeWindow(),
  peerSide = fakeWindow({ entries: [{ surfaceId: 'far-default' }] }),
) {
  const broker = await openWindow(brokerSide);
  broker.setPeerLinkRole(true);
  await waitForRendezvous();

  const peer = await openWindow(peerSide);
  peer.setPeerLinkRole(false);
  // The handshake is asynchronous; the first answered request proves it landed.
  await waitFor(async () => (await broker.remoteRequest('directory', {})).length > 0);
  return { broker, brokerSide, peer, peerSide };
}

beforeEach(async () => {
  dir = await tempStorageDir();
});

afterEach(async () => {
  for (const mod of opened) await mod.disposePeerLink();
  opened.length = 0;
  await removeDir(dir);
});

describe('peer link between windows', () => {
  it('collects directory entries from the other window', async () => {
    const peerSide = fakeWindow({ entries: [{ surfaceId: 'far-1' }, { surfaceId: 'far-2' }] });
    const { broker } = await linkedPair(fakeWindow(), peerSide);

    expect(await broker.remoteRequest('directory', {})).toEqual([
      { surfaceId: 'far-1' },
      { surfaceId: 'far-2' },
    ]);
  });

  it('returns nothing when no other window is connected', async () => {
    const broker = await openWindow(fakeWindow());
    broker.setPeerLinkRole(true);
    await waitForRendezvous();
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
    const { broker, brokerSide } = await linkedPair(fakeWindow(), peerSide);
    await attachFar(broker);

    broker.remoteSubscribe('pty-far');
    await tick();
    peerSide.emitData('pty-far', 'output from the other window');

    await waitFor(() => brokerSide.delivered.length > 0);
    expect(brokerSide.delivered).toEqual([{ ptyId: 'pty-far', data: 'output from the other window' }]);
  });

  it('does not stream PTYs it never subscribed to', async () => {
    const peerSide = farWindow();
    const { broker, brokerSide } = await linkedPair(fakeWindow(), peerSide);
    await attachFar(broker);

    peerSide.emitData('pty-other', 'not subscribed');
    await tick(100);
    expect(brokerSide.delivered).toEqual([]);
  });

  it('stops the stream on unsubscribe', async () => {
    const peerSide = farWindow();
    const { broker, brokerSide } = await linkedPair(fakeWindow(), peerSide);
    await attachFar(broker);
    broker.remoteSubscribe('pty-far');
    await tick();

    broker.remoteUnsubscribe('pty-far');
    await tick();
    peerSide.emitData('pty-far', 'after unsubscribe');
    await tick(100);

    expect(brokerSide.delivered).toEqual([]);
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
    const { broker, brokerSide, peer } = await linkedPair(fakeWindow(), peerSide);
    await attachFar(broker);
    expect(broker.isRemotePty('pty-far')).toBe(true);

    // The window was closed: its terminals are gone, and a later write must not
    // be posted into a dead socket.
    await peer.disposePeerLink();

    await waitFor(() => brokerSide.exits.length > 0);
    expect(brokerSide.exits).toEqual([{ ptyId: 'pty-far', exitCode: 0 }]);
    expect(broker.isRemotePty('pty-far')).toBe(false);
    expect(broker.remoteWrite('pty-far', 'x')).toBe(false);
  });

  it('rejects a client that does not know the token', async () => {
    const brokerSide = fakeWindow();
    const broker = await openWindow(brokerSide);
    broker.setPeerLinkRole(true);
    const rendezvousPath = join(dir, 'remote-host.peer.json');
    await waitForRendezvous();

    const { readFile } = await import('node:fs/promises');
    const { socketPath } = JSON.parse(await readFile(rendezvousPath, 'utf8'));
    const { createConnection } = await import('node:net');
    const socket = createConnection({ path: socketPath });
    await new Promise((resolve) => socket.on('connect', resolve));
    socket.write(`${JSON.stringify({ kind: 'hello', token: 'wrong' })}\n`);

    // The server drops it rather than answering anything.
    await new Promise((resolve) => socket.on('close', resolve));
    expect(await broker.remoteRequest('directory', {})).toEqual([]);
    socket.destroy();
  });
});
