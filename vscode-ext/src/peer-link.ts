/**
 * Peer surfaces across VS Code windows (docs/specs/vscode.md → "Peer surfaces
 * across windows").
 *
 * Within a window the extension host sees every webview, so brokering is a
 * function call (`brokerRequest`). Across windows there is no shared process at
 * all — one extension host each — so the window holding the Host lease listens
 * on a local socket and every other window connects to it. Because the webview
 * lease is itself gated on the window lease, the broker window is always the
 * Host window; the broker never has to relay back out to a remote Host, which
 * keeps this one-directional.
 *
 * Roles follow the lease: acquire it and you become the server, lose it and you
 * become a client. The frame shapes, framing, and PTY routing table are in
 * `lib/src/lib/vscode-peer-link-protocol.ts`, which is where the fiddly parts
 * are tested.
 *
 * Trust: the socket is a user-owned unix socket (or named pipe) whose path is
 * published only in a mode-0600 rendezvous file, and a client must open with a
 * token read from that file. That is the same bar as the `dor` control socket.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { type FSWatcher } from 'node:fs';
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
import { watchDirFile } from './watch-dir-file';

/**
 * What this module needs from the router, injected rather than imported: the
 * router calls into the link to reach other windows, so importing back would be
 * a cycle.
 */
export interface PeerLinkDeps {
  /** Fan out to this window's own webviews — never to other windows. */
  brokerRequest(op: string, params: unknown): Promise<unknown[]>;
  deliverRemotePtyData(ptyId: string, data: string): void;
  deliverRemotePtyExit(ptyId: string, exitCode: number): void;
  deliverRemotePeerChange(topic: string | null): void;
  onProcessedPtyData(listener: (id: string, data: string) => void): () => void;
  onProcessedPtyExit(listener: (id: string, exitCode: number) => void): () => void;
  writePty(ptyId: string, data: string): void;
  resizePty(ptyId: string, cols: number, rows: number): void;
}

let deps: PeerLinkDeps | null = null;

export function configurePeerLink(next: PeerLinkDeps): void {
  deps = next;
}

const RENDEZVOUS_FILE = 'remote-host.peer.json';

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

/** Backoff for a client whose broker went away before a new one took the lease. */
const RECONNECT_MS = 2_000;

interface Rendezvous {
  socketPath: string;
  token: string;
}

let context: vscode.ExtensionContext | null = null;

export function initPeerLink(ctx: vscode.ExtensionContext): void {
  context = ctx;
}

function rendezvousPath(): string | null {
  return context ? join(context.globalStorageUri.fsPath, RENDEZVOUS_FILE) : null;
}

/**
 * Sockets live in the temp dir, not next to the rendezvous file: macOS caps a
 * unix socket path near 104 bytes and the extension's globalStorage path is
 * most of that on its own.
 */
