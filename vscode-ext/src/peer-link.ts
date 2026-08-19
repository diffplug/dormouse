/**
 * Which VS Code window runs the remote Host, and how the others reach it
 * (docs/specs/vscode.md → "Peer surfaces across windows").
 *
 * One extension host runs per window, so left to themselves every window would
 * start a Host against the same enrollment, all of them would connect
 * `/ws/host`, and the server's displacement would turn into an endless
 * reconnect fight. Arbitration is therefore **bind-as-lease**: the socket every
 * window would connect to *is* the lease. Its path is fixed — derived from the
 * extension's storage location — so the window that binds it first is the
 * broker and everyone else connects to it as a client.
 *
 * Roles never flip downward while a process lives. A broker stays the broker
 * until it exits, which is what makes the whole class of mid-transition races a
 * lease with a TTL had (start serving, lose the lease, tear down, win it back
 * while tearing down) unrepresentable here. A client only ever changes role
 * upward, when the broker dies and its socket closes: every client then races
 * to bind, and exactly one wins because `bind` is the arbiter.
 *
 * Trust: the socket is a user-owned unix socket (or named pipe) and a client
 * must open with a token from a mode-0600 file in the extension's
 * `globalStorageUri` — the same bar as the `dor` control socket.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as vscode from 'vscode';

import {
  FrameDecoder,
  PEER_REPLY_BUDGET_MS,
  encodeFrame,
  forgetPeerRoutes,
  routedPtyId,
  type PeerLinkHello,
  type PeerLinkRequest,
  type PeerLinkResponse,
} from '../../lib/src/lib/vscode-peer-link-protocol';
import { log } from './log';

/**
 * What this module needs from the router, injected rather than imported: the
 * router calls into the link to reach other windows, so importing back would be
 * a cycle.
 */
export interface PeerLinkDeps {
  /** Fan out to this window's own webviews — never to other windows. */
  brokerRequest(op: string, params: unknown): Promise<unknown[]>;
  /** A peer window's answers may have changed, so the directory is stale. */
  invalidateDirectory(): void;
  onProcessedPtyData(listener: (id: string, data: string) => void): () => void;
  onProcessedPtyExit(listener: (id: string, exitCode: number) => void): () => void;
  writePty(ptyId: string, data: string): void;
  resizePty(ptyId: string, cols: number, rows: number): void;
}

let deps: PeerLinkDeps | null = null;

export function configurePeerLink(next: PeerLinkDeps): void {
  deps = next;
}

const TOKEN_FILE = 'remote-host.peer-token';

/** Floor between contention attempts, so a refused hello cannot become a spin. */
const RETRY_MS = 1_000;

/**
 * Constant-time token compare, mirroring `tokenMatches` in
 * `standalone/sidecar/dor-control-server.js`. That module is CommonJS and the
 * shared protocol module must stay Node-free for the webview, so this is a
 * deliberate second copy — but the property cannot differ: `!==` leaks the
 * token byte-by-byte to a co-resident local process that can time the response.
 */
function tokenMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

let context: vscode.ExtensionContext | null = null;

export function initPeerLink(ctx: vscode.ExtensionContext): void {
  context = ctx;
}

function tokenPath(): string | null {
  return context ? join(context.globalStorageUri.fsPath, TOKEN_FILE) : null;
}

/**
 * The one path every window of this installation contends for.
 *
 * Hashed rather than joined: macOS caps a unix socket path near 104 bytes and
 * the extension's globalStorage path is most of that on its own. Derived from
 * that path rather than random precisely because it must be *the same* in every
 * window — the bind is the arbitration.
 */
