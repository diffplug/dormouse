/**
 * Bind-as-lease, driven end to end: two independent module instances standing
 * in for two VS Code windows, contending for one socket in a temp directory.
 * The frames and the routing table are unit-tested in
 * `peer-link-protocol.test.ts`; this covers the parts that
 * only exist once there is a socket — who wins the bind, what a loser does when
 * the winner dies, PTY routing, and the token.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { access, chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, createServer, Socket, type Server } from 'node:net';
import { dirname, join } from 'node:path';
import {
  FrameDecoder,
  PEER_CLIENT_PROOF_DOMAIN,
  PEER_SERVER_PROOF_DOMAIN,
  encodeFrame,
} from '../src/peer-link-protocol';
import {
  derivedSocketPath as socketPathFor,
  fakeContext,
  fakeSink,
  fakeWindow,
  freshModule,
  removeDir,
  tempStorageDir,
  tick,
  waitFor,
  waitForFile,
} from './helpers';

type LinkModule = typeof import('../src/peer-link');

let dir: string;
/** Peer sockets live in the temp dir; point that at this test's own storage. */
let realTmp: string | undefined;
const opened: LinkModule[] = [];

const derivedSocketPath = (): string => socketPathFor(dir);

/** The token the whole installation shares, as it sits on disk. */
const readToken = async (): Promise<string> =>
  (await readFile(join(dir, 'remote-host.peer-token'), 'utf8')).trim();

const proof = (token: string, domain: string, nonce: string): string =>
  createHmac('sha256', token).update(domain + nonce).digest('base64url');

