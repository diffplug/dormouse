/**
 * The Host controller: holds the `/ws/host` relay socket and speaks the Host
 * side of the wire contract (`server-lib-common/remote/wire.ts`), mirroring the
 * headless reference in `server/test/harness/fake-host.mjs`.
 *
 *   - `pair`        → begin the ceremony and surface a local approval; approval
 *                     runs `PairingCeremony.approve` (the only ACL write),
 *                     persists the ACL, and replies `pair-result` with the record.
 *   - `connect`     → issue a Host challenge.
 *   - `connect2`    → `authorizeConnection` (final authority); `failures` is
 *                     omitted from an allowed `decision`.
 *   - `msg`         → only for a client with an allowed decision; routed to the
 *                     remote-api handler.
 *   - `client-gone` → drop that client's transient state.
 *
 * The remote-api handler is injected (`createSession`) so this controller has no
 * dependency on the terminal registry / xterm / DOM — the wiring lives in
 * `activation.ts`, and this file stays unit-testable against a fake socket.
 */

import {
  HostAcl,
  HostChallengeIssuer,
  PairingError,
  PairingCeremony,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  authorizeConnection,
  type ConnectionPolicy,
  type ConnectionRequest,
  type HostAclRecord,
  type HostFrame,
  type PairingRequest,
  type ServerToHostFrame,
} from 'server-lib-common';
import type { HostEnrollment } from './enrollment';
import type { RemoteWebSocket } from '../ws';
import { loadHostAcl, saveAclRecords } from './acl';
import {
  enqueuePairingApproval,
  resolvePairingApproval,
  type PendingPairing,
} from './pairing-approval';

/** The remote-api handler this controller drives per authorized client. */
export interface RemoteApiSessionLike {
  handle(data: unknown): void;
  dispose(): void;
}

/** Minimal WebSocket surface, so tests can inject a fake. */
export type WebSocketLike = RemoteWebSocket;

/** Per-client lifecycle state tracked by the Host, keyed by clientId. */
interface ClientState {
  /** True once the Host allowed this client's connection — the `msg` gate. */
  established: boolean;
  /** The in-flight pairing awaiting local approval, if any. */
  pending?: PendingPairing;
  /** The remote-api handler, created on the first authorized `msg`. */
  session?: RemoteApiSessionLike;
}

export type RemoteHostStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'stopped';

export interface RemoteHostOptions {
  enrollment: HostEnrollment;
  createWebSocket?: (url: string) => WebSocketLike;
  /** Build the remote-api handler for an authorized client (see activation.ts). */
  createSession?: (opts: {
    hostId: string;
    send: (payload: unknown) => void;
  }) => RemoteApiSessionLike;
  loadAcl?: (hostId: string) => HostAclRecord[];
  saveAcl?: (hostId: string, records: readonly HostAclRecord[]) => void;
  /** Surface a pairing request for local approval (default: the modal queue). */
  requestApproval?: (pending: PendingPairing) => void;
  /** Dismiss a surfaced request once resolved (default: the modal queue). */
  dismissApproval?: (clientId: string) => void;
  now?: () => number;
  /** Auto-reconnect with backoff (default true; tests pass false). */
  reconnect?: boolean;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export class RemoteHost {
  readonly #enrollment: HostEnrollment;
  readonly #policy: ConnectionPolicy;
  readonly #acl: HostAcl;
  readonly #challenges: HostChallengeIssuer;
  readonly #ceremony: PairingCeremony;

  readonly #createWebSocket: (url: string) => WebSocketLike;
  readonly #createSession?: RemoteHostOptions['createSession'];
  readonly #saveAcl: (hostId: string, records: readonly HostAclRecord[]) => void;
  readonly #requestApproval: (pending: PendingPairing) => void;
  readonly #dismissApproval: (clientId: string) => void;
  readonly #now: () => number;
  readonly #reconnect: boolean;

  /**
   * Per-client lifecycle state keyed by clientId. Folding the three concerns
   * (allowed connection, in-flight pairing, live session) into one record makes
   * teardown a single `delete` — no handler can leave the collections out of
   * sync.
   */
  readonly #clients = new Map<string, ClientState>();

  #ws: WebSocketLike | null = null;
  #status: RemoteHostStatus = 'idle';
  #stopped = false;
  #backoffMs = INITIAL_BACKOFF_MS;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RemoteHostOptions) {
    this.#enrollment = options.enrollment;
    this.#policy = { rpId: options.enrollment.rpId, origin: options.enrollment.origin };
    this.#now = options.now ?? (() => Date.now());
    this.#acl = loadHostAcl(options.enrollment.hostId, options.loadAcl);
    this.#challenges = new HostChallengeIssuer({ now: this.#now });
    this.#ceremony = new PairingCeremony(this.#acl, { now: this.#now });

    this.#createWebSocket =
      options.createWebSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.#createSession = options.createSession;
    this.#saveAcl = options.saveAcl ?? saveAclRecords;
    this.#requestApproval = options.requestApproval ?? enqueuePairingApproval;
    this.#dismissApproval = options.dismissApproval ?? resolvePairingApproval;
    this.#reconnect = options.reconnect ?? true;
  }

