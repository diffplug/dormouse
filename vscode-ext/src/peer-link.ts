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
 * Traffic runs both ways over that socket, and each direction is the half its
 * end alone can do: the broker asks client windows for their directory and
 * their surfaces and streams their PTYs, and client windows forward their
 * webviews' Host commands to the broker, which is the only process running a
 * service, and take back its results and UI events.
 *
 * Trust: the path is derived, not secret — it has to be the same in every
 * window, so anything running as any user on the machine can compute it. Two
 * things stand between that and this installation's terminals. On unix the
 * sockets live in a 0700 directory of this user's own, checked before every bind
 * and every connect, so a co-resident user cannot create the path first (Windows
 * named pipes are not filesystem objects and carry their own ACL, so they skip
 * that layer). And both ends prove they hold the shared token — from a 0600 file
 * in the extension's `globalStorageUri`, the same bar as the `dor` control
 * socket — through the mutual handshake below, without the token itself ever
 * crossing the wire. The client verifies the server *before* it sends or serves
 * anything, so squatting the path buys nothing: a process that cannot prove the
 * token gets no directory, no PTY stream, and no commands.
 */

import { chmod, lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as vscode from 'vscode';

import type {
  RemoteHostCommand,
  RemoteHostResult,
} from '../../lib/src/host/remote/service-protocol';
import {
  FrameDecoder,
  PEER_CLIENT_PROOF_DOMAIN,
  PEER_REPLY_BUDGET_MS,
  PEER_SERVER_PROOF_DOMAIN,
  encodeFrame,
  forgetPeerRoutes,
  freshNonce,
  proofMatches,
  proveToken,
  routedPtyId,
  type PeerLinkChallenge,
  type PeerLinkHello,
  type PeerLinkRequest,
  type PeerLinkResponse,
  type PeerLinkWelcome,
} from './peer-link-protocol';
import type { PtySink } from './processed-pty-streams';
import { log } from './log';

/**
 * What this module needs from the router, injected rather than imported: the
 * router calls into the link to reach other windows, so importing back would be
 * a cycle. The four command members reach `remote-host.ts`, which imports this
 * module for the sending half and so cannot be imported back either.
 */
export interface PeerLinkDeps {
  /** Fan out to this window's own webviews — never to other windows. */
  brokerRequest(op: string, params: unknown): Promise<unknown[]>;
  /** A peer window's answers may have changed, so the directory is stale. */
  invalidateDirectory(): void;
  /**
   * Watch one PTY this window owns, through the window's shared keyed registry
   * (`processed-pty-streams.ts`) rather than a listener pair of this link's own.
   */
  streamPty(ptyId: string, sink: PtySink): () => void;
  writePty(ptyId: string, data: string): void;
  resizePty(ptyId: string, cols: number, rows: number): void;
  /**
   * Broker side: run a webview command from `from` on this window's service.
   * The answer goes back through {@link sendCommandResult}, so the answering
   * module is the one that remembers which window is owed it.
   */
  handleForwardedCommand(payload: RemoteHostCommand, from: PeerLinkClient): void;
  /** Broker side: that window is gone, so nothing it asked can be answered. */
  dropForwardedCommands(from: PeerLinkClient): void;
  /** Client side: the broker answered a command this window forwarded. */
  deliverCommandResult(payload: RemoteHostResult): void;
  /** Client side: a Host UI event, for this window's webviews to render. */
  deliverUiEvent(payload: unknown): void;
  /**
   * Broker side: that window just finished the handshake. Nothing about the
   * Host has changed *because* it joined, so the events its webviews gate
   * themselves on are never coming on their own — whoever holds the Host state
   * has to hand it the current one now (`remote-host.ts`).
   */
  onClientAuthenticated(client: PeerLinkClient): void;
}

let deps: PeerLinkDeps | null = null;

export function configurePeerLink(next: PeerLinkDeps): void {
  deps = next;
}

const TOKEN_FILE = 'remote-host.peer-token';

/** Floor between contention attempts, so a refused hello cannot become a spin. */
const RETRY_MS = 1_000;

/**
 * How long a connect may spend between `accept` and a verified `welcome`. A
 * process that takes the path and then says nothing would otherwise hold the
 * contention loop open forever, because the loop awaits this rather than polls.
 */
const HANDSHAKE_BUDGET_MS = 5_000;

let context: vscode.ExtensionContext | null = null;

export function initPeerLink(ctx: vscode.ExtensionContext): void {
  context = ctx;
}

function tokenPath(): string | null {
  return context ? join(context.globalStorageUri.fsPath, TOKEN_FILE) : null;
}

/**
 * The directory the peer sockets live in, one per OS user.
 *
 * `tmpdir()` is shared by every user on the machine and the socket path is
 * derived rather than random — it has to be, since binding it *is* the
 * arbitration — so left in the open a co-resident user could create the path
 * first and have every Dormouse window in this installation dial them. A
 * private directory they cannot write to takes that away before the handshake
 * has to.
 */
function peerDirPath(): string {
  return join(tmpdir(), `dormouse-peer-${process.getuid?.() ?? 0}`);
}

/**
 * Make the per-user socket directory and report whether it is safe to use.
 *
 * Anything but a plain directory of ours at mode 0700 is somebody else's,
 * possibly on purpose, and no amount of retrying makes it ours — so the caller
 * stands the peer link down for good rather than spinning against it.
 *
 * Windows named pipes are not filesystem objects and carry their own ACL, so
 * there is nothing here for them to check.
 */
async function peerDirIsSafe(): Promise<boolean> {
  if (process.platform === 'win32') return true;
  const dir = peerDirPath();
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {});
  const uid = process.getuid?.();
  let info = await lstat(dir).catch(() => null);
  // Ours but loose — a permissive umask, or a directory from before this check
  // existed. Tightening something we already own is safe and keeps the test
  // below exact rather than "0700 or better".
  if (info?.isDirectory() && info.uid === uid && (info.mode & 0o777) !== 0o700) {
    await chmod(dir, 0o700).catch(() => {});
    info = await lstat(dir).catch(() => null);
  }
  return (
    !!info &&
    info.isDirectory() &&
    // `lstat` does not follow, so a symlink reports as one rather than as
    // whatever it points at — which is the whole reason it is `lstat`.
    !info.isSymbolicLink() &&
    info.uid === uid &&
    (info.mode & 0o777) === 0o700
  );
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
    : join(peerDirPath(), `${id}.sock`);
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

/**
 * One connected window, from the broker's side. Exported because a forwarded
 * command is answered by a different module — it holds this as the identity of
 * the window that is owed the answer, and hands it back to
 * {@link sendCommandResult}.
 */
export interface PeerLinkClient {
  socket: Socket;
  decoder: FrameDecoder;
  authenticated: boolean;
  /** The nonce this window challenged it with; its proof must be over exactly this. */
  challenge: string;
}

/** Where bytes from another window's PTY go, once something asks for them. */
export interface RemotePtySink {
  onData(data: string): void;
  onExit(exitCode: number): void;
}

let server: Server | null = null;
/** Claimed and cleared with `server`; the two always move together. */
let serverToken: string | null = null;
const clients = new Set<PeerLinkClient>();
const routes = new Map<string, PeerLinkClient>();
const remoteSinks = new Map<string, Set<RemotePtySink>>();
const pendingRequests = new Map<string, (frame: PeerLinkResponse) => void>();
let nextRequestId = 0;

function send(
  client: PeerLinkClient,
  frame: PeerLinkRequest | PeerLinkChallenge | PeerLinkWelcome,
): void {
  if (client.socket.destroyed) return;
  client.socket.write(encodeFrame(frame));
}

/** Ask one peer and resolve when it answers, or when the budget expires. */
function ask(
  client: PeerLinkClient,
  // `request` is the only frame anything waits on, and so the only one that
  // carries an id; everything else is one-way and correlated by `ptyId` or by
  // the `rhId` already inside it.
  frame: Extract<PeerLinkRequest, { kind: 'request' }>,
): Promise<PeerLinkResponse | null> {
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

function authenticatedClients(): PeerLinkClient[] {
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

export function remoteSubscribe(ptyId: string, sink: RemotePtySink): void {
  const client = routes.get(ptyId);
  if (!client) return;
  // Reference-counted per PTY: two attachments to the same foreign surface
  // share one stream over the link, and only zero-to-one starts the owner
  // forwarding — so a second viewer never restarts a stream that is already
  // flowing, and one viewer detaching cannot silence the other.
  let sinks = remoteSinks.get(ptyId);
  if (!sinks) {
    sinks = new Set();
    remoteSinks.set(ptyId, sinks);
    send(client, { kind: 'subscribe', ptyId });
  }
  sinks.add(sink);
}

export function remoteUnsubscribe(ptyId: string, sink: RemotePtySink): void {
  const sinks = remoteSinks.get(ptyId);
  if (!sinks?.delete(sink) || sinks.size > 0) return;
  // Last viewer gone: stop the owner forwarding. The route stays — "nobody is
  // watching it" is not "it moved". Re-attaching an already-attached surface
  // resolves the new route first and only then tears the old attachment down,
  // so dropping the route here would delete the fresh one and strand every
  // later write. Routes are refreshed by every resolve and dropped by the two
  // things that really mean the terminal is gone: an `exit` frame, and the
  // owning window disconnecting (`forgetPeerRoutes`).
  remoteSinks.delete(ptyId);
  const client = routes.get(ptyId);
  if (!client) return;
  send(client, { kind: 'unsubscribe', ptyId });
}

export function remoteWrite(ptyId: string, data: string): boolean {
  const client = routes.get(ptyId);
  if (!client) return false;
  send(client, { kind: 'write', ptyId, data });
  return true;
}

export function remoteResize(ptyId: string, cols: number, rows: number): boolean {
  const client = routes.get(ptyId);
  if (!client) return false;
  send(client, { kind: 'resizePty', ptyId, cols, rows });
  return true;
}

/**
 * Answer one forwarded command, to the window that forwarded it and to nobody
 * else. A result posted to every window would settle nothing anywhere else —
 * only the adapter that minted the `rhId` holds a pending command for it — and
 * would put one window's enrollment secrets in front of another's webviews.
 */
export function sendCommandResult(client: PeerLinkClient, payload: RemoteHostResult): void {
  send(client, { kind: 'commandResult', payload });
}

/**
 * Put a Host UI event in front of every window's webviews. The pairing modal
 * may be answered from any of them, so the queue cannot be addressed.
 */
export function broadcastUiEvent(payload: unknown): void {
  for (const peer of authenticatedClients()) sendUiEvent(peer, payload);
}

/**
 * Put a Host UI event in front of one window's webviews — the joining window's
 * catch-up, which nobody else needs and which carries no state another window
 * has not already been told (`remote-host.ts`).
 */
export function sendUiEvent(client: PeerLinkClient, payload: unknown): void {
  send(client, { kind: 'uiEvent', payload });
}

function dropClient(client: PeerLinkClient): void {
  const wasAuthenticated = clients.delete(client) && client.authenticated;
  // A window that went away takes its terminals with it; a later write must not
  // be routed into a dead socket.
  for (const ptyId of forgetPeerRoutes(routes, client)) {
    for (const sink of remoteSinks.get(ptyId) ?? []) sink.onExit(0);
    remoteSinks.delete(ptyId);
  }
  // Its in-flight commands can never be answered: the socket that would carry
  // the answer is the one that closed. The asking webview's own timeout is the
  // backstop, and that window is on its way to becoming a broker anyway.
  deps?.dropForwardedCommands(client);
  if (wasAuthenticated) deps?.invalidateDirectory();
  client.socket.destroy();
}

function onServerFrame(client: PeerLinkClient, frame: unknown): void {
  const message = frame as (PeerLinkResponse | PeerLinkHello) & { kind: string };
  if (!client.authenticated) {
    // First frame must be the hello, answering the challenge this window sent
    // on accept; anything else is not a peer of ours.
    const hello = message as Partial<PeerLinkHello>;
    if (
      hello.kind !== 'hello' ||
      typeof hello.nonce !== 'string' ||
      !hello.nonce ||
      !serverToken ||
      !proofMatches(
        hello.proof,
        proveToken(serverToken, PEER_CLIENT_PROOF_DOMAIN, client.challenge),
      )
    ) {
      log.error('[peer-link] rejected a client with a bad hello');
      dropClient(client);
      return;
    }
    client.authenticated = true;
    // Our half, over the nonce *it* chose: a client has no other way to tell
    // this window's broker from something that merely bound the path first, and
    // it serves nothing until it has this.
    send(client, {
      kind: 'welcome',
      proof: proveToken(serverToken, PEER_SERVER_PROOF_DOMAIN, hello.nonce),
    });
    // Joining changes the answer set even if no surface changed while the
    // socket was down, so every peer-backed snapshot must be reconsidered.
    deps?.invalidateDirectory();
    // And nothing about the Host changed *because* it joined, so the state its
    // webviews gate on has to be handed to it rather than waited for.
    deps?.onClientAuthenticated(client);
    return;
  }

  const response = message as PeerLinkResponse;
  if (response.kind === 'data') {
    for (const sink of remoteSinks.get(response.ptyId) ?? []) sink.onData(response.data);
    return;
  }
  if (response.kind === 'exit') {
    routes.delete(response.ptyId);
    for (const sink of [...(remoteSinks.get(response.ptyId) ?? [])]) sink.onExit(response.exitCode);
    remoteSinks.delete(response.ptyId);
    return;
  }
  if (response.kind === 'notify') {
    deps?.invalidateDirectory();
    return;
  }
  if (response.kind === 'command') {
    // Only this window runs a service, so a losing window's webview commands
    // are run here on its behalf and answered back over this same socket.
    deps?.handleForwardedCommand(response.payload, client);
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
    const client: PeerLinkClient = {
      socket,
      decoder: new FrameDecoder(),
      authenticated: false,
      challenge: freshNonce(),
    };
    clients.add(client);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      for (const frame of client.decoder.push(chunk)) onServerFrame(client, frame);
    });
    socket.on('error', () => dropClient(client));
    socket.on('close', () => dropClient(client));
    // The server speaks first, on purpose: a client that has not yet seen proof
    // of the token must not volunteer one into whatever bound this path.
    send(client, { kind: 'challenge', nonce: client.challenge });
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
/** A change this window made while it had no broker to tell; sent on connect. */
let pendingNotify = false;
/** PTYs this window is streaming to the broker, and how to stop. */
const forwarding = new Map<string, () => void>();

function respond(frame: PeerLinkResponse): void {
  client?.write(encodeFrame(frame));
}

export function remoteNotifyPeerChange(): void {
  // The broker is the destination; its own window was notified directly.
  if (server) return;
  if (!client || client.destroyed) {
    pendingNotify = true;
    return;
  }
  respond({ kind: 'notify' });
}

/**
 * Hand one of this window's webview commands to the broker, reporting whether
 * there was a broker to hand it to.
 *
 * Not queued when there is none: a command is a user action with a timeout
 * behind it, and holding it until some window binds would answer it long after
 * the console call or the dialog that asked gave up.
 */
export function forwardCommand(payload: RemoteHostCommand): boolean {
  if (!client || client.destroyed) return false;
  respond({ kind: 'command', payload });
  return true;
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
      const { ptyId } = request;
      const stop = deps.streamPty(ptyId, {
        onData: (data) => respond({ kind: 'data', ptyId, data }),
        onExit: (exitCode) => {
          respond({ kind: 'exit', ptyId, exitCode });
          // The registry has already dropped this attachment, so the stored
          // unsubscribe is spent; what is left is to stop claiming the PTY.
          forwarding.delete(ptyId);
        },
      });
      forwarding.set(ptyId, stop);
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
    case 'commandResult':
      deps?.deliverCommandResult(request.payload);
      break;
    case 'uiEvent':
      deps?.deliverUiEvent(request.payload);
      break;
  }
}

function stopForwarding(): void {
  for (const stop of forwarding.values()) stop();
  forwarding.clear();
}

/**
 * Connect to whoever holds the socket and finish the mutual handshake.
 * `'refused'` means the path exists but nothing is listening on it — a broker
 * that died without unlinking — which is the caller's cue to clear it and bind.
 *
 * Between `connect` and a verified `welcome` this window sends exactly one
 * frame, its `hello`, and answers nothing: no directory, no PTY stream, no
 * command. Until the far end has proved it holds the token it is only a process
 * that guessed the path, and the whole point of the ordering is that guessing
 * the path is not enough to be served.
 */
function tryConnect(path: string, token: string): Promise<'connected' | 'refused' | 'failed'> {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    const decoder = new FrameDecoder();
    /** Ours, so the server's proof is over something it could not choose. */
    const nonce = freshNonce();
    let helloSent = false;
    let settled = false;

    const finish = (outcome: 'connected' | 'refused' | 'failed'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome !== 'connected') socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish('failed'), HANDSHAKE_BUDGET_MS);

    const drop = () => {
      if (client !== socket) return;
      client = null;
      stopForwarding();
      // The broker is gone. Every client races for the bind; one wins.
      if (!disposed) void contend();
    };

    const onFrame = (frame: unknown): void => {
      // Past the handshake — `client` is only ever assigned below — so this is
      // ordinary traffic from a broker that has proved itself.
      if (client === socket) {
        void onClientFrame(frame);
        return;
      }
      // The two handshake frames, read loosely: nothing here is trusted enough
      // yet to be typed as one of them.
      const message = frame as { kind?: string; nonce?: unknown; proof?: unknown };
      if (!helloSent) {
        if (message.kind !== 'challenge' || typeof message.nonce !== 'string' || !message.nonce) {
          log.error('[peer-link] the process holding the socket did not open with a challenge');
          finish('failed');
          return;
        }
        helloSent = true;
        // Answering a challenge proves nothing about the challenger, which is
        // why this is all that is sent until the welcome comes back.
        socket.write(
          encodeFrame({
            kind: 'hello',
            nonce,
            proof: proveToken(token, PEER_CLIENT_PROOF_DOMAIN, message.nonce),
          }),
        );
        return;
      }
      if (
        message.kind !== 'welcome' ||
        !proofMatches(message.proof, proveToken(token, PEER_SERVER_PROOF_DOMAIN, nonce))
      ) {
        // Whatever holds the path cannot prove it holds the token, so it is not
        // this installation's broker. Disconnect rather than serve it this
        // window's terminals; the contention loop retries and one of the real
        // windows ends up binding.
        log.error('[peer-link] the process holding the socket could not prove it is our broker');
        finish('failed');
        return;
      }
      // Proved in both directions: from here it is the broker.
      client = socket;
      if (pendingNotify) socket.write(encodeFrame({ kind: 'notify' }));
      pendingNotify = false;
      socket.removeAllListeners('error');
      socket.on('error', drop);
      socket.on('close', drop);
      log.info('[peer-link] connected to the broker window');
      finish('connected');
    };

    socket.setEncoding('utf8');
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'refused' : 'failed');
    });
    // A server that drops us mid-handshake (a bad hello) must settle the attempt
    // now rather than wait out the budget.
    socket.once('close', () => finish('failed'));
    socket.once('connect', () => {
      socket.on('data', (chunk: string) => {
        for (const frame of decoder.push(chunk)) onFrame(frame);
      });
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
/**
 * Latched when there is no safe place to put the socket. Unlike every other
 * failure here that is not transient — another user owns the only directory
 * these sockets may live in — so the link stands down for good instead of
 * spinning against it.
 */
let refused = false;
let nextAttemptAt = 0;
let announceRole: ((broker: boolean) => void) | null = null;
const settleListeners = new Set<() => void>();

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
  // retrying would produce one; neither would an unsafe socket directory.
  if (!context || disposed) return Promise.resolve();
  if (isPeerLinkSettled()) return Promise.resolve();
  const settled = new Promise<void>((resolve) => {
    const stop = onPeerLinkSettled(() => {
      stop();
      resolve();
    });
  });
  void contend();
  return settled;
}

/** Whether this window holds the Host. */
export function isPeerBroker(): boolean {
  return server !== null;
}

/**
 * Whether this window has a role right now: it brokers, it is connected to a
 * broker, or the link stood down for good. Not a latch — a broker dying takes
 * its clients back to unsettled while they race for the bind, which is exactly
 * the window in which a command has something to wait for rather than nothing
 * to reach (`remote-host.ts`).
 */
export function isPeerLinkSettled(): boolean {
  return server !== null || client !== null || refused;
}

/**
 * Be told whenever a role settles — the first one and every one after a
 * re-contention. Returns the unsubscribe.
 */
export function onPeerLinkSettled(listener: () => void): () => void {
  settleListeners.add(listener);
  return () => {
    settleListeners.delete(listener);
  };
}

function settle(broker: boolean): void {
  // Before the listeners: whoever is waiting on a settle is waiting to route
  // somewhere, and a broker has to be serving by the time they do.
  if (broker) announceRole?.(true);
  for (const listener of [...settleListeners]) listener();
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
  if (!(await peerDirIsSafe())) {
    log.error(
      `[peer-link] ${peerDirPath()} is not a private directory of this user; the peer link is off`,
    );
    refused = true;
    // A role of sorts: this window will never broker and will never reach one,
    // so callers waiting on the contention are released rather than left
    // hanging on a loop that has stopped.
    settle(false);
    return true;
  }
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

  let outcome = await tryConnect(path, token);
  if (outcome === 'refused') {
    // The path exists but nothing answers: a broker that died without running
    // its disposables.
    //
    // Every client of that broker reaches this line at the same instant, so the
    // unlink is jittered — otherwise they clear the corpse in lockstep, several
    // bind, and all but one end up serving an inode nobody can reach.
    await delay(Math.floor(Math.random() * RECLAIM_JITTER_MS));
    // And one of them may have rebound it while we waited. Unlinking a live
    // broker's socket would strand every window dialing it, so ask again: a
    // second refusal is what makes the unlink below safe.
    outcome = await tryConnect(path, token);
    if (outcome === 'refused') {
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
        // Another window cleared the same corpse and bound after us, so the
        // path now names its socket and ours is unreachable. Stand down rather
        // than run a second Host: `bind` is only the arbiter when nobody
        // unlinks. The loop's next round finds that window and connects.
        await closeServer(false);
      }
      return false;
    }
  }
  if (outcome === 'connected') {
    // Same as the bind above: a connection opened after disposal has nobody
    // left to close it.
    if (disposed) disconnectClient();
    else settle(false);
    return true;
  }
  return false;
}