async function openWindow(deps: ReturnType<typeof fakeWindow>): Promise<LinkModule> {
  const mod = await freshModule<LinkModule>(() => import('../src/peer-link'));
  mod.initPeerLink(fakeContext(dir));
  mod.configurePeerLink(deps.deps());
  opened.push(mod);
  return mod;
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

  it('logs an accept-time server error instead of taking the extension host down', async () => {
    // Past `listen`, an EMFILE or a pipe error arrives as an `'error'` event on
    // the server. An EventEmitter with no listener for that *throws*, out of a
    // libuv callback with nothing to catch it.
    const mod = await openWindow(fakeWindow());
    const server = createServer();
    const path = join(dir, 'accept-error.sock');
    await mod.listenServer(server, path);
    try {
      expect(() => server.emit('error', Object.assign(new Error('EMFILE'), { code: 'EMFILE' })))
        .not.toThrow();
      // And it is still listening: connections already accepted, and the ones
      // still to come, are unaffected.
      const socket = createConnection({ path });
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('error', reject);
      });
      socket.destroy();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('does not route a PTY id this window already owns to the peer that claimed it', async () => {
    // Pane ids are unique within a window and nothing coordinates them across
    // windows — "Duplicate Workspace in New Window" cold-restores the same ids
    // — so a peer can answer an attach naming a terminal *this* window owns.
    // Routing on that sends the phone's keystrokes into the other window's
    // shell instead of the one it attached to.
    const brokerSide = fakeWindow({ ownPtyIds: ['pty-far'] });
    const { broker } = await linkedPair(brokerSide, farWindow());

    expect(await attachFar(broker)).toEqual([{ ptyId: 'pty-far', cols: 80, rows: 24 }]);
    // No route, so writes fall back to this window's own manager.
    expect(broker.isRemotePty('pty-far')).toBe(false);
    expect(broker.remoteWrite('pty-far', 'ls\r')).toBe(false);
    await tick(100);
    expect(brokerSide.writes).toEqual([]);
  });

  it('settles what a dropping window was asked rather than holding the whole collection', async () => {
    // A directory or an attach every surviving window already answered must not
    // wait out `PEER_REPLY_BUDGET_MS` behind a window that is already gone.
    const stuckSide = fakeWindow({ entries: [{ surfaceId: 'stuck-1' }] });
    let releaseStuck: () => void = () => {};
    const stuck = new Promise<void>((resolve) => {
      releaseStuck = resolve;
    });
    const stuckDeps = stuckSide.deps();
    stuckDeps.brokerRequest = async () => {
      await stuck;
      return stuckSide.entries;
    };

    const broker = await openWindow(fakeWindow());
    await broker.ensurePeerNet(() => {});
    const answering = await openWindow(fakeWindow({ entries: [{ surfaceId: 'live-1' }] }));
    await answering.ensurePeerNet(() => {});
    const stuckLink = await freshModule<LinkModule>(() => import('../src/peer-link'));
    stuckLink.initPeerLink(fakeContext(dir));
    stuckLink.configurePeerLink(stuckDeps);
    opened.push(stuckLink);
    await stuckLink.ensurePeerNet(() => {});

    const started = Date.now();
    const collecting = broker.remoteRequest('directory', {});
    await tick();
    await stuckLink.disposePeerLink();

    expect(await collecting).toEqual([{ surfaceId: 'live-1' }]);
    // Well inside `PEER_REPLY_BUDGET_MS`, which is what it used to spend.
    expect(Date.now() - started).toBeLessThan(2_000);
    releaseStuck();
  }, 15_000);

  it('does not answer broker while a reclaimed bind is still unverified', async () => {
    // `stillOurs` spends 250 ms watching for a window that cleared the same
    // corpse and bound after us. An enroll landing inside that window used to
    // see a bound socket, start a service, and the stand-down path
    // (`closeServer(false)`) never tears one down — two Hosts under one hostId.
    const path = derivedSocketPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const corpse = spawn(process.execPath, [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(path)})`,
    ]);
    await waitForFile(path);
    corpse.kill('SIGKILL');
    await new Promise((resolve) => corpse.on('exit', resolve));
    const dead = (await stat(path)).ino;

    const mod = await openWindow(fakeWindow());
    const roles: boolean[] = [];
    const settled = mod.ensurePeerNet((held) => roles.push(held));

    // The instant the path names a new inode this window has bound it — and is
    // still deciding whether it may keep it.
    const during: boolean[] = [];
    let brokerDuring = true;
    let settledDuring = true;
    await waitFor(async () => {
      const now = await stat(path).catch(() => null);
      if (!now || now.ino === dead) return false;
      void mod.ensurePeerNet((held) => during.push(held));
      brokerDuring = mod.isPeerBroker();
      settledDuring = mod.isPeerLinkSettled();
      return true;
    }, 15_000);

    expect(during).toEqual([]);
    expect(brokerDuring).toBe(false);
    // So a command arriving now is held for the verdict rather than refused.
    expect(settledDuring).toBe(false);

    await settled;
    expect(mod.isPeerBroker()).toBe(true);
    // Announced exactly once, to whoever asked last.
    expect(roles.concat(during)).toEqual([true]);
  }, 30_000);

  it('stands down for good when the shared token can be neither read nor written', async () => {
    // An unwritable `globalStorageUri` is not transient. Retrying at 1 Hz
    // forever leaves every command waiting out its whole queue budget on every
    // attempt instead of being told there is nothing to reach.
    await mkdir(join(dir, 'remote-host.peer-token'), { recursive: true });

    const mod = await openWindow(fakeWindow());
    const roles: boolean[] = [];
    await mod.ensurePeerNet((held) => roles.push(held));

    expect(roles).toEqual([]);
    expect(mod.isPeerBroker()).toBe(false);
    // Latched: a later caller is answered immediately rather than restarting it.
    expect(mod.isPeerLinkSettled()).toBe(true);
    await mod.ensurePeerNet(() => {});
    expect(mod.isPeerBroker()).toBe(false);
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
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
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

  it('re-binds when the socket it reclaimed is unlinked out from under it', async () => {
    // Two windows can clear the same corpse and the second bind displaces the
    // first without any error — the loser keeps serving an inode no client can
    // reach. On unix a path that has *gone* after our bind is the same failure,
    // and reading it as "still ours" leaves a broker nobody can dial.
    const path = derivedSocketPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const corpse = spawn(process.execPath, [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(path)})`,
    ]);
    await waitForFile(path);
    corpse.kill('SIGKILL');
    await new Promise((resolve) => corpse.on('exit', resolve));
    const dead = (await stat(path)).ino;

    const mod = await openWindow(fakeWindow());
    const settled = mod.ensurePeerNet(() => {});
    // Stand in for the competing reclaim: take the path away the moment this
    // window has bound it, inside its own verification window.
    void (async () => {
      for (let i = 0; i < 2000; i++) {
        const now = await stat(path).catch(() => null);
        if (now && now.ino !== dead) {
          await rm(path, { force: true });
          return;
        }
        await tick(5);
      }
    })();
    await settled;

    // It bound again rather than settling on a path that no longer names it.
    expect(mod.isPeerBroker()).toBe(true);
    await expect(access(path)).resolves.toBeUndefined();
    // Which is the property that matters: another window can actually reach it.
    const peer = await openWindow(fakeWindow({ entries: [{ surfaceId: 'far-1' }] }));
    await peer.ensurePeerNet(() => {});
    expect(peer.isPeerBroker()).toBe(false);
  }, 30_000);

  it('settles two windows racing for one corpse into a broker and a client', async () => {
    // Both find the same dead socket, both may unlink it, and the second bind
    // silently displaces the first. Whoever loses that has to notice and stand
    // down rather than serve an inode nobody can reach — and must then end up a
    // client, not wedged.
    const path = derivedSocketPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const corpse = spawn(process.execPath, [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(path)})`,
    ]);
    await waitForFile(path);
    corpse.kill('SIGKILL');
    await new Promise((resolve) => corpse.on('exit', resolve));

    const first = await openWindow(fakeWindow());
    const second = await openWindow(fakeWindow());
    const firstRoles: boolean[] = [];
    const secondRoles: boolean[] = [];
    await Promise.all([
      first.ensurePeerNet((held) => firstRoles.push(held)),
      second.ensurePeerNet((held) => secondRoles.push(held)),
    ]);

    const brokers = [first, second].filter((mod) => mod.isPeerBroker());
    expect(brokers).toHaveLength(1);
    // And the loser reached the broker rather than giving up: it can forward.
    const loser = [first, second].find((mod) => !mod.isPeerBroker())!;
    await waitFor(() => loser.forwardCommand({ rhId: 'rh-1', cmd: 'status' }), 15_000);
    expect(firstRoles.concat(secondRoles)).toEqual([true]);
  }, 30_000);

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

    peer.remoteNotifyPeerChange();

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

  it('fails closed when the owner route disappears before subscription', async () => {
    const peerSide = farWindow();
    const { broker, peer } = await linkedPair(fakeWindow(), peerSide);
    await attachFar(broker);

    await peer.disposePeerLink();
    await waitFor(() => !broker.isRemotePty('pty-far'));

    const sink = fakeSink();
    await broker.remoteSubscribe('pty-far', sink);
    expect(sink.exits).toEqual([0]);
  });

  it('replays an exit that preceded the cross-window subscription', async () => {
    const peerSide = farWindow();
    const { broker } = await linkedPair(fakeWindow(), peerSide);

    // The pane remains resolvable after its process exits. No forwarding sink
    // exists yet, so the owner's durable liveness record must bridge the gap.
    peerSide.emitExit('pty-far', 23);
    await attachFar(broker);
    const first = fakeSink();
    const firstOrder: string[] = [];
    const firstReady = broker
      .remoteSubscribe('pty-far', {
        ...first,
        onExit: (code) => {
          first.exits.push(code);
          firstOrder.push('exit');
        },
      })
      .then(() => void firstOrder.push('ready'));

    await firstReady;
    expect(first.exits).toEqual([23]);
    // The owner writes replay before acknowledgement on one ordered socket.
    // RemoteApiSession waits on readiness, so this order prevents an attach-ok
    // from overtaking the already-recorded close.
    expect(firstOrder).toEqual(['exit', 'ready']);
    expect(broker.isRemotePty('pty-far')).toBe(false);

    // A synchronous replay must not leave a spent forwarding entry on the
    // owner, or the next resolve would be routed but its subscribe ignored.
    await attachFar(broker);
    const second = fakeSink();
    await broker.remoteSubscribe('pty-far', second);
    expect(second.exits).toEqual([23]);
  });

  it('stops the stream on unsubscribe but keeps the route', async () => {
    const peerSide = farWindow();
    const { broker } = await linkedPair(fakeWindow(), peerSide);
    await attachFar(broker);
    const sink = fakeSink();
    broker.remoteSubscribe('pty-far', sink);
    await tick();

    broker.remoteUnsubscribe('pty-far', sink);
    await tick();
    peerSide.emitData('pty-far', 'after unsubscribe');
    await tick(100);
    expect(sink.data).toEqual([]);

    // The route stays: "nobody is watching it" is not "it moved". Re-attaching
    // an already-attached surface places the new route *before* the old
    // attachment is torn down, so dropping it here would delete the fresh one.
    expect(broker.isRemotePty('pty-far')).toBe(true);

    // And a second attach streams again over the route that was never lost.
    const again = fakeSink();
    broker.remoteSubscribe('pty-far', again);
    await tick();
    peerSide.emitData('pty-far', 'flowing again');
    await waitFor(() => again.data.length > 0);
    expect(again.data).toEqual(['flowing again']);
  });

  it('keeps serving a surface that is re-attached while still attached', async () => {
    // Attach-over-attach: the new route is placed by the resolve, and only then
    // does the old attachment's teardown unsubscribe. The route must survive
    // that teardown or every later write goes nowhere.
    const peerSide = farWindow();
    const { broker } = await linkedPair(fakeWindow(), peerSide);
    await attachFar(broker);
    const first = fakeSink();
    broker.remoteSubscribe('pty-far', first);
    await tick();

    // The order `RemoteApiSession` actually uses: the resolve re-places the
    // route, then the *old* attachment is torn down, then the new one
    // subscribes. A teardown that dropped the route would leave that last
    // subscribe with nowhere to send.
    await attachFar(broker);
    const second = fakeSink();
    broker.remoteUnsubscribe('pty-far', first);
    broker.remoteSubscribe('pty-far', second);
    await tick();

    expect(broker.isRemotePty('pty-far')).toBe(true);
    expect(broker.remoteWrite('pty-far', 'ls\r')).toBe(true);
    peerSide.emitData('pty-far', 'still here');
    await waitFor(() => second.data.length > 0);
    expect(second.data).toEqual(['still here']);
  });

  it('keeps a second viewer streaming when the first detaches', async () => {
    const peerSide = farWindow();
    const { broker } = await linkedPair(fakeWindow(), peerSide);
    await attachFar(broker);
    const first = fakeSink();
    const second = fakeSink();
    broker.remoteSubscribe('pty-far', first);
    broker.remoteSubscribe('pty-far', second);
    await tick();

    // One detach must not stop the shared stream or drop the route.
    broker.remoteUnsubscribe('pty-far', first);
    await tick();
    peerSide.emitData('pty-far', 'still flowing');

    await waitFor(() => second.data.length > 0);
    expect(second.data).toEqual(['still flowing']);
    expect(first.data).toEqual([]);
    expect(broker.isRemotePty('pty-far')).toBe(true);
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

  it('is unsettled the instant its broker socket dies, before the close lands', async () => {
    // `close` is a later tick. In between, this window has a socket it cannot
    // write to and no contention running — so reporting a role would make
    // `remote-host.ts` refuse a command it should have held for the re-bind.
    const connected: Socket[] = [];
    const connect = Socket.prototype.connect;
    const spy = vi
      .spyOn(Socket.prototype, 'connect')
      .mockImplementation(function (this: Socket, ...args: Parameters<typeof connect>) {
        connected.push(this);
        return connect.apply(this, args);
      });
    let peer: LinkModule;
    try {
      ({ peer } = await linkedPair());
    } finally {
      spy.mockRestore();
    }

    expect(peer.isPeerLinkSettled()).toBe(true);
    connected.at(-1)!.destroy();

    expect(peer.forwardCommand({ rhId: 'rh-1', cmd: 'status' })).toBe(false);
    expect(peer.isPeerLinkSettled()).toBe(false);
  });

  it('does not send an old broker’s delayed answer to its replacement', async () => {
    const token = 'test-peer-token';
    await writeFile(join(dir, 'remote-host.peer-token'), token, { mode: 0o600 });

    async function rawBroker(challenge: string) {
      let activeSocket: import('node:net').Socket | null = null;
      let accept!: (socket: import('node:net').Socket) => void;
      const connected = new Promise<import('node:net').Socket>((resolve) => {
        accept = resolve;
      });
      const frames: Array<Record<string, unknown>> = [];
      const server = createServer((socket) => {
        const decoder = new FrameDecoder();
        let authenticated = false;
        activeSocket = socket;
        socket.setEncoding('utf8');
        socket.write(encodeFrame({ kind: 'challenge', nonce: challenge }));
        socket.on('data', (chunk: string) => {
          for (const frame of decoder.push(chunk)) {
            const message = frame as Record<string, unknown>;
            if (!authenticated) {
              expect(message.kind).toBe('hello');
              authenticated = true;
              socket.write(
                encodeFrame({
                  kind: 'welcome',
                  proof: proof(token, PEER_SERVER_PROOF_DOMAIN, String(message.nonce)),
                }),
              );
              accept(socket);
            } else {
              frames.push(message);
            }
          }
        });
      });
      await mkdir(dirname(derivedSocketPath()), { recursive: true, mode: 0o700 });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(derivedSocketPath(), () => {
          server.off('error', reject);
          resolve();
        });
      });
      return {
        connected,
        frames,
        async close() {
          activeSocket?.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        },
      };
    }

    const firstBroker = await rawBroker('broker-a');
    const peerSide = fakeWindow();
    const peerDeps = peerSide.deps();
    let releaseOld: () => void = () => {};
    let enteredOld: () => void = () => {};
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const oldEntered = new Promise<void>((resolve) => {
      enteredOld = resolve;
    });
    let requestCount = 0;
    peerDeps.brokerRequest = async () => {
      requestCount += 1;
      if (requestCount === 1) {
        enteredOld();
        await oldGate;
        return [{ surfaceId: 'from-broker-a' }];
      }
      return [{ surfaceId: 'from-broker-b' }];
    };
    const peer = await freshModule<LinkModule>(() => import('../src/peer-link'));
    peer.initPeerLink(fakeContext(dir));
    peer.configurePeerLink(peerDeps);
    opened.push(peer);
    await peer.ensurePeerNet(() => {});

    const firstSocket = await firstBroker.connected;
    firstSocket.write(
      encodeFrame({ kind: 'request', id: 'same-id', op: 'directory', params: {} }),
    );
    await oldEntered;

    // Broker A dies while its webview fan-out is still pending. The replacement
    // binds before this client retries, and deliberately reuses the same id.
    await firstBroker.close();
    const secondBroker = await rawBroker('broker-b');
    try {
      const secondSocket = await secondBroker.connected;
      secondSocket.write(
        encodeFrame({ kind: 'request', id: 'same-id', op: 'directory', params: {} }),
      );
      await waitFor(() => secondBroker.frames.length === 1);
      expect(secondBroker.frames[0]).toEqual({
        kind: 'result',
        id: 'same-id',
        results: [{ surfaceId: 'from-broker-b' }],
      });

      releaseOld();
      await tick(100);
      // The late answer belongs to the destroyed first socket. Sending it to
      // the current socket would let it satisfy an unrelated replacement id.
      expect(secondBroker.frames).toHaveLength(1);
    } finally {
      releaseOld();
      await secondBroker.close();
    }
  });

  it('runs a losing window\'s webview command in the broker and answers it there', async () => {
    const { broker, brokerSide, peer, peerSide } = await linkedPair();

    expect(peer.forwardCommand({ rhId: 'rh-1', cmd: 'status' })).toBe(true);

    await waitFor(() => brokerSide.forwarded.length > 0);
    expect(brokerSide.forwarded[0].payload).toEqual({ rhId: 'rh-1', cmd: 'status' });

    broker.sendCommandResult(brokerSide.forwarded[0].from, {
      rhId: 'rh-1',
      result: { enrolled: true },
    });

    await waitFor(() => peerSide.results.length > 0);
    expect(peerSide.results).toEqual([{ rhId: 'rh-1', result: { enrolled: true } }]);
  });

  it('answers only the window that asked', async () => {
    const { broker, brokerSide, peer, peerSide } = await linkedPair();
    const thirdSide = fakeWindow();
    const third = await openWindow(thirdSide);
    await third.ensurePeerNet(() => {});

    peer.forwardCommand({ rhId: 'rh-1', cmd: 'status' });
    await waitFor(() => brokerSide.forwarded.length > 0);
    broker.sendCommandResult(brokerSide.forwarded[0].from, { rhId: 'rh-1', result: {} });

    await waitFor(() => peerSide.results.length > 0);
    // An `rhId` is unique across every window, so a result sent to the wrong one
    // would settle nothing there and leak this one's Host state.
    await tick(100);
    expect(thirdSide.results).toEqual([]);
  });

  it('has nothing to forward to when this window is the broker', async () => {
    const { broker } = await linkedPair();
    // False is the caller's cue to run it locally, or to refuse it.
    expect(broker.forwardCommand({ rhId: 'rh-1', cmd: 'status' })).toBe(false);
  });

  it('fans a Host UI event out to every window', async () => {
    const { broker, peerSide } = await linkedPair();
    const secondSide = fakeWindow();
    const second = await openWindow(secondSide);
    await second.ensurePeerNet(() => {});
    await waitFor(async () => (await broker.remoteRequest('directory', {})).length > 0);

    const event = { name: 'pairing-queue', queue: [{ clientId: 'client-1' }] };
    broker.broadcastUiEvent(event);

    // Unaddressed on purpose: the pairing modal can be answered from whichever
    // window the user is looking at.
    await waitFor(() => peerSide.uiEvents.length > 0 && secondSide.uiEvents.length > 0);
    expect(peerSide.uiEvents).toEqual([event]);
    expect(secondSide.uiEvents).toEqual([event]);
  });

  it('drops a window\'s outstanding commands when its socket closes', async () => {
    const { brokerSide, peer } = await linkedPair();
    peer.forwardCommand({ rhId: 'rh-1', cmd: 'status' });
    await waitFor(() => brokerSide.forwarded.length > 0);

    await peer.disposePeerLink();

    // Nothing is answered: the socket that would carry the answer is the one
    // that closed, and the asking adapter's own timeout is the backstop.
    await waitFor(() => brokerSide.dropped.length > 0);
    expect(brokerSide.dropped[0]).toBe(brokerSide.forwarded[0].from);
  });

  it('reports a joining window so the broker can hand it the Host state', async () => {
    // Nothing about the Host changes because a window connected, so the events
    // its webviews arm on are never coming on their own — the broker has to
    // volunteer them, and this is the only signal it gets.
    const brokerSide = fakeWindow();
    const { broker, peerSide } = await linkedPair(brokerSide);

    expect(brokerSide.joined).toHaveLength(1);
    const event = { name: 'status', enrolled: true };
    broker.sendUiEvent(brokerSide.joined[0]!, event);

    await waitFor(() => peerSide.uiEvents.length > 0);
    expect(peerSide.uiEvents).toEqual([event]);
  });
});

/**
 * The opening handshake. The socket path is derived from the storage location,
 * so anything on the machine can compute it; these are the properties that make
 * knowing it worthless.
 */
describe('peer handshake', () => {
  /** Read one frame at a time off a raw socket. */
  function frameReader(socket: import('node:net').Socket) {
    const decoder = new FrameDecoder();
    const queue: Array<Record<string, unknown>> = [];
    const waiters: Array<(frame: Record<string, unknown>) => void> = [];
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      for (const frame of decoder.push(chunk)) {
        const typed = frame as Record<string, unknown>;
        const waiter = waiters.shift();
        if (waiter) waiter(typed);
        else queue.push(typed);
      }
    });
    return {
      frames: queue,
      next(): Promise<Record<string, unknown>> {
        const ready = queue.shift();
        if (ready) return Promise.resolve(ready);
        return new Promise((resolve) => waiters.push(resolve));
      },
    };
  }

  it('runs challenge → hello → welcome over a real socket, without sending the token', async () => {
    const broker = await openWindow(fakeWindow({ entries: [{ surfaceId: 'near-1' }] }));
    await broker.ensurePeerNet(() => {});
    const token = await readToken();
    expect(token).toBeTruthy();

    const socket = createConnection({ path: derivedSocketPath() });
    const reader = frameReader(socket);
    await new Promise((resolve) => socket.on('connect', resolve));

    // The server speaks first: a client must never volunteer a proof into
    // whatever bound the path.
    const challenge = await reader.next();
    expect(challenge.kind).toBe('challenge');
    expect(typeof challenge.nonce).toBe('string');

    const nonce = 'client-nonce-1';
    socket.write(
      encodeFrame({
        kind: 'hello',
        nonce,
        proof: proof(token, PEER_CLIENT_PROOF_DOMAIN, String(challenge.nonce)),
      }),
    );

    const welcome = await reader.next();
    expect(welcome).toEqual({
      kind: 'welcome',
      proof: proof(token, PEER_SERVER_PROOF_DOMAIN, nonce),
    });
    // The raw token never crossed in either direction.
    expect(JSON.stringify([challenge, welcome])).not.toContain(token);

    // And the socket is a working peer afterwards.
    socket.write(encodeFrame({ kind: 'notify' }));
    socket.destroy();
  });

  it('drops a client whose proof is over the wrong token', async () => {
    const brokerSide = fakeWindow();
    const broker = await openWindow(brokerSide);
    await broker.ensurePeerNet(() => {});

    const socket = createConnection({ path: derivedSocketPath() });
    const reader = frameReader(socket);
    await new Promise((resolve) => socket.on('connect', resolve));
    const challenge = await reader.next();
    socket.write(
      encodeFrame({
        kind: 'hello',
        nonce: 'n',
        proof: proof('not the token', PEER_CLIENT_PROOF_DOMAIN, String(challenge.nonce)),
      }),
    );

    // Dropped rather than answered — no welcome, and it never joins.
    await new Promise((resolve) => socket.on('close', resolve));
    expect(reader.frames).toEqual([]);
    expect(brokerSide.joined).toEqual([]);
    expect(await broker.remoteRequest('directory', {})).toEqual([]);
    socket.destroy();
  });

  it('drops a parseable JSON value that is not a client frame', async () => {
    const brokerSide = fakeWindow();
    const broker = await openWindow(brokerSide);
    await broker.ensurePeerNet(() => {});

    const socket = createConnection({ path: derivedSocketPath() });
    const reader = frameReader(socket);
    await new Promise((resolve) => socket.on('connect', resolve));
    expect((await reader.next()).kind).toBe('challenge');

    const closed = new Promise((resolve) => socket.on('close', resolve));
    socket.write('null\n');
    await closed;

    expect(reader.frames).toEqual([]);
    expect(brokerSide.joined).toEqual([]);
  });

  it('rejects a proof replayed from another connection', async () => {
    const broker = await openWindow(fakeWindow());
    await broker.ensurePeerNet(() => {});
    const token = await readToken();

    const first = createConnection({ path: derivedSocketPath() });
    const firstReader = frameReader(first);
    await new Promise((resolve) => first.on('connect', resolve));
    const captured = await firstReader.next();
    const stolen = proof(token, PEER_CLIENT_PROOF_DOMAIN, String(captured.nonce));
    first.destroy();

    // A second connection gets a fresh challenge, so the captured proof is
    // worth nothing — which is the whole point of the nonce.
    const second = createConnection({ path: derivedSocketPath() });
    const secondReader = frameReader(second);
    await new Promise((resolve) => second.on('connect', resolve));
    const fresh = await secondReader.next();
    expect(fresh.nonce).not.toBe(captured.nonce);
    second.write(encodeFrame({ kind: 'hello', nonce: 'n', proof: stolen }));

    await new Promise((resolve) => second.on('close', resolve));
    expect(secondReader.frames).toEqual([]);
    second.destroy();
  });

  it('serves nothing to a squatter that took the path but not the token', async () => {
    // The co-resident-user attack: bind the path first, then wait to be handed
    // this installation's terminals. The client must send its hello and nothing
    // else, and must disconnect on a welcome it cannot verify.
    const received: Array<Record<string, unknown>> = [];
    let squatterSocket: import('node:net').Socket | null = null;
    let closed = false;
    const squatter: Server = createServer((socket) => {
      squatterSocket = socket;
      const reader = frameReader(socket);
      socket.on('close', () => {
        closed = true;
      });
      void (async () => {
        socket.write(encodeFrame({ kind: 'challenge', nonce: 'squatter-nonce' }));
        for (;;) {
          const frame = await reader.next();
          received.push(frame);
          if (frame.kind === 'hello') {
            // It cannot compute the real proof, so it guesses.
            socket.write(encodeFrame({ kind: 'welcome', proof: 'made up' }));
          }
        }
      })();
    });
    const path = derivedSocketPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await new Promise<void>((resolve) => squatter.listen(path, resolve));

    try {
      const side = fakeWindow({ entries: [{ surfaceId: 'secret-1' }] });
      const window = await openWindow(side);
      const roles: boolean[] = [];
      void window.ensurePeerNet((held) => roles.push(held));

      await waitFor(() => received.length > 0);
      await tick(200);

      // Exactly one frame, the hello, and it carries no token — only an HMAC
      // over a nonce the squatter chose, which is not the token.
      expect(received.map((frame) => frame.kind)).toEqual(['hello']);
      expect(JSON.stringify(received)).not.toContain(await readToken());
      // No directory, no surfaces, no PTY: it never became this window's broker.
      expect(closed).toBe(true);
      expect(window.isPeerBroker()).toBe(false);
      expect(window.forwardCommand({ rhId: 'rh-1', cmd: 'status' })).toBe(false);
      expect(roles).toEqual([]);
      expect(side.writes).toEqual([]);
    } finally {
      squatterSocket?.destroy();
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it('rejects a non-object frame from the process holding the socket', async () => {
    let squatterSocket: import('node:net').Socket | null = null;
    let window: LinkModule | null = null;
    let closed = false;
    const squatter: Server = createServer((socket) => {
      squatterSocket = socket;
      socket.on('close', () => {
        closed = true;
      });
      socket.write('null\n');
    });
    const path = derivedSocketPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await new Promise<void>((resolve) => squatter.listen(path, resolve));

    try {
      const side = fakeWindow({ entries: [{ surfaceId: 'secret-1' }] });
      window = await openWindow(side);
      const roles: boolean[] = [];
      void window.ensurePeerNet((held) => roles.push(held));

      await waitFor(() => closed);
      expect(window.isPeerBroker()).toBe(false);
      expect(window.forwardCommand({ rhId: 'rh-1', cmd: 'status' })).toBe(false);
      expect(roles).toEqual([]);
      expect(side.writes).toEqual([]);
    } finally {
      await window?.disposePeerLink();
      squatterSocket?.destroy();
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it('keeps the socket directory private to this user', async () => {
    // The layer below the handshake: in a shared tmpdir, a directory anyone can
    // write to is one where a co-resident user can create the path first.
    const peerDir = dirname(derivedSocketPath());
    await mkdir(peerDir, { recursive: true, mode: 0o700 });
    await chmod(peerDir, 0o777);

    const mod = await openWindow(fakeWindow());
    await mod.ensurePeerNet(() => {});

    // Ours, so it is tightened rather than refused.
    expect(mod.isPeerBroker()).toBe(true);
    expect((await stat(peerDir)).mode & 0o777).toBe(0o700);
  });

  it('stands down for good when the socket directory is not one', async () => {
    // Something else holds the only place these sockets may live. No amount of
    // retrying changes that, so the link stops rather than spinning — and the
    // waiting caller is released rather than left hanging.
    const peerDir = dirname(derivedSocketPath());
    await writeFile(peerDir, 'not a directory');

    const mod = await openWindow(fakeWindow());
    const roles: boolean[] = [];
    await mod.ensurePeerNet((held) => roles.push(held));

    expect(roles).toEqual([]);
    expect(mod.isPeerBroker()).toBe(false);
    // No retry loop: what was there is untouched a second later.
    await tick(150);
    expect((await stat(peerDir)).isFile()).toBe(true);
    // And a later caller is answered immediately rather than restarting it.
    await mod.ensurePeerNet(() => {});
    expect(mod.isPeerBroker()).toBe(false);
  });
});
