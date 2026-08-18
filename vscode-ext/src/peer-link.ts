/**
 * Peer surfaces across VS Code windows (docs/specs/vscode.md → "Peer surfaces
 * across windows").
 *
 * Within a window the extension host sees every webview, so brokering is a
 * function call (`brokerDirectory` / `brokerSurfaceOp`). Across windows there
 * is no shared process at all — one extension host each — so the window holding
 * the Host lease listens on a local socket and every other window connects to
 * it. Because the webview lease is itself gated on the window lease, the broker
 * window is always the Host window; the broker never has to relay back out to a
 * remote Host, which keeps this one-directional.
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
import { watch, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as vscode from 'vscode';

import {
  FrameDecoder,
  PEER_REPLY_BUDGET_MS,
  encodeFrame,
  forgetPeerRoutes,
  type PeerLinkHello,
  type PeerLinkRequest,
  type PeerLinkResponse,
  type PeerSurfaceOp,
  type PeerSurfaceResult,
} from '../../lib/src/lib/vscode-peer-link-protocol';
import { log } from './log';

/**
 * What this module needs from the router, injected rather than imported: the
 * router calls into the link to reach other windows, so importing back would be
 * a cycle.
 */
export interface PeerLinkDeps {
  /** Fan out to this window's own webviews — never to other windows. */
  brokerDirectory(): Promise<unknown[]>;
  brokerSurfaceOp(
    surfaceId: string,
    op: PeerSurfaceOp,
    cols?: number,
    rows?: number,
  ): Promise<PeerSurfaceResult>;
  deliverRemotePtyData(ptyId: string, data: string): void;
  deliverRemotePtyExit(ptyId: string, exitCode: number): void;
  onProcessedPtyData(listener: (id: string, data: string) => void): () => void;
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

let server: Server | null = null;
/** Set exactly while `server` is listening; the two move together. */
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

/** Directory entries from every other window. Empty when nothing is connected. */
export async function remoteDirectory(): Promise<unknown[]> {
  const peers = authenticatedClients();
  if (peers.length === 0) return [];
  const replies = await Promise.all(
    peers.map((client) => ask(client, { kind: 'directory', id: `r${++nextRequestId}` })),
  );
  return replies.flatMap((reply) =>
    reply?.kind === 'directoryResult' ? reply.entries : [],
  );
}

/**
 * Drive a surface owned by another window. The first window to claim it wins;
 * the rest own no such id and answer `ok: false`.
 */
export async function remoteSurfaceOp(
  surfaceId: string,
  op: PeerSurfaceOp,
  cols?: number,
  rows?: number,
): Promise<PeerSurfaceResult> {
  for (const client of authenticatedClients()) {
    const reply = await ask(client, {
      kind: 'surfaceOp', id: `r${++nextRequestId}`, surfaceId, op, cols, rows,
    });
    if (reply?.kind !== 'surfaceResult' || !reply.ok) continue;
    // Remember where this PTY lives: a ptyId alone says nothing about which
    // window owns it, and input and resizes have to reach that window.
    if (reply.ptyId) routes.set(reply.ptyId, client);
    return { ok: true, ptyId: reply.ptyId, cols: reply.cols, rows: reply.rows };
  }
  return { ok: false };
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
  clients.delete(client);
  // A window that went away takes its terminals with it; a later write must not
  // be routed into a dead socket.
  for (const ptyId of forgetPeerRoutes(routes, client)) deps?.deliverRemotePtyExit(ptyId, 0);
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
  if ('id' in response) pendingRequests.get(response.id)?.(response);
}

async function startServer(): Promise<void> {
  const path = rendezvousPath();
  if (!path || server) return;

  const next: Rendezvous = { socketPath: newSocketPath(), token: randomUUID() };
  await rm(next.socketPath, { force: true }).catch(() => {});

  server = createServer((socket) => {
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
    rendezvous = next;
    await new Promise<void>((resolve) => server!.listen(next.socketPath, resolve));
    await mkdir(join(path, '..'), { recursive: true }).catch(() => {});
    // The token is the only thing standing between another local process and
    // this window's terminals, so it is never briefly world-readable: written
    // 0600 to a temp file and renamed into place, which also means a reader
    // never sees a half-written rendezvous and falls into the retry backoff.
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
    log.info('[peer-link] serving peers');
  } catch (err) {
    // Started fire-and-forget from the lease callback, so a rejection here
    // would surface as an unhandled one rather than as a broken link. An
    // unwritable globalStorage means no peers, not a crashed extension host.
    log.error(`[peer-link] could not start serving: ${String(err)}`);
    await stopServer();
  }
}

async function stopServer(): Promise<void> {
  if (!server) return;
  const path = rendezvousPath();
  const socketPath = rendezvous?.socketPath;
  for (const client of [...clients]) dropClient(client);
  server.close();
  server = null;
  rendezvous = null;
  if (socketPath) await rm(socketPath, { force: true }).catch(() => {});
  if (path) await rm(path, { force: true }).catch(() => {});
}

// ---------------------------------------------------------------- client side

let client: Socket | null = null;
let clientRetry: ReturnType<typeof setTimeout> | null = null;
let rendezvousWatcher: FSWatcher | null = null;
/** PTYs this window is streaming to the broker, and how to stop. */
const forwarding = new Map<string, () => void>();

function respond(frame: PeerLinkResponse): void {
  client?.write(encodeFrame(frame));
}

async function onClientFrame(frame: unknown): Promise<void> {
  const request = frame as PeerLinkRequest;
  switch (request.kind) {
    case 'directory':
      respond({ kind: 'directoryResult', id: request.id, entries: (await deps?.brokerDirectory()) ?? [] });
      break;
    case 'surfaceOp': {
      const result = (await deps?.brokerSurfaceOp(
        request.surfaceId, request.op, request.cols, request.rows,
      )) ?? { ok: false };
      respond({ kind: 'surfaceResult', id: request.id, ...result });
      break;
    }
    case 'subscribe': {
      if (forwarding.has(request.ptyId)) break;
      const stop = deps?.onProcessedPtyData((id, data) => {
        if (id === request.ptyId) respond({ kind: 'data', ptyId: id, data });
      });
      if (stop) forwarding.set(request.ptyId, stop);
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
 */
export function setPeerLinkRole(isBroker: boolean): void {
  if (isBroker) {
    disconnectClient();
    stopWatchingRendezvous();
    void startServer();
    return;
  }
  void (async () => {
    await stopServer();
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
  try {
    rendezvousWatcher = watch(context.globalStorageUri.fsPath, (_event, filename) => {
      if (filename && filename !== RENDEZVOUS_FILE) return;
      disconnectClient();
      void connectClient();
    });
  } catch {
    // No watcher here: the reconnect timer still converges.
  }
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