/** How long to let a competing reclaim land before believing we won it. */
const RECLAIM_VERIFY_MS = 250;
/** Spread over which a stampede of orphaned clients clears one corpse. */
const RECLAIM_JITTER_MS = 250;

/**
 * Whether the socket path still names the inode we just bound.
 *
 * Two windows can find the same corpse and both unlink it, and the second bind
 * silently displaces the first — the loser keeps serving an inode no client can
 * reach. Nothing on the bind path detects that, so it is checked afterwards.
 *
 * A path that has *gone* is the same failure on unix: somebody unlinked it after
 * our bind, so every window dialing it will miss us. Only Windows may read that
 * as ours — named pipes are not filesystem objects, cannot be stat-ed, and die
 * with the process that made them, so nothing there can displace us.
 */
async function stillOurs(path: string): Promise<boolean> {
  const unstattable = process.platform === 'win32';
  const mine = await stat(path).catch(() => null);
  if (!mine) return unstattable;
  await delay(RECLAIM_VERIFY_MS);
  const now = await stat(path).catch(() => null);
  if (!now) return unstattable;
  return now.ino === mine.ino;
}

async function contend(): Promise<void> {
  if (contending || disposed) return;
  contending = true;
  try {
    while (!disposed && !refused && !server && !client) {
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