  get status(): RemoteHostStatus {
    return this.#status;
  }

  get hostId(): string {
    return this.#enrollment.hostId;
  }

  get activeRecords(): HostAclRecord[] {
    return this.#acl.activeRecords();
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#status = 'stopped';
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#dropTransientState();
    try {
      this.#ws?.close();
    } catch {
      // already closing
    }
    this.#ws = null;
  }

  // --- Socket lifecycle ---

  #connect(): void {
    if (this.#ws || this.#stopped) return;
    this.#status = 'connecting';
    const wsBase = this.#enrollment.serverUrl.replace(/^http/, 'ws');
    const url = `${wsBase}${WS_ROUTES.host}?${WS_TOKEN_PARAM}=${encodeURIComponent(this.#enrollment.hostToken)}`;
    const ws = this.#createWebSocket(url);
    this.#ws = ws;
    ws.addEventListener('open', () => {
      this.#status = 'connected';
      this.#backoffMs = INITIAL_BACKOFF_MS;
    });
    ws.addEventListener('message', (ev) => {
      this.#onFrame((ev as { data?: unknown }).data);
    });
    ws.addEventListener('error', () => {
      // A `close` always follows; reconnection is handled there.
    });
    ws.addEventListener('close', () => {
      this.#ws = null;
      this.#onClose();
    });
  }