function newSocketPath(): string {
  const id = randomBytes(6).toString('hex');
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\dormouse-peer-${id}`
    : join(tmpdir(), `dormouse-peer-${id}.sock`);
}

// ---------------------------------------------------------------- server side

interface PeerClient {
  socket: Socket;
  decoder: FrameDecoder;
  authenticated: boolean;
}

/** The role the lease last asked for; an in-flight transition re-reads it. */
let brokerRole = false;
let server: Server | null = null;
/** Claimed and cleared with `server`; the two always move together. */
let rendezvous: Rendezvous | null = null;
const clients = new Set<PeerClient>();
const routes = new Map<string, PeerClient>();
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

export function remoteSubscribe(ptyId: string): void {
  const client = routes.get(ptyId);
  if (client) send(client, { kind: 'subscribe', id: `r${++nextRequestId}`, ptyId });
}

export function remoteUnsubscribe(ptyId: string): void {
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
  for (const ptyId of forgetPeerRoutes(routes, client)) deps?.deliverRemotePtyExit(ptyId, 0);
  if (wasAuthenticated) deps?.deliverRemotePeerChange(null);
  client.socket.destroy();
}

function onServerFrame(client: PeerClient, frame: unknown): void {
  const message = frame as (PeerLinkResponse | { kind: 'hello'; token: string }) & {
    kind: string;
  };
  if (!client.authenticated) {
    // First frame must be the hello; anything else is not a peer of ours.
    const hello = message as Partial<PeerLinkHello>;
    if (hello.kind !== 'hello' || !rendezvous || !tokenMatches(hello.token, rendezvous.token)) {
      log.error('[peer-link] rejected a client with a bad hello');
      dropClient(client);
      return;
    }
    client.authenticated = true;
    // Joining changes the answer set even if no surface changed while the
    // socket was down, so every peer-backed snapshot must be reconsidered.
    deps?.deliverRemotePeerChange(null);
    return;
  }

  const response = message as PeerLinkResponse;
  if (response.kind === 'data') {
    deps?.deliverRemotePtyData(response.ptyId, response.data);
    return;
  }
  if (response.kind === 'exit') {
    routes.delete(response.ptyId);
    deps?.deliverRemotePtyExit(response.ptyId, response.exitCode);
    return;
  }
  if (response.kind === 'notify') {
    deps?.deliverRemotePeerChange(response.topic);
    return;
  }
  if ('id' in response) pendingRequests.get(response.id)?.(response);
}

/** Turn Server.listen's event-based bind failure into a rejecting promise. */
export function listenServer(nextServer: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    nextServer.once('error', onError);
    try {
      nextServer.listen(socketPath, () => {
        nextServer.off('error', onError);
        resolve();
      });
    } catch (error) {
      nextServer.off('error', onError);
      reject(error);
    }
  });
}

/** Close one server and unlink its socket. Touches no module state. */
async function closeServer(target: Server, socketPath: string): Promise<void> {
  if (target.listening) target.close();
  await rm(socketPath, { force: true }).catch(() => {});
}

async function startServer(): Promise<void> {
  const path = rendezvousPath();
  if (!path || server) return;

  const next: Rendezvous = { socketPath: newSocketPath(), token: randomUUID() };
  const temp = `${path}.${randomUUID()}.tmp`;
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
  // Claimed in the same tick as the guard above, which is what makes
  // `server === nextServer` a complete staleness test: nothing can slip in
  // between. Everything below awaits, and the lease can flip back to client
  // inside any of those gaps.
  server = nextServer;
  rendezvous = next;

  /**
   * Give back what this attempt claimed, leaving whoever holds the role now
   * alone — `stopServer` would unlink a newer broker's socket and rendezvous
   * along with this one. Anyone who connected in the meantime is left to the
   * socket's own 'close' handler.
   */
  const abandon = async (): Promise<void> => {
    await closeServer(nextServer, next.socketPath);
    await rm(temp, { force: true }).catch(() => {});
  };

  try {
    // The bind fails hard if anything owns this path. Nothing should — it is
    // six fresh random bytes — and clearing it first is one fs call on a path
    // taken once per lease acquisition.
    await rm(next.socketPath, { force: true }).catch(() => {});
    if (server !== nextServer) {
      await abandon();
      return;
    }
    await listenServer(nextServer, next.socketPath);
    await mkdir(join(path, '..'), { recursive: true }).catch(() => {});
    // The token is the only thing standing between another local process and
    // this window's terminals, so it is never briefly world-readable: written
    // 0600 to a temp file and renamed into place, which also means a reader
    // never sees a half-written rendezvous and falls into the retry backoff.
    await writeFile(temp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
    // Stopped while we were publishing: the socket named in there is already
    // unlinked, so renaming it into place would leave every peer dialing a
    // dead path until some later broker rewrote the file.
    if (server !== nextServer) {
      await abandon();
      return;
    }
    await rename(temp, path);
    log.info('[peer-link] serving peers');
  } catch (err) {
    // Started fire-and-forget from the lease callback, so a rejection here
    // would surface as an unhandled one rather than as a broken link. An
    // unwritable globalStorage means no peers, not a crashed extension host.
    log.error(`[peer-link] could not start serving: ${String(err)}`);
    await abandon();
    if (server === nextServer) await stopServer();
  }
}

async function stopServer(): Promise<void> {
  const closing = server;
  if (!closing) return;
  const path = rendezvousPath();
  const socketPath = rendezvous?.socketPath;
  for (const client of [...clients]) dropClient(client);
  server = null;
  rendezvous = null;
  if (socketPath) await closeServer(closing, socketPath);
  if (path) await rm(path, { force: true }).catch(() => {});
}

// ---------------------------------------------------------------- client side

let client: Socket | null = null;
let clientRetry: ReturnType<typeof setTimeout> | null = null;
let rendezvousWatcher: FSWatcher | null = null;
const pendingNotifications = new Set<string | null>();
/** PTYs this window is streaming to the broker, and how to stop. */
const forwarding = new Map<string, () => void>();

function respond(frame: PeerLinkResponse): void {
  client?.write(encodeFrame(frame));
}

export function remoteNotifyPeerChange(topic: string | null): void {
  // The broker is the destination; its in-window routers were notified directly.
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

async function readRendezvous(): Promise<Rendezvous | null> {
  const path = rendezvousPath();
  if (!path) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const value = parsed as Rendezvous;
    return typeof value?.socketPath === 'string' && typeof value?.token === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}

async function connectClient(): Promise<void> {
  if (client || server) return;
  const rendezvous = await readRendezvous();
  if (!rendezvous) {
    scheduleReconnect();
    return;
  }

  const socket = createConnection({ path: rendezvous.socketPath });
  const decoder = new FrameDecoder();
  socket.setEncoding('utf8');
  socket.on('connect', () => {
    socket.write(encodeFrame({ kind: 'hello', token: rendezvous.token }));
    for (const topic of pendingNotifications) socket.write(encodeFrame({ kind: 'notify', topic }));
    pendingNotifications.clear();
    log.info('[peer-link] connected to the broker window');
  });
  socket.on('data', (chunk: string) => {
    for (const frame of decoder.push(chunk)) void onClientFrame(frame);
  });
  const drop = () => {
    if (client !== socket) return;
    client = null;
    stopForwarding();
    scheduleReconnect();
  };
  socket.on('error', drop);
  socket.on('close', drop);
  client = socket;
}

function scheduleReconnect(): void {
  if (clientRetry || server) return;
  clientRetry = setTimeout(() => {
    clientRetry = null;
    void connectClient();
  }, RECONNECT_MS);
}

function disconnectClient(): void {
  if (clientRetry) {
    clearTimeout(clientRetry);
    clientRetry = null;
  }
  stopForwarding();
  client?.destroy();
  client = null;
}

// ---------------------------------------------------------------- role switch

/**
 * Follow the window lease: the holder serves, everyone else connects to it.
 * Called on every lease change, and idempotent for an unchanged role.
 *
 * Either direction takes several awaits to settle and another flip can land
 * inside them, so each branch re-checks the role it is transitioning into
 * rather than assuming it still holds: `brokerRole` on the client side, and
 * `server === nextServer` on the broker side, which additionally tells a later
 * startup that already claimed the slot from this one.
 */
export function setPeerLinkRole(isBroker: boolean): void {
  brokerRole = isBroker;
  if (isBroker) {
    disconnectClient();
    stopWatchingRendezvous();
    void startServer();
    return;
  }
  void (async () => {
    await stopServer();
    // Flipped back to broker while that was tearing down: a broker must not
    // watch the rendezvous, or it wakes itself on its own writes.
    if (brokerRole) return;
    watchRendezvous();
    await connectClient();
  })();
}

/**
 * Watch the rendezvous rather than only retrying: a new broker publishes a
 * fresh socket path, and polling alone would make every handover wait out the
 * backoff. Only a client needs it — a broker watching would wake on its own
 * writes.
 */
function watchRendezvous(): void {
  if (rendezvousWatcher || !context) return;
  const watcher = watchDirFile(
    context.globalStorageUri.fsPath,
    RENDEZVOUS_FILE,
    () => {
      disconnectClient();
      void connectClient();
    },
    (error) => {
      log.error(`[peer-link] rendezvous watcher failed; the timer converges: ${String(error)}`);
      if (rendezvousWatcher === watcher) rendezvousWatcher = null;
    },
  );
  rendezvousWatcher = watcher;
}

function stopWatchingRendezvous(): void {
  rendezvousWatcher?.close();
  rendezvousWatcher = null;
}

export async function disposePeerLink(): Promise<void> {
  stopWatchingRendezvous();
  disconnectClient();
  await stopServer();
}
