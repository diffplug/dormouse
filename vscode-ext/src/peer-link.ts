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
  /**
   * Whether this window's own PTY manager holds that id.
   *
   * Peer PTYs are exposed through generated route handles rather than their
   * owner-local ids, because "Duplicate Workspace in New Window" can
   * cold-restore the same ids in several windows. This check keeps even that
   * generated provider-local handle out of the local manager's namespace.
   */
  ownsPty(ptyId: string): boolean;
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

/**
 * How long a window losing the exclusive create will wait for the winner's
 * bytes ({@link readSharedToken}). The write is one `writeFile` of a UUID, so
 * the gap it covers is microseconds — this is sized to be unmissable, not tuned.
 */
const TOKEN_WRITE_ATTEMPTS = 10;
const TOKEN_WRITE_POLL_MS = 20;

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
 * Read the shared token, treating a file that is present but empty as *not yet
 * written* rather than as a token.
 *
 * `writeFile(..., { flag: 'wx' })` creates the file before it writes the bytes,
 * so a window reading in that gap sees zero length. Returning `''` from there
 * would be unrecoverable rather than merely wrong: an empty `serverToken` makes
 * {@link onServerFrame}'s `!serverToken` reject every hello, and a broker never
 * re-reads the token, so every other window retries at 1 Hz and is never served.
 */
async function readSharedToken(path: string): Promise<string | null> {
  const raw = await readFile(path, 'utf8').catch(() => null);
  return raw && raw.trim() ? raw.trim() : null;
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
  const existing = await readSharedToken(path);
  if (existing) return existing;
  await mkdir(join(path, '..'), { recursive: true }).catch(() => {});
  const token = randomUUID();
  try {
    // 0600: the token is the only thing between another local process and this
    // installation's terminals, so it is never briefly world-readable.
    await writeFile(path, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return token;
  } catch (writeError) {
    // `EEXIST` — another window created it, and the empty read above may have
    // been that same window mid-write, so wait the bytes out. Bounded, because
    // a token file left zero-length by a crash never fills in: throwing hands
    // the caller its existing stand-down path, which at least says so in the
    // log, rather than a broker that silently refuses every peer forever.
    for (let attempt = 0; attempt < TOKEN_WRITE_ATTEMPTS; attempt++) {
      const written = await readSharedToken(path);
      if (written) return written;
      await delay(TOKEN_WRITE_POLL_MS);
    }
    // Not only the crash-left empty file: `open(O_CREAT|O_EXCL)` on a token
    // path that is a directory — or that we cannot read — is `EEXIST` too, so
    // those land here as well. The caller's log line is the only diagnosis any
    // of them gets, so re-derive which it was rather than asserting one.
    const why = await readFile(path, 'utf8').then(
      () => 'is empty',
      // The create error rides along only here: an unwritable `globalStorageUri`
      // fails the create with `EACCES` and then the read with `ENOENT`, and the
      // read alone would name the missing file rather than why it is missing.
      (error: unknown) =>
        `could not be read: ${String(error)}; creating it failed with ${String(writeError)}`,
    );
    throw new Error(`peer link token file ${path} ${why}`);
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
  /** Bounds a connection that accepts the challenge and then says nothing. */
  handshakeTimer: ReturnType<typeof setTimeout> | null;
}

/** Where bytes from another window's PTY go, once something asks for them. */
export interface RemotePtySink {
  onData(data: string): void;
  onExit(exitCode: number): void;
}

let server: Server | null = null;
/**
 * Whether the bind in `server` has been *believed*.
 *
 * A reclaimed bind is provisional: `stillOurs` spends 250 ms watching for a
 * competing window that cleared the same corpse and bound after us, and the
 * loser stands down through `closeServer(false)`. Between the bind and that
 * verdict `server !== null` is true while this window may be about to give the
 * socket up, so every *role* answer reads this instead — otherwise an enroll or
 * a secrets-change landing inside that window is told it is the broker, starts
 * a service, and the stand-down never tears it down: two Hosts under one hostId,
 * displacing each other on the relay forever.
 */
let brokerConfirmed = false;
/** Claimed and cleared with `server`; the two always move together. */
let serverToken: string | null = null;
const clients = new Set<PeerLinkClient>();
/** Provider-local route handle → the peer window that owns it. */
const routes = new Map<string, PeerLinkClient>();
/** Provider-local route handle → the id understood inside that peer window. */
const routePtyIds = new Map<string, string>();
/** Every opaque peer handle minted in this process, including closed routes. */
const remotePtyHandles = new Set<string>();
/** Stable handles for repeated resolves of one PTY on one live peer socket. */
const peerRouteIds = new WeakMap<PeerLinkClient, Map<string, string>>();
const remoteSinks = new Map<string, Set<RemotePtySink>>();

interface PendingRemoteSubscription {
  client: PeerLinkClient;
  routeId: string;
  promise: Promise<void>;
  settle(): void;
}

/** Subscribe acknowledgement by frame id, plus its one in-flight id per route. */
const pendingRemoteSubscriptions = new Map<string, PendingRemoteSubscription>();
const pendingRemoteSubscriptionByRoute = new Map<string, string>();

/**
 * One outstanding {@link ask}, and the window it is outstanding against — so a
 * window that disconnects can settle its own without touching anyone else's.
 */
interface PendingPeerRequest {
  client: PeerLinkClient;
  settle(response: PeerLinkResponse | null): void;
}
const pendingRequests = new Map<string, PendingPeerRequest>();
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
  // Surface/directory requests use this response table. Stream readiness has
  // its own subscribe table below; everything after readiness is one-way and
  // correlated by `ptyId` or by the `rhId` already inside it.
  frame: Extract<PeerLinkRequest, { kind: 'request' }>,
): Promise<PeerLinkResponse | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(frame.id);
      resolve(null);
    }, PEER_REPLY_BUDGET_MS);
    pendingRequests.set(frame.id, {
      client,
      settle: (response) => {
        clearTimeout(timer);
        pendingRequests.delete(frame.id);
        resolve(response);
      },
    });
    send(client, frame);
  });
}

