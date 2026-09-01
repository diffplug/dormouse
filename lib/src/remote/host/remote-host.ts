/**
 * Host-side relay controller; `docs/specs/server.md` → "Relay" owns the frame
 * sequence and `remote-security-model.md` owns authorization. The remote-api
 * session is injected, keeping this module environment-free.
 */

import {
  HostAcl,
  HostChallengeIssuer,
  PairingError,
  PairingCeremony,
  WS_CLOSE_HOST_REPLACED,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  authorizeConnection,
  MAX_PENDING_PAIRINGS,
  boundedPairingAccount,
  boundedPairingLabel,
  isPairStatusQuery,
  isPairingRequest,
  type ConnectionDecision,
  type ConnectionPolicy,
  type ConnectionRequest,
  type HostAclRecord,
  type HostFrame,
  type PairingRequest,
  type ServerToHostFrame,
} from 'server-lib-common';
import type { HostEnrollment } from './enrollment';
import type { RemoteWebSocket } from '../ws';
import { loadHostAcl } from './acl';
import type { PendingPairing } from './pairing-approval';

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
  /**
   * Bumped by every authorization attempt (see {@link RemoteHost.#resetAuthorization}).
   * `authorizeConnection` is async, so two attempts for one client can be in
   * flight at once; only the newest may answer or re-open the gate.
   */
  authGeneration: number;
  /** The in-flight pairing awaiting local approval, if any. */
  pending?: PendingPairing;
  /** The remote-api handler, created on the first authorized `msg`. */
  session?: RemoteApiSessionLike;
}

/**
 * `disconnected` is a socket we expect to get back (a reconnect is armed);
 * `displaced` is a socket another Host took from us and no timer will restore
 * (see {@link RemoteHost.start}); `stopped` is a socket we closed ourselves.
 */
export type RemoteHostStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'displaced'
  | 'stopped';

export interface RemoteHostOptions {
  enrollment: HostEnrollment;
  createWebSocket?: (url: string) => WebSocketLike;
  /** Build the remote-api handler for an authorized client (see activation.ts). */
  createSession?: (opts: {
    hostId: string;
    send: (payload: unknown) => void;
  }) => RemoteApiSessionLike;
  /**
   * Where the ACL comes from and goes. Required, with no webview-store default:
   * this controller runs in the Tauri sidecar and the VS Code extension host as
   * well as in a webview, so a default would drag `localStorage` into both Node
   * bundles — and a forgotten `saveAcl` has to be a type error rather than an
   * approval that is lost at the next restart.
   */
  loadAcl: (hostId: string) => HostAclRecord[];
  saveAcl: (hostId: string, records: readonly HostAclRecord[]) => void;
  /** Surface a pairing request for local approval. */
  requestApproval: (pending: PendingPairing) => void;
  /** Dismiss a surfaced request once resolved. */
  dismissApproval: (clientId: string) => void;
  /**
   * Whether `nonce` is a setup token this Host minted and has not seen spent,
   * **consuming it** on a match so one QR proves one pairing. Injected because
   * the tokens are the service's — it is the party that mints them over the
   * Host's authenticated channel (`lib/src/host/remote/service.ts`).
   *
   * Optional, and absent means nothing is verified: a Host built without it
   * (the tests, an older embedder) runs every pairing as the ordinary
   * fingerprint-compare one.
   */
  verifySetupNonce?: (nonce: string) => boolean;
  /**
   * A setup token this Host minted was spent on the Server, so the QR showing
   * it is stale. Announced to whoever is displaying it; nothing here acts on it.
   */
  onSetupTokenRedeemed?: () => void;
  now?: () => number;
  /** Auto-reconnect with backoff (default true; tests pass false). */
  reconnect?: boolean;
}

/**
 * The longest `clientId` this Host will act on.
 *
 * The relay mints these as base64url of 16 random bytes (~22 characters), so
 * this is an order of magnitude of headroom. It exists because the id is a
 * *map key* on a hostile-relay path: every other field of a `pair` frame is
 * capped by `PAIRING_FIELD_LIMIT`, and bounding those while leaving the key
 * free would bound only the part that was already bounded.
 */
const MAX_CLIENT_ID_LENGTH = 256;

/** The server→host frames that address one Client; the rest are handled apart. */
type AddressedFrame = Extract<ServerToHostFrame, { clientId: string }>;

/**
 * Whether a parsed relay frame addresses a Client, with its `clientId` proved
 * rather than assumed — the relay is not trusted to have stamped one, or to
 * have kept it inside {@link MAX_CLIENT_ID_LENGTH}.
 */
