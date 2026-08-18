/**
 * The cross-window link, driven end to end: two independent module instances
 * standing in for two VS Code windows, talking over a real socket in a temp
 * directory. The frames and the routing table are unit-tested in
 * `lib/src/lib/vscode-peer-link-protocol.test.ts`; this covers the parts that
 * only exist once there is a socket — the rendezvous handshake, role switching,
 * PTY routing, and what happens when a window goes away.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
        brokerDirectory: async () => this.entries,
        brokerSurfaceOp: async (surfaceId: string) => {
          const surface = this.surfaces[surfaceId];
          return surface ? { ok: true, ...surface } : { ok: false };
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
  vi.resetModules();
  const mod: LinkModule = await import('../src/peer-link');
  mod.initPeerLink({ globalStorageUri: { fsPath: dir }, subscriptions: [] } as never);
  mod.configurePeerLink(deps.deps());
  opened.push(mod);
  return mod;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for the peer link');
}

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
  await waitFor(async () => {
    try {
      await access(join(dir, 'remote-host.peer.json'));
      return true;
    } catch {
      return false;
    }
  });

  const peer = await openWindow(peerSide);
  peer.setPeerLinkRole(false);
  // The handshake is asynchronous; the first answered request proves it landed.
  await waitFor(async () => (await broker.remoteDirectory()).length > 0);
  return { broker, brokerSide, peer, peerSide };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dormouse-peer-'));
});

afterEach(async () => {
  for (const mod of opened) await mod.disposePeerLink();
  opened.length = 0;
  await rm(dir, { recursive: true, force: true });
});

describe('peer link between windows', () => {
  it('collects directory entries from the other window', async () => {
    const peerSide = fakeWindow({ entries: [{ surfaceId: 'far-1' }, { surfaceId: 'far-2' }] });
    const { broker } = await linkedPair(fakeWindow(), peerSide);

    expect(await broker.remoteDirectory()).toEqual([{ surfaceId: 'far-1' }, { surfaceId: 'far-2' }]);
  });

  it('returns nothing when no other window is connected', async () => {
    const broker = await openWindow(fakeWindow());
    broker.setPeerLinkRole(true);
    await waitFor(async () => {
      try {
        await access(join(dir, 'remote-host.peer.json'));
        return true;
      } catch {
        return false;
      }
    });
    expect(await broker.remoteDirectory()).toEqual([]);
  });

  it('drives a surface owned by the other window and remembers where it lives', async () => {
    const peerSide = fakeWindow({
      entries: [{ surfaceId: 'far-1' }],
      surfaces: { 'far-1': { ptyId: 'pty-far', cols: 100, rows: 30 } },
    });
    const { broker } = await linkedPair(fakeWindow(), peerSide);

    const result = await broker.remoteSurfaceOp('far-1', 'attach', 100, 30);
    expect(result).toEqual({ ok: true, ptyId: 'pty-far', cols: 100, rows: 30 });
    // Input and resizes have to reach that window afterwards.
    expect(broker.isRemotePty('pty-far')).toBe(true);
  });

  it('reports a surface nobody owns', async () => {
    const { broker } = await linkedPair(fakeWindow(), fakeWindow({ entries: [{ s: 1 }] }));
    expect(await broker.remoteSurfaceOp('nobody', 'attach', 80, 24)).toEqual({ ok: false });
    expect(broker.isRemotePty('nobody')).toBe(false);
  });

  it('streams a subscribed PTY from the owning window', async () => {
    const peerSide = fakeWindow({
      entries: [{ surfaceId: 'far-1' }],
      surfaces: { 'far-1': { ptyId: 'pty-far', cols: 80, rows: 24 } },
    });
    const { broker, brokerSide } = await linkedPair(fakeWindow(), peerSide);
    await broker.remoteSurfaceOp('far-1', 'attach', 80, 24);

    broker.remoteSubscribe('pty-far');
    await new Promise((resolve) => setTimeout(resolve, 50));
    peerSide.emitData('pty-far', 'output from the other window');

    await waitFor(() => brokerSide.delivered.length > 0);
    expect(brokerSide.delivered).toEqual([{ ptyId: 'pty-far', data: 'output from the other window' }]);
  });

  it('does not stream PTYs it never subscribed to', async () => {
    const peerSide = fakeWindow({
      entries: [{ surfaceId: 'far-1' }],
      surfaces: { 'far-1': { ptyId: 'pty-far', cols: 80, rows: 24 } },
    });
    const { broker, brokerSide } = await linkedPair(fakeWindow(), peerSide);
    await broker.remoteSurfaceOp('far-1', 'attach', 80, 24);

    peerSide.emitData('pty-other', 'not subscribed');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(brokerSide.delivered).toEqual([]);
  });

  it('stops the stream on unsubscribe', async () => {
    const peerSide = fakeWindow({
      entries: [{ surfaceId: 'far-1' }],
      surfaces: { 'far-1': { ptyId: 'pty-far', cols: 80, rows: 24 } },
    });
    const { broker, brokerSide } = await linkedPair(fakeWindow(), peerSide);
    await broker.remoteSurfaceOp('far-1', 'attach', 80, 24);
    broker.remoteSubscribe('pty-far');
    await new Promise((resolve) => setTimeout(resolve, 50));

    broker.remoteUnsubscribe('pty-far');
    await new Promise((resolve) => setTimeout(resolve, 50));
    peerSide.emitData('pty-far', 'after unsubscribe');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(brokerSide.delivered).toEqual([]);
    // Unsubscribing also forgets the route, so a later write is not misrouted.
    expect(broker.isRemotePty('pty-far')).toBe(false);
  });

  it('routes input and resize to the owning window', async () => {
    const peerSide = fakeWindow({
      entries: [{ surfaceId: 'far-1' }],
      surfaces: { 'far-1': { ptyId: 'pty-far', cols: 80, rows: 24 } },
    });
    const { broker } = await linkedPair(fakeWindow(), peerSide);
    await broker.remoteSurfaceOp('far-1', 'attach', 80, 24);

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
    const peerSide = fakeWindow({
      entries: [{ surfaceId: 'far-1' }],
      surfaces: { 'far-1': { ptyId: 'pty-far', cols: 80, rows: 24 } },
    });
    const { broker, brokerSide, peer } = await linkedPair(fakeWindow(), peerSide);
    await broker.remoteSurfaceOp('far-1', 'attach', 80, 24);
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
    await waitFor(async () => {
      try {
        await access(rendezvousPath);
        return true;
      } catch {
        return false;
      }
    });

    const { readFile } = await import('node:fs/promises');
    const { socketPath } = JSON.parse(await readFile(rendezvousPath, 'utf8'));
    const { createConnection } = await import('node:net');
    const socket = createConnection({ path: socketPath });
    await new Promise((resolve) => socket.on('connect', resolve));
    socket.write(`${JSON.stringify({ kind: 'hello', token: 'wrong' })}\n`);

    // The server drops it rather than answering anything.
    await new Promise((resolve) => socket.on('close', resolve));
    expect(await broker.remoteDirectory()).toEqual([]);
    socket.destroy();
  });
});