function authenticatedClients(): PeerLinkClient[] {
  return [...clients].filter((client) => client.authenticated);
}

/**
 * Bind an owner-local PTY id to the socket that answered for it.
 *
 * The returned string is deliberately opaque to the provider. Two windows can
 * restore the same PTY id, so returning either owner's raw id would let a later
 * answer overwrite the selected surface's stream/write route. One stable token
 * per `(socket, ptyId)` makes the selected answer carry its owner with it.
 */
function bindRemotePty(client: PeerLinkClient, ptyId: string): string {
  let byPty = peerRouteIds.get(client);
  if (!byPty) {
    byPty = new Map();
    peerRouteIds.set(client, byPty);
  }
  let routeId = byPty.get(ptyId);
  if (!routeId) {
    do {
      routeId = `peer:${randomUUID()}`;
    } while (routes.has(routeId) || deps?.ownsPty(routeId));
    byPty.set(ptyId, routeId);
  }
  remotePtyHandles.add(routeId);
  routes.set(routeId, client);
  routePtyIds.set(routeId, ptyId);
  return routeId;
}

/** Every provider-local handle matching one owner-local PTY on this socket. */
function matchingRoutes(client: PeerLinkClient, ptyId: string): string[] {
  const matches: string[] = [];
  for (const [routeId, owner] of routes) {
    if (owner === client && routePtyIds.get(routeId) === ptyId) matches.push(routeId);
  }
  return matches;
}

function settleRemoteSubscription(routeId: string): void {
  const id = pendingRemoteSubscriptionByRoute.get(routeId);
  if (!id) return;
  pendingRemoteSubscriptions.get(id)?.settle();
}

/**
 * Wait until the owner has installed its sink and checked durable PTY liveness.
 * A silent peer is treated like a closed PTY, keeping an attach bounded and
 * fail-closed instead of acknowledging a stream that may not exist.
 */