function isAddressedFrame(frame: ServerToHostFrame): frame is AddressedFrame {
  const clientId: unknown = (frame as { clientId?: unknown }).clientId;
  return typeof clientId === 'string' && clientId.length <= MAX_CLIENT_ID_LENGTH;
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
  readonly #verifySetupNonce: (nonce: string) => boolean;
  readonly #onSetupTokenRedeemed: () => void;
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
  /** Latched by a {@link WS_CLOSE_HOST_REPLACED} close; only `start()` clears it. */
  #displaced = false;
  #backoffMs = INITIAL_BACKOFF_MS;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RemoteHostOptions) {
    this.#enrollment = options.enrollment;
    this.#policy = {
      rpId: options.enrollment.rpId,
      origin: options.enrollment.origin,
      // Mirrored from the Server at enrollment. Both sides must demand the
      // same thing: the Host is the final authority, so a Server enforcing UV
      // while the Host does not would leave the weaker verifier deciding.
      requireUserVerification: options.enrollment.requireUserVerification ?? false,
    };
    this.#now = options.now ?? (() => Date.now());
    this.#acl = loadHostAcl(options.enrollment.hostId, options.loadAcl);
    this.#challenges = new HostChallengeIssuer({ now: this.#now });
    this.#ceremony = new PairingCeremony(this.#acl, { now: this.#now });

    this.#createWebSocket =
      options.createWebSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.#createSession = options.createSession;
    this.#saveAcl = options.saveAcl;
    this.#requestApproval = options.requestApproval;
    this.#dismissApproval = options.dismissApproval;
    this.#verifySetupNonce = options.verifySetupNonce ?? (() => false);
    this.#onSetupTokenRedeemed = options.onSetupTokenRedeemed ?? (() => {});
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

  /**
   * Open the relay socket. Also the one way back from `displaced`: an evicted
   * Host never reconnects on a timer, so returning is a deliberate act that
   * evicts whichever Host currently holds the hostId. Idempotent while a socket
   * is live.
   */
  start(): void {
    this.#stopped = false;
    this.#displaced = false;
    this.#clearReconnectTimer();
    this.#backoffMs = INITIAL_BACKOFF_MS;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#status = 'stopped';
    this.#clearReconnectTimer();
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
    if (this.#ws || this.#stopped || this.#displaced) return;
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
    ws.addEventListener('close', (ev) => {
      // Generation guard: only the socket we currently own drives the lifecycle.
      // `stop()` drops `#ws` without waiting for the close event, so a late
      // close from a superseded socket could otherwise null out the live socket,
      // open a second one, and make this Host displace *itself*.
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#onClose(closeCode(ev));
    });
  }

  #onClose(code: number | undefined): void {
    this.#dropTransientState();
    if (this.#stopped) {
      this.#status = 'stopped';
      return;
    }
    if (code === WS_CLOSE_HOST_REPLACED) {
      // Another Host claimed this hostId and the relay evicted us on purpose
      // (server/src/relay.ts `registerHost`). Reconnecting would evict that one,
      // which would reconnect and evict us, forever — so this close is terminal
      // and coming back requires an explicit `start()`.
      this.#displaced = true;
      this.#status = 'displaced';
      return;
    }
    if (!this.#reconnect) {
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

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  /** Connection-scoped state resets on a dropped socket (the ACL persists). */
  #dropTransientState(): void {
    for (const state of this.#clients.values()) state.session?.dispose();
    for (const [clientId, state] of this.#clients) {
      if (state.pending) this.#dismissApproval(clientId);
    }
    this.#clients.clear();
  }

  /**
   * How many clients this Host is tracking. Exists for the pending-pairing
   * bound's test: the growth it guards against is in a private map, and a
   * bound nothing can observe is how the first version of that cap passed its
   * own test while the map kept growing.
   */
  get trackedClientCount(): number {
    return this.#clients.size;
  }

  /**
   * Drop the oldest pending pairing when the queue is full, so a new request
   * displaces one rather than growing the map. Oldest first: whoever initiated
   * it is the least likely to still be waiting on the modal.
   *
   * Bounds the *pairing* path specifically. `#onConnect` also creates a
   * `#clients` entry through `#resetAuthorization`, and those carry no
   * `pending`, so this counter does not see them and does not evict them —
   * deliberately, since evicting an entry that may be `established` is a
   * different act from denying a pending request. Those entries are cheap (a
   * length-bounded key and two fields, no `PairingRequest`) and are cleared
   * wholesale when the socket drops.
   */
  #evictOldestPairingIfFull(): void {
    let pendingCount = 0;
    for (const state of this.#clients.values()) if (state.pending) pendingCount++;
    while (pendingCount >= MAX_PENDING_PAIRINGS) {
      let oldestId: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, state] of this.#clients) {
        if (state.pending && state.pending.requestedAt < oldestAt) {
          oldestAt = state.pending.requestedAt;
          oldestId = id;
        }
      }
      if (oldestId === null) return;
      this.#denyPairing(oldestId, this.#clients.get(oldestId)!.pending!.pairingId, 'superseded');
      // Drop the record too, not just its payload. `#denyPairing` only clears
      // `pending`, so without this the map keeps one entry per `pair` frame
      // forever under a relay-chosen key — bounding the capped payload while
      // leaving the unbounded part. `#clientState` recreates it if that client
      // is ever heard from again, and an established or session-holding client
      // is left alone.
      const evicted = this.#clients.get(oldestId);
      if (evicted && !evicted.established && !evicted.session) this.#clients.delete(oldestId);
      pendingCount--;
    }
  }

  /** Get or create the per-client state record for `clientId`. */
  #clientState(clientId: string): ClientState {
    let state = this.#clients.get(clientId);
    if (!state) {
      state = { established: false, authGeneration: 0 };
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
    if (!frame || typeof (frame as { t?: unknown }).t !== 'string') return;
    if (frame.t === 'setup-token-redeemed') {
      // The one server→host frame that addresses no Client, so it is routed
      // before the clientId narrowing below: it is about this Host itself.
      this.#onSetupTokenRedeemed();
      return;
    }
    if (!isAddressedFrame(frame)) return;
    const { clientId } = frame;
    switch (frame.t) {
      case 'pair':
        return this.#onPair(clientId, frame.request);
      case 'pair-status':
        return this.#onPairStatus(clientId, frame.query);
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

  #onPair(clientId: string, incoming: unknown): void {
    // `pair` arrives from the relay, which this model does not trust — the
    // Server runs the same guard, and that is exactly why the Host cannot rely
    // on it having done so. Unvalidated, one malformed frame reaches the
    // approval modal, where `request.devicePublicKey.slice(0, 8)` throws inside
    // the app-wide ErrorBoundary and takes every terminal down with it; if
    // approved, its fields land in a persisted ACL record. `connect2` has
    // always contained this class of failure as an ordinary denial.
    if (!isPairingRequest(incoming)) {
      console.warn('remote-host: malformed pairing request');
      this.#send({ t: 'pair-result', clientId, approved: false, error: 'malformed-request' });
      return;
    }
    // A phone set up by scanning this machine's QR returns the token it was set
    // up with. Only this Host can check one — it minted the token over its own
    // authenticated channel and holds the only other copy — which is what makes
    // `verified` unforgeable by the Server or the Client
    // (`docs/specs/remote-security-model.md` → Pairing Ceremony).
    //
    // A miss is **not** an error: an unknown, expired, or already-spent nonce
    // simply pairs the ordinary way, because the phone may predate the QR path
    // or be re-pairing long after its code was spent.
    //
    // A plain map lookup, not a constant-time compare: the token is 256 bits of
    // server-chosen randomness, so a timing side channel leaks nothing an
    // attacker could walk toward a guess.
    const verified =
      typeof incoming.setupNonce === 'string' && this.#verifySetupNonce(incoming.setupNonce);
    // The label is attacker-chosen free text rendered in the one dialog the
    // ACL rests on. Bound and strip it here, once, so every consumer — the
    // queue projection, the modal, and the ACL record written on approval —
    // sees the same safe value. The nonce is dropped in the same step: `verified`
    // is what anyone downstream needs, and the token itself is a credential that
    // has no business in a webview realm or an ACL record.
    const { setupNonce: _spent, ...bare } = incoming;
    const request: PairingRequest = {
      ...bare,
      accountId: boundedPairingAccount(incoming.accountId),
      requestedLabel: boundedPairingLabel(incoming.requestedLabel),
    };
    const ticket = this.#ceremony.begin(request);
    const pending: PendingPairing = {
      clientId,
      pairingId: ticket.pairingId,
      request,
      verified,
      requestedAt: ticket.requestedAt,
      approve: (label) => this.#approvePairing(clientId, ticket.pairingId, label),
      deny: (error) => this.#denyPairing(clientId, ticket.pairingId, error),
    };
    // Bound the queue before adding to it. Every `pair` frame allocates a
    // `#clients` entry under a relay-chosen `clientId`, and those are removed
    // only by `client-gone` — which a hostile relay simply never sends — or by
    // the socket dropping. Unbounded, 5000 frames retain 5000 pending requests
    // holding megabytes of relay-chosen strings in the process that owns every
    // PTY, and the service re-serializes the whole queue to the webview on each
    // one, so the traffic is quadratic. Reachable by anything that can sign in:
    // a synced or stolen passkey is documented as buying only "the ability to
    // ask", and this is what stops asking from being a denial of service.
    this.#evictOldestPairingIfFull();
    this.#clientState(clientId).pending = pending;
    this.#requestApproval(pending);
  }

  /**
   * Answer whether a (passkey credential, device key) pair is on the ACL —
   * advisory display truth for Pocket's Pair/Connect row, nothing more.
   *
   * Deliberately inert: it reads the ACL, allocates no `#clients` entry, mints
   * no ticket, burns no challenge, and cannot move a client toward
   * `established`. `authorizeConnection` remains the only thing that decides
   * access and never consults this answer.
   */
  #onPairStatus(clientId: string, query: unknown): void {
    // A malformed query is answered rather than dropped. The client is awaiting
    // one frame per query, so silence strands that wait until the socket dies —
    // and `false` is the safe lie: it offers Pair, whose approval is local, in
    // place of a Connect the Host would have allowed.
    const paired = isPairStatusQuery(query) && this.#acl.findActive(query) !== undefined;
    this.#send({ t: 'pair-status-result', clientId, paired });
  }

  /** The local approval — the ONLY path that writes the ACL. */
  #approvePairing(clientId: string, pairingId: string, label?: string): void {
    const state = this.#clients.get(clientId);
    // The service checks this at its bridge boundary too; keep the controller's
    // ACL write bound to its own current ticket even if another caller retains
    // an older callback.
    if (!state?.pending || state.pending.pairingId !== pairingId) return;
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
    if (!state?.pending || state.pending.pairingId !== pairingId) return;
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
    this.#resetAuthorization(clientId);
    const { challenge, expiresAt } = this.#challenges.issue();
    this.#send({ t: 'challenge', clientId, challenge, expiresAt });
  }

  async #onConnect2(clientId: string, request: ConnectionRequest): Promise<void> {
    // A new authorization attempt closes the old gate first. The relay is not
    // an authority and may be compromised, so it cannot keep a once-authorized
    // client established by following it with a malformed attempt.
    const state = this.#resetAuthorization(clientId);
    const generation = state.authGeneration;
    // Verification is async, so the relay can start a second attempt while this
    // one is still running. Whichever finishes last would otherwise win, and an
    // older `allowed` landing after a newer attempt would re-open the gate that
    // attempt just closed. A superseded evaluation answers nothing at all — its
    // replacement is what the client is waiting on.
    const superseded = (): boolean =>
      this.#clients.get(clientId) !== state || state.authGeneration !== generation;
    let decision: ConnectionDecision;
    try {
      decision = await authorizeConnection(
        {
          hostId: this.#enrollment.hostId,
          acl: this.#acl,
          challenges: this.#challenges,
          policy: this.#policy,
        },
        request,
      );
    } catch (error) {
      // `connect2` came from the relay, not a trusted typed caller. Structural
      // failures must be an ordinary denial: this Host now runs in Node, where
      // letting the async handler reject can terminate the sidecar or extension
      // host rather than merely logging in a webview.
      console.warn('remote-host: malformed connection request', error);
      if (superseded()) return;
      this.#send({
        t: 'decision',
        clientId,
        allowed: false,
        failures: ['passkey-assertion-invalid', 'device-signature-invalid'],
      });
      return;
    }
    if (superseded()) return;
    if (decision.allowed) state.established = true;
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

  /** A fresh authorization attempt replaces any prior control session. */
  #resetAuthorization(clientId: string): ClientState {
    const state = this.#clientState(clientId);
    state.established = false;
    state.authGeneration += 1;
    state.session?.dispose();
    state.session = undefined;
    return state;
  }

  #onClientGone(clientId: string): void {
    this.#clients.get(clientId)?.session?.dispose();
    this.#clients.delete(clientId);
    this.#dismissApproval(clientId);
  }
}

/** The `code` of a `CloseEvent`, or undefined if the socket gave us none. */
function closeCode(ev: unknown): number | undefined {
  const code = (ev as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

function pairingApprovalError(error: unknown): string {
  if (error instanceof PairingError) {
    return error.code === 'expired'
      ? 'pairing approval expired'
      : 'pairing approval is no longer pending';
  }
  return 'pairing approval failed';
}