function socketPath(): string | null {
  if (!context) return null;
  const id = createHash('sha256')
    .update(context.globalStorageUri.fsPath)
    .digest('hex')
    .slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\dormouse-peer-${id}`
    : join(tmpdir(), `dormouse-peer-${id}.sock`);
}

/**
 * The shared secret, created once per installation and reused forever. Written
 * with an exclusive create rather than a rename, so two windows starting
 * together end up agreeing: the loser reads the winner's token instead of
 * overwriting it under a client that already read the old one.
 */
async function ensureToken(): Promise<string> {
  const path = tokenPath();
  if (!path) throw new Error('peer link has no storage location');
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    // Missing (the common first run) — fall through and create it.
  }
  await mkdir(join(path, '..'), { recursive: true }).catch(() => {});
  const token = randomUUID();
  try {
    // 0600: the token is the only thing between another local process and this
    // installation's terminals, so it is never briefly world-readable.
    await writeFile(path, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return token;
  } catch {
    return (await readFile(path, 'utf8')).trim();
  }
}

// ---------------------------------------------------------------- server side

interface PeerClient {
  socket: Socket;
  decoder: FrameDecoder;
  authenticated: boolean;
}

/** Where bytes from another window's PTY go, once something asks for them. */
export interface RemotePtySink {
  onData(data: string): void;
  onExit(exitCode: number): void;
}

let server: Server | null = null;
/** Claimed and cleared with `server`; the two always move together. */
let serverToken: string | null = null;
const clients = new Set<PeerClient>();
const routes = new Map<string, PeerClient>();
const remoteSinks = new Map<string, RemotePtySink>();
const pendingRequests = new Map<string, (frame: PeerLinkResponse) => void>();
let nextRequestId = 0;

function send(client: PeerClient, frame: PeerLinkRequest): void {
  if (client.socket.destroyed) return;
  client.socket.write(encodeFrame(frame));
}

/** Ask one peer and resolve when it answers, or when the budget expires. */
function ask(client: PeerClient, frame: PeerLinkRequest): Promise<PeerLinkResponse | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(frame.id);
      resolve(null);
    }, PEER_REPLY_BUDGET_MS);
    pendingRequests.set(frame.id, (response) => {
      clearTimeout(timer);
      pendingRequests.delete(frame.id);
      resolve(response);
    });
    send(client, frame);
  });
}

function authenticatedClients(): PeerClient[] {
  return [...clients].filter((client) => client.authenticated);
}

/**
 * Put one peer request to every other window and collect what they answer.
 * Empty when nothing is connected, and when nobody owned what was asked about.
 *
 * All windows at once, not one after another: a window that has gone
 * unresponsive would otherwise make every request behind it wait out its own
 * budget before the window that actually owns the thing is even asked.
 *
 * `op` is opaque — the operation map lives in
 * `lib/src/remote/host/peer-surfaces.ts`. The single exception is
 * {@link routedPtyId}: an answer that names a PTY is how this window learns
 * where that PTY lives, and every later write, resize, and subscribe depends on
 * knowing.
 *
 * Nothing calls this yet — the broker serves only its own window's surfaces
 * until phase 3b wires the second tier into the service's provider.
 */
export async function remoteRequest(op: string, params: unknown): Promise<unknown[]> {
  const peers = authenticatedClients();
  if (peers.length === 0) return [];
  const replies = await Promise.all(
    peers.map(async (client) =>
      [client, await ask(client, { kind: 'request', id: `r${++nextRequestId}`, op, params })] as const,
    ),
  );

  const results: unknown[] = [];
  for (const [client, reply] of replies) {
    if (reply?.kind !== 'result') continue;
    for (const result of reply.results) {
      const ptyId = routedPtyId(result);
      if (ptyId) routes.set(ptyId, client);
      results.push(result);
    }
  }
  return results;
}

/** Whether this PTY is streaming from another window. */
export function isRemotePty(ptyId: string): boolean {
  return routes.get(ptyId) !== undefined;
}

export function remoteSubscribe(ptyId: string, sink: RemotePtySink): void {
  const client = routes.get(ptyId);
  if (!client) return;
  remoteSinks.set(ptyId, sink);
  send(client, { kind: 'subscribe', id: `r${++nextRequestId}`, ptyId });
}

export function remoteUnsubscribe(ptyId: string): void {
  remoteSinks.delete(ptyId);
  const client = routes.get(ptyId);
  if (!client) return;
  send(client, { kind: 'unsubscribe', id: `r${++nextRequestId}`, ptyId });
  routes.delete(ptyId);
}

export function remoteWrite(ptyId: string, data: string): boolean {
  const client = routes.get(ptyId);
  if (!client) return false;
  send(client, { kind: 'write', id: `r${++nextRequestId}`, ptyId, data });
  return true;
}

export function remoteResize(ptyId: string, cols: number, rows: number): boolean {
  const client = routes.get(ptyId);
  if (!client) return false;
  send(client, { kind: 'resizePty', id: `r${++nextRequestId}`, ptyId, cols, rows });
  return true;
}

function dropClient(client: PeerClient): void {
  const wasAuthenticated = clients.delete(client) && client.authenticated;
  // A window that went away takes its terminals with it; a later write must not
  // be routed into a dead socket.
  for (const ptyId of forgetPeerRoutes(routes, client)) {
    remoteSinks.get(ptyId)?.onExit(0);
    remoteSinks.delete(ptyId);
  }
  if (wasAuthenticated) deps?.invalidateDirectory();
  client.socket.destroy();
}

function onServerFrame(client: PeerClient, frame: unknown): void {
  const message = frame as (PeerLinkResponse | { kind: 'hello'; token: string }) & {
    kind: string;
  };
  if (!client.authenticated) {
    // First frame must be the hello; anything else is not a peer of ours.
    const hello = message as Partial<PeerLinkHello>;
    if (hello.kind !== 'hello' || !serverToken || !tokenMatches(hello.token, serverToken)) {
      log.error('[peer-link] rejected a client with a bad hello');
      dropClient(client);
      return;
    }
    client.authenticated = true;
    // Joining changes the answer set even if no surface changed while the
    // socket was down, so every peer-backed snapshot must be reconsidered.
    deps?.invalidateDirectory();
    return;
  }

  const response = message as PeerLinkResponse;
  if (response.kind === 'data') {
    remoteSinks.get(response.ptyId)?.onData(response.data);
    return;
  }
  if (response.kind === 'exit') {
    routes.delete(response.ptyId);
    remoteSinks.get(response.ptyId)?.onExit(response.exitCode);
    remoteSinks.delete(response.ptyId);
    return;
  }
  if (response.kind === 'notify') {
    deps?.invalidateDirectory();
    return;
  }
  if ('id' in response) pendingRequests.get(response.id)?.(response);
}

/** Turn Server.listen's event-based bind failure into a rejecting promise. */
export function listenServer(nextServer: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    nextServer.once('error', onError);
    try {
      nextServer.listen(path, () => {
        nextServer.off('error', onError);
        resolve();
      });
    } catch (error) {
      nextServer.off('error', onError);
      reject(error);
    }
  });
}

/** Take the socket path, or report that somebody else holds it. */
async function tryBind(path: string, token: string): Promise<boolean> {
  const nextServer = createServer((socket) => {
    const client: PeerClient = { socket, decoder: new FrameDecoder(), authenticated: false };
    clients.add(client);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      for (const frame of client.decoder.push(chunk)) onServerFrame(client, frame);
    });
    socket.on('error', () => dropClient(client));
    socket.on('close', () => dropClient(client));
  });
  try {
    await listenServer(nextServer, path);
  } catch {
    // Callback form deliberately: closing a server that never listened emits an
    // `'error'` nobody is listening for, which an EventEmitter rethrows and
    // would take the extension host down over a lost race.
    nextServer.close(() => {});
    return false;
  }
  server = nextServer;
  serverToken = token;
  return true;
}

// ---------------------------------------------------------------- client side

let client: Socket | null = null;
const pendingNotifications = new Set<string | null>();
/** PTYs this window is streaming to the broker, and how to stop. */
const forwarding = new Map<string, () => void>();

function respond(frame: PeerLinkResponse): void {
  client?.write(encodeFrame(frame));
}

export function remoteNotifyPeerChange(topic: string | null): void {
  // The broker is the destination; its own window was notified directly.
  if (server) return;
  if (!client || client.destroyed) {
    pendingNotifications.add(topic);
    return;
  }
  respond({ kind: 'notify', topic });
}

async function onClientFrame(frame: unknown): Promise<void> {
  const request = frame as PeerLinkRequest;
  switch (request.kind) {
    case 'request':
      respond({
        kind: 'result',
        id: request.id,
        results: (await deps?.brokerRequest(request.op, request.params)) ?? [],
      });
      break;
    case 'subscribe': {
      if (forwarding.has(request.ptyId)) break;
      if (!deps) break;
      const stops: Array<() => void> = [];
      const stop = () => {
        for (const dispose of stops) dispose();
      };
      stops.push(deps.onProcessedPtyData((id, data) => {
        if (id === request.ptyId) respond({ kind: 'data', ptyId: id, data });
      }));
      stops.push(deps.onProcessedPtyExit((id, exitCode) => {
        if (id !== request.ptyId) return;
        respond({ kind: 'exit', ptyId: id, exitCode });
        stop();
        forwarding.delete(request.ptyId);
      }));
      forwarding.set(request.ptyId, stop);
      break;
    }
    case 'unsubscribe':
      forwarding.get(request.ptyId)?.();
      forwarding.delete(request.ptyId);
      break;
    case 'write':
      deps?.writePty(request.ptyId, request.data);
      break;
    case 'resizePty':
      deps?.resizePty(request.ptyId, request.cols, request.rows);
      break;
  }
}

function stopForwarding(): void {
  for (const stop of forwarding.values()) stop();
  forwarding.clear();
}

/**
 * Connect to whoever holds the socket. `'refused'` means the path exists but
 * nothing is listening on it — a broker that died without unlinking — which is
 * the caller's cue to clear it and bind.
 */
function tryConnect(path: string, token: string): Promise<'connected' | 'refused' | 'failed'> {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    const decoder = new FrameDecoder();
    socket.setEncoding('utf8');
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'refused' : 'failed');
    });
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      socket.write(encodeFrame({ kind: 'hello', token }));
      for (const topic of pendingNotifications) socket.write(encodeFrame({ kind: 'notify', topic }));
      pendingNotifications.clear();
      socket.on('data', (chunk: string) => {
        for (const frame of decoder.push(chunk)) void onClientFrame(frame);
      });
      const drop = () => {
        if (client !== socket) return;
        client = null;
        stopForwarding();
        // The broker is gone. Every client races for the bind; one wins.
        if (!disposed) void contend();
      };
      socket.on('error', drop);
      socket.on('close', drop);
      client = socket;
      log.info('[peer-link] connected to the broker window');
      resolve('connected');
    });
  });
}

function disconnectClient(): void {
  stopForwarding();
  client?.destroy();
  client = null;
}

// ------------------------------------------------------------ the contend loop

let disposed = false;
let contending = false;
let nextAttemptAt = 0;
let announceRole: ((broker: boolean) => void) | null = null;
let settledOnce: Promise<void> | null = null;
let markSettled: (() => void) | null = null;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Join the contention for the Host, reporting `true` exactly once if this
 * window wins it. Idempotent; the returned promise resolves as soon as a role
 * is settled, so a caller that must know whether to route locally can wait.
 *
 * There is deliberately no `onRole(false)` after a `true`: a broker is the
 * broker for the rest of the process's life.
 */
export function ensurePeerNet(onRole: (broker: boolean) => void): Promise<void> {
  announceRole = onRole;
  if (server) {
    onRole(true);
    return Promise.resolve();
  }
  // No storage location means no socket to contend for, and no amount of
  // retrying would produce one.
  if (!context || disposed) return Promise.resolve();
  settledOnce ??= new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  void contend();
  return settledOnce;
}

/** Whether this window holds the Host. */
export function isPeerBroker(): boolean {
  return server !== null;
}

function settle(broker: boolean): void {
  if (broker) announceRole?.(true);
  markSettled?.();
  markSettled = null;
}

/**
 * One round of arbitration: bind, or connect to whoever bound, or clear the
 * corpse a dead broker left behind and bind. Returns whether a role was
 * settled — anything else is transient (an unwritable storage dir, a broker
 * mid-startup) and the loop retries.
 */
async function attempt(): Promise<boolean> {
  const path = socketPath();
  if (!path) return false;
  const token = await ensureToken();

  if (await tryBind(path, token)) {
    // Disposal can land inside any of the awaits above; a socket bound after it
    // would outlive the window that owns it.
    if (disposed) {
      await closeServer(true);
      return true;
    }
    log.info('[peer-link] serving peers');
    settle(true);
    return true;
  }

  const outcome = await tryConnect(path, token);
  if (outcome === 'connected') {
    // Same as the bind above: a connection opened after disposal has nobody
    // left to close it.
    if (disposed) disconnectClient();
    else settle(false);
    return true;
  }
  if (outcome === 'refused') {
    // The path exists but nothing answers: a broker that died without running
    // its disposables. Unlinking is safe because a live broker would have
    // accepted the connection above.
    await rm(path, { force: true }).catch(() => {});
    if (await tryBind(path, token)) {
      if (disposed) {
        await closeServer(true);
        return true;
      }
      if (await stillOurs(path)) {
        log.info('[peer-link] took over a socket its broker left behind');
        settle(true);
        return true;
      }
      // Another window cleared the same corpse and bound after us, so the path
      // now names its socket and ours is unreachable. Stand down rather than
      // run a second Host: `bind` is only the arbiter when nobody unlinks.
      await closeServer(false);
    }
  }
  return false;
}

/** How long to let a competing reclaim land before believing we won it. */
const RECLAIM_VERIFY_MS = 250;

/**
 * Whether the socket path still names the inode we just bound.
 *
 * Two windows can find the same corpse and both unlink it, and the second bind
 * silently displaces the first — the loser keeps serving an inode no client can
 * reach. Nothing on the bind path detects that, so it is checked afterwards.
 * Windows named pipes cannot get here (a pipe dies with its process) and do not
 * stat, so an unreadable path is taken as ours.
 */
async function stillOurs(path: string): Promise<boolean> {
  const mine = await stat(path).catch(() => null);
  if (!mine) return true;
  await delay(RECLAIM_VERIFY_MS);
  const now = await stat(path).catch(() => null);
  return !now || now.ino === mine.ino;
}

async function contend(): Promise<void> {
  if (contending || disposed) return;
  contending = true;
  try {
    while (!disposed && !server && !client) {
      const wait = nextAttemptAt - Date.now();
      if (wait > 0) await delay(wait);
      // Spaced rather than immediate on repeat: a broker that refuses this
      // window's hello would otherwise turn reconnection into a spin.
      nextAttemptAt = Date.now() + RETRY_MS;
      try {
        if (await attempt()) return;
      } catch (err) {
        // Started fire-and-forget, so a rejection here would surface as an
        // unhandled one rather than as a link that keeps trying.
        log.error(`[peer-link] contention attempt failed: ${String(err)}`);
      }
    }
  } finally {
    contending = false;
  }
}

/**
 * Give up this window's server. Unlink only when the path still names our
 * socket: removing a winner's would strand every client dialing it.
 */
async function closeServer(unlink: boolean): Promise<void> {
  const closing = server;
  server = null;
  serverToken = null;
  for (const peer of [...clients]) dropClient(peer);
  if (!closing) return;
  if (closing.listening) closing.close();
  if (!unlink) return;
  const path = socketPath();
  if (path) await rm(path, { force: true }).catch(() => {});
}

export async function disposePeerLink(): Promise<void> {
  disposed = true;
  disconnectClient();
  await closeServer(true);
}
