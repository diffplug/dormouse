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
  computeSetupProof,
  constantTimeEqual,
  getWebCrypto,
  importNoiseStaticPrivateKey,
  toBase64Url,
  utf8Encode,
  MAX_PENDING_PAIRINGS,
  MAX_TOKENS_PER_HOST,
  DEFAULT_PAIRING_TTL_MS,
  boundedPairingAccount,
  boundedPairingLabel,
  isPairStatusQuery,
  isPairingRequest,
  type ConnectionDecision,
  type ConnectionPolicy,
  type ConnectionRequest,
  type CryptoKeyLike,
  type HostAclRecord,
  type HostFrame,
  type PairingRequest,
  type ServerToHostFrame,
} from 'server-lib-common';
import type { HostEnrollment } from './enrollment';
import type { RemoteWebSocket } from '../ws';
import { loadHostAcl } from './acl';
import type { MirroredPairingRequest, PendingPairing } from './pairing-approval';

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
  /** Bumped by every `pair`; only its newest async proof may reach the UI. */
  pairGeneration: number;
  /** The in-flight pairing awaiting local approval, if any. */
  pending?: PendingPairing;
  /**
   * Which outstanding setup nonce {@link ClientState.pending}'s `verified`
   * rests on, so approving one pairing can retire that nonce and downgrade
   * every other pairing standing on it (see
   * {@link RemoteHost.#consumeSetupNonce}).
   *
   * **Host-side only.** It lives here rather than on `PendingPairing` because
   * that shape is mirrored to the webview, and the nonce must never cross
   * (`SECURITY.md` → the setup-token FAIL IF).
   */
  verifiedNonce?: string;
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
   * A setup token this Host minted was spent on the Server, so the QR showing
   * it is stale. `mintId` names which mint, never the token. Announced to
   * whoever is displaying it; nothing here acts on it.
   */
  onSetupTokenRedeemed?: (mintId: string) => void;
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

