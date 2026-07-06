/**
 * The relay hub (docs/specs/server.md, "Relay"): routes JSON envelopes between
 * Client sockets and Host sockets. It is the coordinating Server's dumb pipe —
 * before a session is authorized it forwards only the handshake allowlist
 * (`pair`/`connect`/`connect2` up, `pair-result`/`challenge`/`decision` down);
 * after authorization it forwards `msg` frames verbatim.
 *
 * State is deliberately tiny and in-memory (a server restart just means everyone
 * reconnects) and the machine is kept small so connection *verification* layers
 * on top without reshaping it:
 *
 *   - one live socket per `hostId` (a reconnect replaces the old socket);
 *   - each client is bound to at most one host (`clientId → hostId`) and carries
 *     an `established` flag that gates `msg` in both directions;
 *   - the session becomes established purely on the Host's authority — when the
 *     Host sends `{ t: 'decision', allowed: true }` for that client.
 *
 * `clientId` is a server-assigned secret: it is stamped onto every host-bound
 * frame so the Host can address replies, but is never sent to the client.
 *
 * Verification layers on top without reshaping any of this: the hub
 * consults an injected {@link HandshakeGate} before relaying the two
 * security-critical Client frames (`pair`, `connect2`) and remembers each Host
 * challenge it relays, but the routing and session model are untouched.
 */

import { randomBytes } from 'node:crypto';

import { toBase64Url } from 'server-lib-common';
import type {
  ClientFrame,
  HostFrame,
  ServerToClientFrame,
  ServerToHostFrame,
} from 'server-lib-common';

import type { HandshakeGate, PresenceSession } from './handshake.js';

/**
 * The slice of a WebSocket the hub actually uses. `WSContext` from
 * `@hono/node-ws` satisfies it, but keeping the surface this small keeps the
 * routing logic transport-agnostic and unit-testable.
 */
export interface RelaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** A live Host socket. */
export interface HostConn {
  readonly hostId: string;
  readonly socket: RelaySocket;
}

/** A live Client socket and its (single) relationship to a Host. */
export interface ClientConn {
  readonly clientId: string;
  readonly socket: RelaySocket;
  /** The authenticated session behind this socket; the gate reads/refreshes its presence stamp. */
  readonly session: PresenceSession;
  /** The Host this client is currently talking to, or `null` if unbound. */
  hostId: string | null;
  /** Whether `msg` frames may flow — set true only by an allowed Host decision. */
  established: boolean;
}

export class RelayHub {
  readonly #hosts = new Map<string, HostConn>();
  readonly #clients = new Map<string, ClientConn>();
  readonly #gate: HandshakeGate;

  constructor(gate: HandshakeGate) {
    this.#gate = gate;
  }

  /** True while a socket for `hostId` is connected — drives `GET /api/hosts` presence. */
  isHostOnline(hostId: string): boolean {
    return this.#hosts.has(hostId);
  }

  // --- Host lifecycle -------------------------------------------------------

  /**
   * Register a freshly-opened Host socket. Only one socket may own a `hostId`,
   * so an existing one is displaced and closed; the displaced socket's `close`
   * event is ignored by {@link unregisterHost} because the map already points
   * at the new connection (a generation guard).
   *
   * A replacement also invalidates every session established with the OLD Host
   * process: the new process has a fresh ACL and no memory of them, so their
   * in-flight `msg` frames must never be treated as authorized. Handling this
   * on disconnect alone is not enough; because the displaced socket's `close` is
   * a no-op here, the invalidation has to happen at replacement time too.
   */
  registerHost(hostId: string, socket: RelaySocket): HostConn {
    const conn: HostConn = { hostId, socket };
    const existing = this.#hosts.get(hostId);
    this.#hosts.set(hostId, conn);
    if (existing) {
      this.#dropClientsOf(hostId);
      safeClose(existing.socket, 4000, 'replaced by a newer host connection');
    }
    return conn;
  }