  #onClose(): void {
    this.#dropTransientState();
    if (this.#stopped || !this.#reconnect) {
      this.#status = 'stopped';
      return;
    }
    this.#status = 'disconnected';
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, MAX_BACKOFF_MS);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  /** Connection-scoped state resets on a dropped socket (the ACL persists). */
  #dropTransientState(): void {
    for (const state of this.#clients.values()) state.session?.dispose();
    for (const [clientId, state] of this.#clients) {
      if (state.pending) this.#dismissApproval(clientId);
    }
    this.#clients.clear();
  }

  /** Get or create the per-client state record for `clientId`. */
  #clientState(clientId: string): ClientState {
    let state = this.#clients.get(clientId);
    if (!state) {
      state = { established: false };
      this.#clients.set(clientId, state);
    }
    return state;
  }

  #send(frame: HostFrame): void {
    try {
      this.#ws?.send(JSON.stringify(frame));
    } catch {
      // socket mid-close
    }
  }

  // --- Frame handling (mirrors fake-host.mjs) ---

  #onFrame(raw: unknown): void {
    let frame: ServerToHostFrame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : '') as ServerToHostFrame;
    } catch {
      return;
    }
    if (
      !frame ||
      typeof (frame as { t?: unknown }).t !== 'string' ||
      typeof (frame as { clientId?: unknown }).clientId !== 'string'
    ) {
      return;
    }
    const clientId = frame.clientId;
    switch (frame.t) {
      case 'pair':
        return this.#onPair(clientId, frame.request);
      case 'connect':
        return this.#onConnect(clientId);
      case 'connect2':
        void this.#onConnect2(clientId, frame.request);
        return;
      case 'msg':
        return this.#onMsg(clientId, frame.data);
      case 'client-gone':
        return this.#onClientGone(clientId);
      default:
        return;
    }
  }

  #onPair(clientId: string, request: PairingRequest): void {
    const ticket = this.#ceremony.begin(request);
    const pending: PendingPairing = {
      clientId,
      request,
      requestedAt: this.#now(),
      approve: (label) => this.#approvePairing(clientId, ticket.pairingId, label),
      deny: (error) => this.#denyPairing(clientId, ticket.pairingId, error),
    };
    this.#clientState(clientId).pending = pending;
    this.#requestApproval(pending);
  }

  /** The local approval — the ONLY path that writes the ACL. */
  #approvePairing(clientId: string, pairingId: string, label?: string): void {
    const state = this.#clients.get(clientId);
    if (!state?.pending) return; // already resolved
    state.pending = undefined;
    let record: HostAclRecord;
    try {
      record = this.#ceremony.approve(pairingId, { approvedBy: 'host-user', label });
    } catch (error) {
      this.#send({
        t: 'pair-result',
        clientId,
        approved: false,
        error: pairingApprovalError(error),
      });
      this.#dismissApproval(clientId);
      return;
    }
    this.#saveAcl(this.#enrollment.hostId, this.#acl.records());
    this.#send({ t: 'pair-result', clientId, approved: true, record });
    this.#dismissApproval(clientId);
  }

  #denyPairing(clientId: string, pairingId: string, error = 'pairing denied by host'): void {
    const state = this.#clients.get(clientId);
    if (!state?.pending) return;
    state.pending = undefined;
    try {
      this.#ceremony.deny(pairingId);
    } catch {
      // already expired/resolved — deny is still what we report.
    }
    this.#send({ t: 'pair-result', clientId, approved: false, error });
    this.#dismissApproval(clientId);
  }

  #onConnect(clientId: string): void {
    const { challenge, expiresAt } = this.#challenges.issue();
    this.#send({ t: 'challenge', clientId, challenge, expiresAt });
  }

  async #onConnect2(clientId: string, request: ConnectionRequest): Promise<void> {
    const decision = await authorizeConnection(
      {
        hostId: this.#enrollment.hostId,
        acl: this.#acl,
        challenges: this.#challenges,
        policy: this.#policy,
      },
      request,
    );
    if (decision.allowed) this.#clientState(clientId).established = true;
    // `failures` is optional on the wire; omit it on an allowed decision.
    this.#send({
      t: 'decision',
      clientId,
      allowed: decision.allowed,
      ...(decision.allowed ? {} : { failures: decision.failures }),
    });
  }

  #onMsg(clientId: string, data: unknown): void {
    const state = this.#clients.get(clientId);
    if (!state?.established) return; // never before an allowed decision
    let session = state.session;
    if (!session) {
      if (!this.#createSession) return;
      session = this.#createSession({
        hostId: this.#enrollment.hostId,
        send: (payload) => this.#send({ t: 'msg', clientId, data: payload }),
      });
      state.session = session;
    }
    session.handle(data);
  }

  #onClientGone(clientId: string): void {
    this.#clients.get(clientId)?.session?.dispose();
    this.#clients.delete(clientId);
    this.#dismissApproval(clientId);
  }
}

function pairingApprovalError(error: unknown): string {
  if (error instanceof PairingError) {
    return error.code === 'expired'
      ? 'pairing approval expired'
      : 'pairing approval is no longer pending';
  }
  return 'pairing approval failed';
}
