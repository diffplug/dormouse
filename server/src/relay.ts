/**
 * In-memory relay hub; `docs/specs/server.md` → "Relay" owns its frame gates,
 * Host authority, replacement, and routing contracts.
 */

import { randomBytes } from 'node:crypto';

import {
  WS_CLOSE_HOST_REPLACED,
  WS_CLOSE_HOST_REPLACED_REASON,
  isE2eClientFrame,
  isE2eHostFrame,
  toBase64Url,
} from 'server-lib-common';
import type {
  ClientFrame,
  HostFrame,
  ServerToClientFrame,
  ServerToHostFrame,
} from 'server-lib-common';

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
  /** The Host this client is currently talking to, or `null` if unbound. */
  hostId: string | null;
}

export class RelayHub {
  readonly #hosts = new Map<string, HostConn>();
  readonly #clients = new Map<string, ClientConn>();

  /** True while a socket for `hostId` is connected — drives `GET /api/hosts` presence. */
  isHostOnline(hostId: string): boolean {
    return this.#hosts.has(hostId);
  }

  /** Every `hostId` with a live socket right now. */
  onlineHostIds(): string[] {
    return [...this.#hosts.keys()];
  }

  /**
   * Close a Host's socket and drop its clients, as if it had disconnected.
   *
   * The `/ws/host` token is checked once, at the upgrade, so nothing here
   * notices a Host whose `hosts.json` row was later deleted — the documented
   * revocation. `createApp`'s sweep is what calls this; see
   * `docs/specs/server.md` -> Guardrails.
   */
  closeHost(hostId: string, code: number, reason: string): boolean {
    const conn = this.#hosts.get(hostId);
    if (!conn) return false;
    this.unregisterHost(conn);
    safeClose(conn.socket, code, reason);
    return true;
  }

  // --- Host lifecycle -------------------------------------------------------

  /**
   * Register a freshly-opened Host socket. Only one socket may own a `hostId`,
   * so an existing one is displaced and closed; the displaced socket's `close`
   * event is ignored by {@link unregisterHost} because the map already points
   * at the new connection (a generation guard).
   *
   * A replacement also drops every Client bound to the OLD Host process: the
   * new process has a fresh ACL and no memory of them, so their in-flight
   * frames must not keep flowing to it under a binding it never made. Handling
   * this on disconnect alone is not enough; because the displaced socket's
   * `close` is a no-op here, the drop has to happen at replacement time too.
   *
   * The eviction is announced with {@link WS_CLOSE_HOST_REPLACED} rather than a
   * plain close so the evicted Host can tell it apart from a network drop: it
   * stands down on this code instead of backing off and reconnecting, which
   * would evict the replacement and start an endless swap.
   */
  registerHost(hostId: string, socket: RelaySocket): HostConn {
    const conn: HostConn = { hostId, socket };
    const existing = this.#hosts.get(hostId);
    this.#hosts.set(hostId, conn);
    if (existing) {
      this.#dropClientsOf(hostId);
      safeClose(existing.socket, WS_CLOSE_HOST_REPLACED, WS_CLOSE_HOST_REPLACED_REASON);
    }
    return conn;
  }

  /** Handle one raw frame from a Host socket. Unknown/malformed frames are ignored. */
  onHostFrame(host: HostConn, raw: string): void {
    // Only the socket the map points at speaks for a hostId: a socket displaced
    // by registerHost can still deliver queued frames, and treating them as
    // current would carry ciphertext from the dead host process into a binding
    // the replacement never made.
    if (this.#hosts.get(host.hostId) !== host) return;
    const frame = parseFrame<HostFrame>(raw);
    // The shape guard bounds `clientId` before it is used as a map key, and the
    // ciphertext before it is copied onto another socket.
    if (!frame || !isE2eHostFrame(frame)) return;
    // Every host frame addresses a specific client; if it has already gone,
    // there is nothing to route.
    const client = this.#clients.get(frame.clientId);
    if (!client) return;
    // Host replies are only meaningful while the client is still bound to that
    // host. A client socket may leave host A for host B before A answers; late
    // frames from A must not reach the active client.
    if (client.hostId !== host.hostId) return;
    // No `authorized` gate: the relay never learns whether the Host authorized
    // anything, so the binding checked above is the whole routing rule
    // (server.md -> Relay).
    this.#toClient(client, {
      t: 'e2e',
      hostId: host.hostId,
      kind: frame.kind,
      id: frame.id,
      step: frame.step,
      ct: frame.ct,
    });
  }