function beginRemoteSubscription(
  client: PeerLinkClient,
  routeId: string,
  ownerPtyId: string,
): Promise<void> {
  const id = `s${++nextRequestId}`;
  let resolveReady!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const timer = setTimeout(() => {
    const pending = pendingRemoteSubscriptions.get(id);
    if (!pending) return;
    // The owner may have installed the sink even though its acknowledgement was
    // lost or delayed. Stop it while its route is still known, or timeout would
    // leave that window forwarding an orphaned stream indefinitely.
    send(client, { kind: 'unsubscribe', ptyId: ownerPtyId });
    routes.delete(routeId);
    routePtyIds.delete(routeId);
    for (const sink of [...(remoteSinks.get(routeId) ?? [])]) sink.onExit(0);
    remoteSinks.delete(routeId);
    pending.settle();
  }, PEER_REPLY_BUDGET_MS);
  (timer as unknown as { unref?: () => void }).unref?.();

  const settle = () => {
    if (pendingRemoteSubscriptions.get(id)?.routeId !== routeId) return;
    clearTimeout(timer);
    pendingRemoteSubscriptions.delete(id);
    if (pendingRemoteSubscriptionByRoute.get(routeId) === id) {
      pendingRemoteSubscriptionByRoute.delete(routeId);
    }
    resolveReady();
  };
  pendingRemoteSubscriptions.set(id, { client, routeId, promise, settle });
  pendingRemoteSubscriptionByRoute.set(routeId, id);
  send(client, { kind: 'subscribe', id, ptyId: ownerPtyId });
  return promise;
}

/** JSON primitives and arrays are parseable, but no peer frame can be one. */
function isFrameObject(frame: unknown): frame is Record<string, unknown> {
  return typeof frame === 'object' && frame !== null && !Array.isArray(frame);
}

/**
 * Put one peer request to every other window and collect what they answer, or
 * address one follow-up to the peer retained by `ownerPtyId`. Empty when
 * nothing is connected, and when nobody owned what was asked about.
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
export async function remoteRequest(
  op: string,
  params: unknown,
  ownerPtyId?: string,
): Promise<unknown[]> {
  const selectedPeer = ownerPtyId ? routes.get(ownerPtyId) : undefined;
  const peers = ownerPtyId
    ? selectedPeer?.authenticated
      ? [selectedPeer]
      : []
    : authenticatedClients();
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
      if (!ptyId) {
        results.push(result);
        continue;
      }
      // The PTY id in a peer's answer is only meaningful inside that window.
      // Replace it before the result reaches `createAskSurfaceProvider`, so the
      // selected SurfaceHandle retains the responding socket even when another
      // peer answered with the exact same restored surface and PTY ids.
      results.push({
        ...(result as Record<string, unknown>),
        ptyId: bindRemotePty(client, ptyId),
      });
    }
  }
  return results;
}

/** Whether this provider-local PTY key routes to another window. */
export function isRemotePty(ptyId: string): boolean {
  return routes.get(ptyId) !== undefined;
}

/** Whether this key originated from a peer, even if that route has since closed. */
export function isRemotePtyHandle(ptyId: string): boolean {
  return remotePtyHandles.has(ptyId);
}

/** Resolve once the owning window has installed the sink and checked liveness. */
export function remoteSubscribe(ptyId: string, sink: RemotePtySink): Promise<void> {
  const client = routes.get(ptyId);
  const ownerPtyId = routePtyIds.get(ptyId);
  if (!client || !ownerPtyId) {
    sink.onExit(0);
    return Promise.resolve();
  }
  // Reference-counted per PTY: two attachments to the same foreign surface
  // share one stream over the link, and only zero-to-one starts the owner
  // forwarding — so a second viewer never restarts a stream that is already
  // flowing, and one viewer detaching cannot silence the other.
  let sinks = remoteSinks.get(ptyId);
  if (!sinks) {
    sinks = new Set();
    remoteSinks.set(ptyId, sinks);
    sinks.add(sink);
    return beginRemoteSubscription(client, ptyId, ownerPtyId);
  }
  sinks.add(sink);
  const pendingId = pendingRemoteSubscriptionByRoute.get(ptyId);
  return pendingId
    ? pendingRemoteSubscriptions.get(pendingId)?.promise ?? Promise.resolve()
    : Promise.resolve();
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
  const ownerPtyId = routePtyIds.get(ptyId);
  if (client && ownerPtyId) send(client, { kind: 'unsubscribe', ptyId: ownerPtyId });
  settleRemoteSubscription(ptyId);
}