  /** Handle one raw frame from a Host socket. Unknown/malformed frames are ignored. */
  onHostFrame(host: HostConn, raw: string): void {
    // Only the socket the map points at speaks for a hostId: a socket displaced
    // by registerHost can still deliver queued frames, and treating them as
    // current would resurrect sessions the replacement just invalidated (a late
    // `decision` re-establishing, or `msg` data from the dead host process).
    if (this.#hosts.get(host.hostId) !== host) return;
    const frame = parseFrame<HostFrame>(raw);
    if (!frame || typeof frame.t !== 'string' || typeof frame.clientId !== 'string') return;
    // Every host frame addresses a specific client; if it has already gone,
    // there is nothing to route (and no session to establish).
    const client = this.#clients.get(frame.clientId);
    if (!client) return;
    // Host replies are only meaningful while the client is still bound to that
    // host. A client socket may leave host A for host B before A answers; late
    // handshake replies from A must not reach the active client or re-establish
    // an old session.
    if (client.hostId !== host.hostId) return;
    switch (frame.t) {
      case 'pair-result':
        this.#toClient(client, {
          t: 'pair-result',
          approved: frame.approved,
          record: frame.record,
          error: frame.error,
        });
        return;
      case 'challenge':
        // The client's `challenge` frame carries the originating hostId (the
        // host frame does not — the hub knows it from the socket). The server
        // also remembers the challenge so it can do its half of `connect2`
        // freshness validation before forwarding.
        this.#gate.observeChallenge(client.clientId, host.hostId, frame.challenge, frame.expiresAt);
        this.#toClient(client, {
          t: 'challenge',
          hostId: host.hostId,
          challenge: frame.challenge,
          expiresAt: frame.expiresAt,
        });
        return;
      case 'decision':
        // The Host is the final authority: an allowed decision is what
        // establishes the (host, client) session and unblocks `msg`.
        if (frame.allowed) {
          client.hostId = host.hostId;
          client.established = true;
        }
        this.#toClient(client, {
          t: 'decision',
          allowed: frame.allowed,
          failures: frame.failures,
        });
        return;
      case 'msg':
        // Blocked unless this exact host/client pair has an established session.
        if (client.established && client.hostId === host.hostId) {
          this.#toClient(client, { t: 'msg', data: frame.data });
        }
        return;
      default:
        return; // unknown host frame type — ignore
    }
  }

  /**
   * Tear down a Host socket. Guarded so a socket displaced by
   * {@link registerHost} is a no-op. Its clients are told `host-gone` and their
   * sessions cleared (no resume protocol — they reconnect).
   */
  unregisterHost(host: HostConn): void {
    if (this.#hosts.get(host.hostId) !== host) return; // already replaced
    this.#hosts.delete(host.hostId);
    this.#dropClientsOf(host.hostId);
  }

  /**
   * Tell every client bound to `hostId` its Host is gone and clear its session,
   * so no `msg` can flow to a Host that is no longer the one it handshook with.
   * Used on both Host disconnect and Host replacement.
   */
  #dropClientsOf(hostId: string): void {
    for (const client of this.#clients.values()) {
      if (client.hostId === hostId) {
        this.#toClient(client, { t: 'host-gone' });
        client.hostId = null;
        client.established = false;
      }
    }
  }

  // --- Client lifecycle -----------------------------------------------------

  /** Register a freshly-opened Client socket with a fresh secret `clientId`. */
  registerClient(socket: RelaySocket, session: PresenceSession): ClientConn {
    const clientId = toBase64Url(randomBytes(16));
    const conn: ClientConn = { clientId, socket, session, hostId: null, established: false };
    this.#clients.set(clientId, conn);
    return conn;
  }

  /**
   * Handle one raw frame from a Client socket. Malformed/unknown frames get an
   * `error`. Async because `pair` and `connect2` consult the {@link HandshakeGate}
   * (account lookups, crypto); the WS handler serializes calls per socket so
   * frames from one client stay in order.
   */
  async onClientFrame(client: ClientConn, raw: string): Promise<void> {
    const frame = parseFrame<ClientFrame>(raw);
    if (!frame || typeof frame.t !== 'string') {
      this.#toClient(client, { t: 'error', error: 'malformed frame' });
      return;
    }
    switch (frame.t) {
      case 'pair':
      case 'connect':
      case 'connect2': {
        if (typeof frame.hostId !== 'string') {
          this.#toClient(client, { t: 'error', error: 'missing hostId' });
          return;
        }
        const host = this.#hosts.get(frame.hostId);
        if (!host) {
          this.#toClient(client, { t: 'error', error: `host ${frame.hostId} is offline` });
          return;
        }
        // Binding to a (new) host, or re-attempting `connect`, drops any prior
        // established session — a client holds at most one at a time.
        if (client.hostId !== null && client.hostId !== frame.hostId) {
          const previousHost = this.#hosts.get(client.hostId);
          if (previousHost) {
            this.#toHost(previousHost, { t: 'client-gone', clientId: client.clientId });
          }
        }
        if (client.hostId !== frame.hostId || frame.t === 'connect') {
          client.established = false;
        }
        client.hostId = frame.hostId;

        if (frame.t === 'connect') {
          this.#toHost(host, { t: 'connect', clientId: client.clientId });
          return;
        }
        if (frame.t === 'pair') {
          // Only relay a pairing request the authenticated session could have
          // made: the owner account, a registered credential, a matching key
          // hash, and fresh session presence. A forged or stale request is
          // answered locally and never reaches the Host.
          const check = await this.#gate.checkPair(frame.request, client.session);
          if (!this.#isCurrentClientHost(client, frame.hostId, host)) return;
          if (!check.ok) {
            this.#toClient(client, { t: 'pair-result', approved: false, error: check.error });
            return;
          }
          this.#toHost(host, { t: 'pair', clientId: client.clientId, request: frame.request });
          return;
        }
        // connect2: the server verifies the assertion (against the STORED key)
        // and challenge freshness before forwarding. On failure the client gets
        // a denial and the Host's challenge stays unburned.
        const check = await this.#gate.checkConnect2(
          client.clientId,
          frame.hostId,
          frame.request,
          client.session,
        );
        if (!this.#isCurrentClientHost(client, frame.hostId, host)) return;
        if (!check.ok) {
          this.#toClient(client, { t: 'decision', allowed: false, failures: check.failures });
          return;
        }
        this.#toHost(host, { t: 'connect2', clientId: client.clientId, request: frame.request });
        return;
      }
      case 'msg':
        // Blocked until the session is established; silently dropped otherwise.
        if (client.established && client.hostId !== null) {
          const host = this.#hosts.get(client.hostId);
          if (host) this.#toHost(host, { t: 'msg', clientId: client.clientId, data: frame.data });
        }
        return;
      default:
        this.#toClient(client, { t: 'error', error: 'unknown frame type' });
        return;
    }
  }

  /** Tear down a Client socket: tell its Host `client-gone`, then forget it. */
  unregisterClient(client: ClientConn): void {
    this.#clients.delete(client.clientId);
    this.#gate.forgetClient(client.clientId);
    if (client.hostId !== null) {
      const host = this.#hosts.get(client.hostId);
      if (host) this.#toHost(host, { t: 'client-gone', clientId: client.clientId });
    }
  }

  // --- Sending --------------------------------------------------------------

  #toClient(client: ClientConn, frame: ServerToClientFrame): void {
    safeSend(client.socket, frame);
  }

  #toHost(host: HostConn, frame: ServerToHostFrame): void {
    safeSend(host.socket, frame);
  }

  #isCurrentClientHost(client: ClientConn, hostId: string, host: HostConn): boolean {
    return (
      this.#clients.get(client.clientId) === client &&
      client.hostId === hostId &&
      this.#hosts.get(hostId) === host
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers

/** Parse a raw WS text frame; `null` if it is not a JSON object. */
function parseFrame<T>(raw: string): (T & { t?: unknown; clientId?: unknown; hostId?: unknown }) | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as T & { t?: unknown };
  } catch {
    return null;
  }
}

/** Serialize and send, swallowing errors from a socket that is mid-close. */
function safeSend(socket: RelaySocket, frame: unknown): void {
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    // The peer vanished between our map lookup and this send — nothing to do.
  }
}

function safeClose(socket: RelaySocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closing/closed.
  }
}