  /**
   * Tear down a Host socket. Guarded so a socket displaced by
   * {@link registerHost} is a no-op. Its clients are told `host-gone` and their
   * bindings cleared (no resume protocol — they reconnect).
   */
  unregisterHost(host: HostConn): void {
    if (this.#hosts.get(host.hostId) !== host) return; // already replaced
    this.#hosts.delete(host.hostId);
    this.#dropClientsOf(host.hostId);
  }

  /**
   * Tell every client bound to `hostId` its Host is gone and clear the binding,
   * so nothing can flow to a Host that is no longer the one it handshook with.
   * Used on both Host disconnect and Host replacement.
   */
  #dropClientsOf(hostId: string): void {
    for (const client of this.#clients.values()) {
      if (client.hostId === hostId) {
        this.#toClient(client, { t: 'host-gone' });
        client.hostId = null;
      }
    }
  }

  // --- Client lifecycle -----------------------------------------------------

  /** Register a freshly-opened Client socket with a fresh secret `clientId`. */
  registerClient(socket: RelaySocket): ClientConn {
    const clientId = toBase64Url(randomBytes(16));
    const conn: ClientConn = { clientId, socket, hostId: null };
    this.#clients.set(clientId, conn);
    return conn;
  }

  /** Handle one raw frame from a Client socket. Malformed/unknown frames get an `error`. */
  onClientFrame(client: ClientConn, raw: string): void {
    const frame = parseFrame<ClientFrame>(raw);
    if (!frame || typeof frame.t !== 'string') {
      this.#toClient(client, { t: 'error', error: 'malformed frame' });
      return;
    }
    if (frame.t !== 'e2e') {
      this.#toClient(client, { t: 'error', error: 'unknown frame type' });
      return;
    }
    // The envelope the end-to-end protocol rides in: an `init` binds, and
    // everything after it is forwarded within that binding (server.md ->
    // Relay). Never decoded here.
    if (!isE2eClientFrame(frame)) {
      this.#toClient(client, { t: 'error', error: 'malformed e2e frame' });
      return;
    }
    const host = this.#resolveHost(client, frame.hostId);
    if (!host) return;
    if (frame.step === 'init') {
      this.#bindClientToHost(client, frame.hostId);
    } else if (client.hostId !== frame.hostId) {
      // Transport outside the binding: the client is talking to a Host it is
      // not bound to, so there is nothing to forward it to.
      return;
    }
    this.#toHost(host, {
      t: 'e2e',
      clientId: client.clientId,
      hostId: frame.hostId,
      kind: frame.kind,
      id: frame.id,
      step: frame.step,
      ct: frame.ct,
    });
  }

  /** Tear down a Client socket: tell its Host `client-gone`, then forget it. */
  unregisterClient(client: ClientConn): void {
    this.#clients.delete(client.clientId);
    if (client.hostId !== null) {
      const host = this.#hosts.get(client.hostId);
      if (host) this.#toHost(host, { t: 'client-gone', clientId: client.clientId });
    }
  }

  /**
   * Bind a client socket to `hostId` — the one place that transition is
   * written. A client holds at most one binding: moving to a new Host tells the
   * old one the client is gone, so its Host-side ceremonies and sessions are
   * disposed immediately.
   */
  #bindClientToHost(client: ClientConn, hostId: string): void {
    if (client.hostId !== null && client.hostId !== hostId) {
      const previousHost = this.#hosts.get(client.hostId);
      if (previousHost) {
        this.#toHost(previousHost, { t: 'client-gone', clientId: client.clientId });
      }
    }
    client.hostId = hostId;
  }

  /**
   * Resolve the Host a client frame addresses, answering the one refusal
   * (offline) itself. The shape is already proved — only `isE2eClientFrame`
   * reaches here — so resolution is the whole job; binding is
   * {@link RelayHub.#bindClientToHost}.
   */
  #resolveHost(client: ClientConn, hostId: string): HostConn | null {
    const host = this.#hosts.get(hostId);
    if (!host) {
      this.#toClient(client, { t: 'error', error: `host ${hostId} is offline` });
      return null;
    }
    return host;
  }

  // --- Sending --------------------------------------------------------------

  #toClient(client: ClientConn, frame: ServerToClientFrame): void {
    safeSend(client.socket, frame);
  }

  #toHost(host: HostConn, frame: ServerToHostFrame): void {
    safeSend(host.socket, frame);
  }
}

// ---------------------------------------------------------------------------
// Helpers

/** Parse a raw WS text frame; `null` if it is not a JSON object. */
function parseFrame<T>(raw: string): (T & { t?: unknown }) | null {
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