export function remoteWrite(ptyId: string, data: string): boolean {
  const client = routes.get(ptyId);
  const ownerPtyId = routePtyIds.get(ptyId);
  if (!client || !ownerPtyId) return false;
  send(client, { kind: 'write', ptyId: ownerPtyId, data });
  return true;
}

export function remoteResize(ptyId: string, cols: number, rows: number): boolean {
  const client = routes.get(ptyId);
  const ownerPtyId = routePtyIds.get(ptyId);
  if (!client || !ownerPtyId) return false;
  send(client, { kind: 'resizePty', ptyId: ownerPtyId, cols, rows });
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
  if (client.handshakeTimer) clearTimeout(client.handshakeTimer);
  client.handshakeTimer = null;
  const wasAuthenticated = clients.delete(client) && client.authenticated;
  // A window that went away takes its terminals with it; a later write must not
  // be routed into a dead socket.
  for (const routeId of forgetPeerRoutes(routes, client)) {
    routePtyIds.delete(routeId);
    for (const sink of remoteSinks.get(routeId) ?? []) sink.onExit(0);
    remoteSinks.delete(routeId);
    settleRemoteSubscription(routeId);
  }
  // Anything this window was still being asked can never be answered either,
  // and holding it open to its full reply budget stalls the whole collection it
  // belongs to — a directory or an attach that every surviving window already
  // answered. Settle them empty now: "gone" and "owns nothing" look the same to
  // the caller, which is exactly right.
  for (const [id, pending] of [...pendingRequests]) {
    if (pending.client !== client) continue;
    pendingRequests.delete(id);
    pending.settle(null);
  }
  // Its in-flight commands can never be answered: the socket that would carry
  // the answer is the one that closed. The asking webview's own timeout is the
  // backstop, and that window is on its way to becoming a broker anyway.
  deps?.dropForwardedCommands(client);
  if (wasAuthenticated) deps?.invalidateDirectory();
  client.socket.destroy();
}

function onServerFrame(client: PeerLinkClient, frame: unknown): void {
  if (!isFrameObject(frame)) {
    log.error('[peer-link] rejected a client frame that is not an object');
    dropClient(client);
    return;
  }
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
    if (client.handshakeTimer) clearTimeout(client.handshakeTimer);
    client.handshakeTimer = null;
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
    for (const routeId of matchingRoutes(client, response.ptyId)) {
      for (const sink of remoteSinks.get(routeId) ?? []) sink.onData(response.data);
    }
    return;
  }
  if (response.kind === 'exit') {
    for (const routeId of matchingRoutes(client, response.ptyId)) {
      routes.delete(routeId);
      routePtyIds.delete(routeId);
      for (const sink of [...(remoteSinks.get(routeId) ?? [])]) sink.onExit(response.exitCode);
      remoteSinks.delete(routeId);
      settleRemoteSubscription(routeId);
    }
    return;
  }
  if (response.kind === 'subscribed') {
    const pending = pendingRemoteSubscriptions.get(response.id);
    if (pending?.client === client) pending.settle();
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
  if ('id' in response) {
    // Only from the window it was put to: request ids are minted per broker, so
    // a window answering another's id would settle a collection it was never
    // asked to contribute to.
    const pending = pendingRequests.get(response.id);
    if (pending?.client === client) pending.settle(response);
  }
}

