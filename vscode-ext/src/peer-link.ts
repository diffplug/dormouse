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

import { randomBytes, randomUUID } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as vscode from 'vscode';

import {
  FrameDecoder,
  PeerRouteTable,
  encodeFrame,
  type PeerLinkRequest,
  type PeerLinkResponse,
} from '../../lib/src/lib/vscode-peer-link-protocol';
import { log } from './log';
import * as ptyManager from './pty-manager';

export interface PeerSurfaceResult {
  ok: boolean;
  ptyId?: string;
  cols?: number;
  rows?: number;
}

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
    op: 'attach' | 'detach' | 'resize',
    cols?: number,
    rows?: number,
  ): Promise<PeerSurfaceResult>;
  deliverRemotePtyData(ptyId: string, data: string): void;
  deliverRemotePtyExit(ptyId: string, exitCode: number): void;
  onProcessedPtyData(listener: (id: string, data: string) => void): () => void;
}

let deps: PeerLinkDeps | null = null;

export function configurePeerLink(next: PeerLinkDeps): void {
  deps = next;
}

const RENDEZVOUS_FILE = 'remote-host.peer.json';

/** Matches the in-window fan-out budget; a window that cannot answer is skipped. */
const PEER_REPLY_BUDGET_MS = 1_000;

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
let serverToken = '';
let serverSocketPath = '';
const clients = new Set<PeerClient>();
const routes = new PeerRouteTable<PeerClient>();
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
  op: 'attach' | 'detach' | 'resize',
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
    if (reply.ptyId) routes.claim(reply.ptyId, client);
    return { ok: true, ptyId: reply.ptyId, cols: reply.cols, rows: reply.rows };
  }
  return { ok: false };
}

/** Whether this PTY is streaming from another window. */
export function isRemotePty(ptyId: string): boolean {
  return routes.peerFor(ptyId) !== undefined;
}

export function remoteSubscribe(ptyId: string): void {
  const client = routes.peerFor(ptyId);
  if (client) send(client, { kind: 'subscribe', id: `r${++nextRequestId}`, ptyId });
}

export function remoteUnsubscribe(ptyId: string): void {
  const client = routes.peerFor(ptyId);
  if (!client) return;
  send(client, { kind: 'unsubscribe', id: `r${++nextRequestId}`, ptyId });
  routes.release(ptyId);
}

export function remoteWrite(ptyId: string, data: string): boolean {
  const client = routes.peerFor(ptyId);
  if (!client) return false;
  send(client, { kind: 'write', id: `r${++nextRequestId}`, ptyId, data });
  return true;
}

export function remoteResize(ptyId: string, cols: number, rows: number): boolean {
  const client = routes.peerFor(ptyId);
  if (!client) return false;
  send(client, { kind: 'resizePty', id: `r${++nextRequestId}`, ptyId, cols, rows });
  return true;
}

function dropClient(client: PeerClient): void {
  clients.delete(client);
  // A window that went away takes its terminals with it; a later write must not
  // be routed into a dead socket.
  for (const ptyId of routes.forgetPeer(client)) deps?.deliverRemotePtyExit(ptyId, 0);
  client.socket.destroy();
}

function onServerFrame(client: PeerClient, frame: unknown): void {
  const message = frame as (PeerLinkResponse | { kind: 'hello'; token: string }) & {
    kind: string;
  };
  if (!client.authenticated) {
    // First frame must be the hello; anything else is not a peer of ours.
    const hello = message as { kind: string; token?: string };
    if (hello.kind !== 'hello' || hello.token !== serverToken) {
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
    routes.release(response.ptyId);
    deps?.deliverRemotePtyExit(response.ptyId, response.exitCode);
    return;
  }
  if ('id' in response) pendingRequests.get(response.id)?.(response);
}

async function startServer(): Promise<void> {
  const path = rendezvousPath();
  if (!path || server) return;

  serverToken = randomUUID();
  serverSocketPath = newSocketPath();
  await rm(serverSocketPath, { force: true }).catch(() => {});

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

  await new Promise<void>((resolve) => server!.listen(serverSocketPath, resolve));
  await mkdir(join(path, '..'), { recursive: true }).catch(() => {});
  const rendezvous: Rendezvous = { socketPath: serverSocketPath, token: serverToken };
  await writeFile(path, JSON.stringify(rendezvous), 'utf8');
  // The token is the only thing standing between another local process and this
  // window's terminals.
  await chmod(path, 0o600).catch(() => {});
  log.info('[peer-link] serving peers');
}

async function stopServer(): Promise<void> {
  if (!server) return;
  const path = rendezvousPath();
  for (const client of [...clients]) dropClient(client);
  server.close();
  server = null;
  await rm(serverSocketPath, { force: true }).catch(() => {});
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
      respond({ kind: 'ack', id: request.id });
      break;
    }
    case 'unsubscribe':
      forwarding.get(request.ptyId)?.();
      forwarding.delete(request.ptyId);
      respond({ kind: 'ack', id: request.id });
      break;
    case 'write':
      ptyManager.write(request.ptyId, request.data);
      break;
    case 'resizePty':
      ptyManager.resize(request.ptyId, request.cols, request.rows);
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
    void startServer();
    return;
  }
  void stopServer().then(() => {
    // Watch the rendezvous rather than only retrying: when a new window takes
    // the lease it publishes a fresh socket path, and polling would make every
    // handover wait out the backoff.
    if (!rendezvousWatcher && context) {
      const dir = context.globalStorageUri.fsPath;
      try {
        rendezvousWatcher = watch(dir, (_event, filename) => {
          if (filename && filename !== RENDEZVOUS_FILE) return;
          disconnectClient();
          void connectClient();
        });
      } catch {
        // No watcher here: the reconnect timer still converges.
      }
    }
    void connectClient();
  });
}

export async function disposePeerLink(): Promise<void> {
  rendezvousWatcher?.close();
  rendezvousWatcher = null;
  disconnectClient();
  await stopServer();
}