/** 256 bits, like every other unguessable handle in this system. */
const SETUP_NONCE_BYTE_LENGTH = 32;

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
  readonly #onSetupTokenRedeemed: (mintId: string) => void;
  readonly #now: () => number;
  readonly #reconnect: boolean;

  /**
   * Per-client lifecycle state keyed by clientId. Folding the three concerns
   * (allowed connection, in-flight pairing, live session) into one record makes
   * teardown a single `delete` — no handler can leave the collections out of
   * sync.
   */
  readonly #clients = new Map<string, ClientState>();

  /**
   * Setup nonces this Host minted into its own QRs and has not spent,
   * `nonce → expiresAt`.
   *
   * **The Server never sees one.** It rides the QR beside the Server's setup
   * token, laptop screen to phone camera and no further, and a phone set up by
   * scanning returns only `computeSetupProof(nonce, its device key)` — so
   * verifying is recomputing that MAC over the key the request is asking to
   * authorize (`docs/specs/remote-security-model.md` → Pairing Ceremony).
   *
   * Kept here rather than in the service that composes the QR so its lifetime
   * *is* this Host's: a new Host starts with none, and a Host that reconnects
   * keeps the codes still on screen. Local rather than routed through the
   * shared issuer primitives, which the old comment declined for the wrong
   * reason: verification iterates this map computing a MAC per entry, and
   * approval consumes an entry by name — neither is an API `SetupTokenIssuer`
   * has. Capped at {@link MAX_TOKENS_PER_HOST}, the Server's own bound on the
   * tokens these are paired with, so the two sides agree on live-versus-spent.
   */
  readonly #setupNonces = new Map<string, number>();

  /**
   * Setup proofs being checked right now. Bounded like everything else a `pair`
   * frame can allocate: verification is async, so the `#clients` cap cannot see
   * a request that has not landed yet, and a relay flooding proof-carrying
   * frames while a QR is up would otherwise buy unbounded concurrent MACs.
   * Past the cap a frame skips verification entirely, which is the safe
   * degradation — it pairs the ordinary fingerprint-compare way.
   */
  #verifying = 0;

  /**
   * This Host's long-term Noise identity, imported nonextractably from the
   * enrollment. Null until {@link RemoteHost.start} loads it, and on an
   * enrollment minted before the field existed.
   *
   * **Nothing reads it yet** — the end-to-end ceremonies are staged
   * (`docs/specs/remote-security-model.md` → Future). It is loaded here rather
   * than in the constructor because `importKey` is async and constructing a
   * Host must stay synchronous, and it is never re-exported: the PKCS#8 in the
   * state file is the only copy that leaves WebCrypto.
   */
  #noiseStatic: CryptoKeyLike | null = null;

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
   * Mint the second secret of a setup QR — the one the Server never sees — for
   * whoever is composing that QR (`lib/src/host/remote/service.ts` →
   * `#setupQr`).
   *
   * **One clock.** The expiry is this Host's own `now` plus the shared TTL,
   * never the Server's `expiresAt`: everything that reads it — the prune below,
   * {@link RemoteHost.#matchSetupNonce} — compares against `this.#now()`, so a
   * Server-minted instant would let clock skew mint nonces born expired and
   * silently downgrade every scan to the fingerprint compare.
   *
   * Prunes on insert, since nothing else sweeps this map, and the count cap
   * matches the Server's so a nonce cannot outlive the token it rode with.
   */
  mintSetupNonce(): string {
    const now = this.#now();
    const expiresAt = now + DEFAULT_PAIRING_TTL_MS;
    for (const [nonce, expiry] of this.#setupNonces) {
      if (expiry <= now) this.#setupNonces.delete(nonce);
    }
    // Oldest first, as on the Server: the code longest on screen is the one
    // whose scanner has most likely given up.
    while (this.#setupNonces.size >= MAX_TOKENS_PER_HOST) {
      const oldest = this.#setupNonces.keys().next();
      if (oldest.done) break;
      this.#setupNonces.delete(oldest.value);
    }
    const nonce = toBase64Url(
      getWebCrypto().getRandomValues(new Uint8Array(SETUP_NONCE_BYTE_LENGTH)),
    );
    this.#setupNonces.set(nonce, expiresAt);
    return nonce;
  }

  /**
   * How many setup nonces this Host is still holding. Exists for the cap's own
   * test, for the reason {@link RemoteHost.trackedClientCount} does: a bound
   * nothing can observe is one that passes its test while the map grows.
   */
  get outstandingSetupNonceCount(): number {
    return this.#setupNonces.size;
  }

  /**
   * Which outstanding nonce this request's `setupProof` was computed under, or
   * `null` when none was — an unknown, expired, or absent proof, and a proof
   * bound to some *other* device key.
   *
   * That last case is the point of the whole scheme. The proof is a MAC over
   * the request's own `devicePublicKey`, so a Server that substituted its key
   * into a relayed request would have to produce a MAC under a nonce it has
   * never seen; there is no proof it can copy from the real phone that still
   * matches.
   *
   * **Non-consuming.** The nonce is spent when a pairing it verified is
   * approved ({@link RemoteHost.#consumeSetupNonce}), not on arrival: the relay
   * may re-deliver the same phone's frame, and a replay carrying the same
   * device key asks for exactly what the user is about to approve anyway.
   *
   * A handful of entries at most, and only while a QR is on screen — a Host
   * showing no code does no work here at all, which is what keeps a hostile
   * relay from turning `pair` frames into MAC computations.
   */
  async #matchSetupNonce(request: PairingRequest): Promise<string | null> {
    const proof = request.setupProof;
    if (typeof proof !== 'string') return null;
    const now = this.#now();
    for (const [nonce, expiresAt] of [...this.#setupNonces]) {
      if (expiresAt <= now) {
        this.#setupNonces.delete(nonce);
        continue;
      }
      const expected = await computeSetupProof(nonce, request.devicePublicKey);
      // The MAC yields to WebCrypto. Approval of another request may spend this
      // nonce while it is in flight, and expiry may pass too; a result is valid
      // only while the exact entry from the snapshot is still live.
      const liveExpiry = this.#setupNonces.get(nonce);
      if (liveExpiry !== expiresAt || expiresAt <= this.#now()) {
        if (liveExpiry === expiresAt) this.#setupNonces.delete(nonce);
        continue;
      }
      // Constant-time, unlike the token lookup this replaced: a MAC compare
      // that exits on the first wrong character is a forgery oracle. The length
      // is not secret, so an early `false` on a mismatched one leaks nothing.
      if (constantTimeEqual(utf8Encode(expected), utf8Encode(proof))) return nonce;
    }
    return null;
  }

  /**
   * Spend the nonce a just-approved pairing verified against, and downgrade
   * every other pending pairing that was standing on the same one.
   *
   * Single use is enforced here rather than at receipt because this is the act
   * the nonce authorizes: one scan sets up one phone, and once that phone's key
   * is on the ACL a second request holding the same proof is a different device
   * asking, which must go back to the fingerprint compare.
   */
  #consumeSetupNonce(nonce: string): void {
    this.#setupNonces.delete(nonce);
    for (const state of this.#clients.values()) {
      if (state.verifiedNonce !== nonce || !state.pending) continue;
      state.verifiedNonce = undefined;
      // A fresh object, not a mutation: the service holds the one it was handed
      // and mirrors it whole, so the downgrade has to arrive as a new request.
      state.pending = { ...state.pending, verified: false };
      this.#requestApproval(state.pending);
    }
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
    // Off the critical path: the socket does not wait on it, and a failure
    // costs nothing that runs today.
    void this.#loadNoiseStatic();
    this.#connect();
  }

  /**
   * Import the enrolled Noise static once, nonextractably. Never rejects: an
   * unusable key must not take down a Host whose shipped paths do not use one
   * (see {@link RemoteHost.#noiseStatic}).
   */
  async #loadNoiseStatic(): Promise<CryptoKeyLike | null> {
    if (this.#noiseStatic) return this.#noiseStatic;
    const pkcs8 = this.#enrollment.noiseStaticPrivateKey;
    if (pkcs8 === undefined) return null;
    try {
      this.#noiseStatic = await importNoiseStaticPrivateKey(pkcs8);
    } catch (error) {
      console.warn('[remote-host] could not import the Noise static key', error);
    }
    return this.#noiseStatic;
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
      state = { established: false, authGeneration: 0, pairGeneration: 0 };
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
      // before the clientId narrowing below: it is about this Host itself. The
      // relay is not trusted to have stamped a `mintId`, and an unrecognized
      // one is ignored downstream rather than retiring an unrelated code.
      if (typeof frame.mintId === 'string') this.#onSetupTokenRedeemed(frame.mintId);
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
      // A malformed replacement still supersedes proof work already in flight,
      // without allocating a new state record for a hostile unique clientId.
      const state = this.#clients.get(clientId);
      if (state) state.pairGeneration += 1;
      console.warn('remote-host: malformed pairing request');
      this.#send({ t: 'pair-result', clientId, approved: false, error: 'malformed-request' });
      return;
    }
    const state = this.#clientState(clientId);
    state.pairGeneration += 1;
    const generation = state.pairGeneration;
    // Verifying a setup proof is a MAC computation, so it cannot happen in this
    // turn. The QR-less path — every pairing until a phone has scanned, and
    // every pairing on a machine showing no code — is kept synchronous, because
    // a Host holding no nonces has nothing to compute against anyway.
    if (
      typeof incoming.setupProof !== 'string' ||
      this.#setupNonces.size === 0 ||
      this.#verifying >= MAX_PENDING_PAIRINGS
    ) {
      this.#enqueuePairing(clientId, incoming, null);
      return;
    }
    // A superseded socket must not enqueue: `#dropTransientState` cleared the
    // client map on the way down, and landing here afterwards would recreate an
    // entry under a relay-chosen key with a modal nobody can answer.
    const socket = this.#ws;
    this.#verifying += 1;
    void this.#matchSetupNonce(incoming)
      .then((nonce) => {
        if (
          this.#ws !== socket ||
          this.#clients.get(clientId) !== state ||
          state.pairGeneration !== generation
        ) {
          return;
        }
        this.#enqueuePairing(clientId, incoming, nonce);
      })
      .finally(() => {
        this.#verifying -= 1;
      });
  }

  /**
   * Turn a shape-checked `pair` request into the pending approval, having
   * settled which setup nonce (if any) proved it.
   *
   * A miss is **not** an error: an absent, unknown, expired or already-spent
   * proof simply pairs the ordinary way, because the phone may predate the QR
   * path or be re-pairing long after its code was spent.
   */
  #enqueuePairing(clientId: string, incoming: PairingRequest, nonce: string | null): void {
    // The label is attacker-chosen free text rendered in the one dialog the
    // ACL rests on. Bound and strip it here, once, so every consumer — the
    // queue projection, the modal, and the ACL record written on approval —
    // sees the same safe value.
    //
    // Field by field rather than a spread: `isPairingRequest` allows extras, and
    // a spread would forward whatever else the relay attached into the mirrored
    // queue and into the persisted ACL record. Naming the five is what makes an
    // unknown field fail closed.
    const request: MirroredPairingRequest = {
      accountId: boundedPairingAccount(incoming.accountId),
      passkeyCredentialId: incoming.passkeyCredentialId,
      passkeyPublicKeyHash: incoming.passkeyPublicKeyHash,
      devicePublicKey: incoming.devicePublicKey,
      requestedLabel: boundedPairingLabel(incoming.requestedLabel),
    };
    const ticket = this.#ceremony.begin(request);
    const pending: PendingPairing = {
      clientId,
      pairingId: ticket.pairingId,
      request,
      verified: nonce !== null,
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
    const state = this.#clientState(clientId);
    state.pending = pending;
    state.verifiedNonce = nonce ?? undefined;
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
    const nonce = state.verifiedNonce;
    state.verifiedNonce = undefined;
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
    // The ACL write is what the nonce authorized, so it is spent here and only
    // here — after the write, so a ceremony that threw leaves the code live.
    if (nonce !== undefined) this.#consumeSetupNonce(nonce);
    this.#saveAcl(this.#enrollment.hostId, this.#acl.records());
    this.#send({ t: 'pair-result', clientId, approved: true, record });
    this.#dismissApproval(clientId);
  }

  #denyPairing(clientId: string, pairingId: string, error = 'pairing denied by host'): void {
    const state = this.#clients.get(clientId);
    if (!state?.pending || state.pending.pairingId !== pairingId) return;
    state.pending = undefined;
    // A denial spends nothing: the person turned this device away, and the code
    // on their screen is still theirs to hand to the phone they meant.
    state.verifiedNonce = undefined;
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