/** Turn Server.listen's event-based bind failure into a rejecting promise. */
export function listenServer(nextServer: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    nextServer.once('error', onError);
    try {
      nextServer.listen(path, () => {
        nextServer.off('error', onError);
        // Past `listen` the only `'error'` this server can emit is an
        // accept-time one — EMFILE, a pipe error on Windows — and an
        // EventEmitter with no listener for `'error'` *throws*, which would
        // take the whole extension host down over one refused connection. So
        // there is always one from here on. Logging is all it does: the
        // connections already accepted are unaffected, and a listener that has
        // genuinely died is noticed by the windows that can no longer reach it,
        // which re-contend. Deeper recovery is the contention loop's job.
        nextServer.on('error', (error: Error) => {
          log.error(`[peer-link] peer server error: ${String(error)}`);
        });
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
      handshakeTimer: null,
    };
    clients.add(client);
    client.handshakeTimer = setTimeout(() => {
      log.error('[peer-link] dropped a client that did not finish the handshake');
      dropClient(client);
    }, HANDSHAKE_BUDGET_MS);
    client.handshakeTimer.unref();
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
  // Provisional until the caller settles it: a reclaimed bind may still be
  // displaced (see {@link brokerConfirmed}).
  brokerConfirmed = false;
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
  if (client) respondTo(client, frame);
}

/**
 * Answer only the broker socket that issued the work.
 *
 * A webview fan-out is asynchronous. If its broker disconnects while that work
 * is in flight, this window can connect to a replacement before the old answer
 * lands. Writing through the module-level `client` then sends broker A's answer
 * to broker B, whose request ids start over and may correlate it to unrelated
 * work. Socket identity is the generation fence.
 */
function respondTo(socket: Socket, frame: PeerLinkResponse): void {
  if (client !== socket || socket.destroyed) return;
  socket.write(encodeFrame(frame));
}

export function remoteNotifyPeerChange(): void {
  // The broker is the destination; its own window was notified directly. An
  // unverified bind is not that yet, so the change is held as pending and sent
  // if this window turns out to be a client ({@link brokerConfirmed}).
  if (isPeerBroker()) return;
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

async function onClientFrame(socket: Socket, frame: unknown): Promise<void> {
  if (!isFrameObject(frame)) {
    log.error('[peer-link] ignored a broker frame that is not an object');
    return;
  }
  const request = frame as PeerLinkRequest;
  switch (request.kind) {
    case 'request': {
      let results: unknown[] = [];
      try {
        results = (await deps?.brokerRequest(request.op, request.params)) ?? [];
      } catch (error) {
        // One failed webview fan-out contributes no answer. Contain it here:
        // this handler is event-driven, so a rejection allowed to escape would
        // otherwise be unhandled in the extension host.
        log.error(`[peer-link] peer request ${request.op} failed: ${String(error)}`);
      }
      respondTo(socket, {
        kind: 'result',
        id: request.id,
        results,
      });
      break;
    }
    case 'subscribe': {
      if (forwarding.has(request.ptyId)) {
        respondTo(socket, { kind: 'subscribed', id: request.id, ptyId: request.ptyId });
        break;
      }
      if (!deps) break;
      const { ptyId } = request;
      let exitedWhileSubscribing = false;
      const stop = deps.streamPty(ptyId, {
        onData: (data) => respondTo(socket, { kind: 'data', ptyId, data }),
        onExit: (exitCode) => {
          exitedWhileSubscribing = true;
          respondTo(socket, { kind: 'exit', ptyId, exitCode });
          // The registry has already dropped this attachment, so the stored
          // unsubscribe is spent; what is left is to stop claiming the PTY.
          forwarding.delete(ptyId);
        },
      });
      // `streamPty` synchronously replays an exit that predates this request.
      // Do not install its already-spent unsubscribe after the callback removed
      // the forwarding entry: a later resolve must be able to replay again.
      if (!exitedWhileSubscribing) forwarding.set(ptyId, stop);
      // Ordered after a synchronous exit replay on this same socket. The broker
      // cannot settle stream readiness until it has observed that close.
      respondTo(socket, { kind: 'subscribed', id: request.id, ptyId });
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
        void onClientFrame(socket, frame).catch((error: unknown) => {
          log.error(`[peer-link] broker frame failed: ${String(error)}`);
        });
        return;
      }
      // The two handshake frames, read loosely: nothing here is trusted enough
      // yet to be typed as one of them.
      if (!isFrameObject(frame)) {
        log.error('[peer-link] the process holding the socket sent a non-object handshake frame');
        finish('failed');
        return;
      }
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
  // `isPeerBroker()` rather than `server !== null`: a bind that has not been
  // verified yet may still be stood down, and answering `true` for it starts a
  // service the stand-down cannot reach ({@link brokerConfirmed}). Unverified
  // falls through and waits for the settle, which answers either way.
  if (isPeerBroker()) {
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

/** Whether this window holds the Host — verified, not merely bound. */
export function isPeerBroker(): boolean {
  return server !== null && brokerConfirmed;
}

/**
 * Whether this window has a role right now: it brokers, it is connected to a
 * broker, or the link stood down for good. Not a latch — a broker dying takes
 * its clients back to unsettled while they race for the bind, which is exactly
 * the window in which a command has something to wait for rather than nothing
 * to reach (`remote-host.ts`).
 */
export function isPeerLinkSettled(): boolean {
  // A destroyed socket is not a role: `close` is a later tick, and until it
  // lands and re-contends there is nothing to forward to — which is exactly
  // what {@link forwardCommand} reports, so the two must agree. Nor is an
  // unverified bind, for the same reason ({@link brokerConfirmed}).
  return isPeerBroker() || (client !== null && !client.destroyed) || refused;
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
  let token: string;
  try {
    token = await ensureToken();
  } catch (error) {
    // The same shape as the unsafe-directory branch above, for the same reason:
    // an unwritable `globalStorageUri` is not a transient failure, and retrying
    // at 1 Hz forever leaves every command waiting out its whole queue budget
    // on every attempt rather than being told there is nothing to reach.
    log.error(
      `[peer-link] could not read or create the shared token; the peer link is off: ${String(error)}`,
    );
    refused = true;
    settle(false);
    return true;
  }

  if (await tryBind(path, token)) {
    // Disposal can land inside any of the awaits above; a socket bound after it
    // would outlive the window that owns it.
    if (disposed) {
      await closeServer(true);
      return true;
    }
    log.info('[peer-link] serving peers');
    // Nothing can displace an uncontested bind, so it is believed immediately.
    brokerConfirmed = true;
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
    // bind, and all but one end up serving a socket nobody can reach.
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
          // Only now: until the verification returns, this window may still be
          // the one that stands down ({@link brokerConfirmed}).
          brokerConfirmed = true;
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
 * Whether the socket path still names the filesystem object we just bound.
 *
 * Two windows can find the same corpse and both unlink it, and the second bind
 * silently displaces the first — the loser keeps serving a socket no client can
 * reach. Nothing on the bind path detects that, so it is checked afterwards.
 * Inode alone is not an identity: Linux may immediately recycle the corpse's
 * inode for a replacement socket. The inode's change timestamp distinguishes
 * those generations, while the device keeps the tuple complete.
 *
 * A path that has *gone* is the same failure on unix: somebody unlinked it after
 * our bind, so every window dialing it will miss us. Only Windows may read that
 * as ours — named pipes are not filesystem objects, cannot be stat-ed, and die
 * with the process that made them, so nothing there can displace us.
 */
interface SocketFileIdentity {
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
}

async function socketFileIdentity(path: string): Promise<SocketFileIdentity | null> {
  const value = await stat(path, { bigint: true }).catch(() => null);
  return value
    ? { dev: value.dev, ino: value.ino, ctimeNs: value.ctimeNs }
    : null;
}

function sameSocketFile(left: SocketFileIdentity, right: SocketFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.ctimeNs === right.ctimeNs;
}

async function stillOurs(path: string): Promise<boolean> {
  const unstattable = process.platform === 'win32';
  const mine = await socketFileIdentity(path);
  if (!mine) return unstattable;
  await delay(RECLAIM_VERIFY_MS);
  const now = await socketFileIdentity(path);
  if (!now) return unstattable;
  return sameSocketFile(now, mine);
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
  brokerConfirmed = false;
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
