/**
 * Host-side relay controller. The Host speaks exactly two frames — the `e2e`
 * envelope and `client-gone` — and runs both end-to-end ceremonies itself:
 * `docs/specs/remote-security-model.md` owns Pairing, Connection, and the Host
 * bounds; `docs/specs/server.md` → Relay owns the envelope it rides in. The
 * remote-api session is injected, keeping this module environment-free.
 */

import {
  DEFAULT_PAIRING_TTL_MS,
  HostAcl,
  HostChallengeIssuer,
  MAX_PENDING_PAIRINGS,
  MAX_TOKENS_PER_HOST,
  NoiseError,
  NoiseTransportSession,
  WS_CLOSE_HOST_REPLACED,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  boundedPairingLabel,
  constantTimeEqual,
  createNoiseResponder,
  formatInvitationExpiry,
  fromBase64Url,
  generateNoiseKeyPair,
  getWebCrypto,
  importNoiseStaticPrivateKey,
  isConnectionRequestV1,
  isE2eServerToHostFrame,
  isPairingRequestV1,
  pairingInvitationPrologue,
  e2eConnectionPrologue,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  verifyPresenceProof,
  DELIVERY_ID_BYTE_LENGTH,
  type ConnectionOutcomeV1,
  type ConnectionPolicy,
  type E2eServerToHostFrame,
  type HostAclRecord,
  type HostFrame,
  type NoiseKeyPair,
  type PairingDenialCode,
  type PairingInvitation,
  type PairingOutcomeV1,
  type PresenceBinding,
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

/**
 * How many connection handshakes may be mid-flight across every client.
 *
 * Host-enforced and independent of the relay (`docs/specs/remote-security-model.md`
 * → Host bounds). Sibling of {@link MAX_PENDING_PAIRINGS}, and separate from it
 * because a connection allocates no modal and expires on the challenge TTL
 * rather than on a human's deliberation.
 */
export const MAX_PENDING_CONNECTION_HANDSHAKES = 8;

/** What one invitation is doing, as the QR panel renders it. */
export type InvitationState = 'live' | 'reserved' | 'consumed' | 'expired';

/** 256 bits, like every other unguessable handle in this system. */
const INVITE_ID_BYTE_LENGTH = 16;

/** One invitation the Host is holding, with the key only it knows. */
interface HeldInvitation {
  readonly invitation: PairingInvitation;
  /** The one-use responder keypair; erased with the entry. */
  readonly keyPair: NoiseKeyPair;
  /** This Host's own clock, never the Server's — see {@link RemoteHost.mintInvitation}. */
  readonly expiresAt: number;
  state: 'live' | 'reserved';
}

/** A pairing that has completed Noise and is awaiting the person at the Host. */
interface PendingPairingSession {
  readonly inviteId: string;
  /** Immutable id every approve/deny must name; the modal displays this one. */
  readonly pairingId: string;
  readonly session: NoiseTransportSession;
  readonly handshakeHash: string;
  readonly clientStaticPublicKey: string;
  readonly requestedAt: number;
  readonly expiresAt: number;
  /** Set once the first control message verified; until then there is no code. */
  approval?: {
    readonly code: string;
    readonly accountId: string;
    readonly passkeyCredentialId: string;
    readonly passkeyPublicKeyHash: string;
    readonly label: string;
  };
  /** **Exactly one attempt**: a second confirm is refused whatever it types. */
  attempted: boolean;
}

/** A connection that has completed Noise and is awaiting its presence proof. */
interface PendingConnectionSession {
  readonly connectionId: string;
  readonly session: NoiseTransportSession;
  readonly handshakeHash: string;
  readonly clientStaticPublicKey: string;
  readonly hostChallenge: string;
  readonly expiresAt: number;
}

/** An authorized session: the two cipher states plus the remote-api handler. */
interface EstablishedSession {
  readonly connectionId: string;
  readonly session: NoiseTransportSession;
  readonly api: RemoteApiSessionLike;
}

/** Per-client lifecycle state tracked by the Host, keyed by clientId. */
interface ClientState {
  pairing?: PendingPairingSession;
  connection?: PendingConnectionSession;
  established?: EstablishedSession;
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
   * this controller runs in the Tauri sidecar and the VS Code extension host, so
   * a default would drag `localStorage` into both Node bundles — and a forgotten
   * `saveAcl` has to be a type error rather than an approval that is lost at the
   * next restart.
   */
  loadAcl: (hostId: string) => HostAclRecord[];
  saveAcl: (hostId: string, records: readonly HostAclRecord[]) => void;
  /** Surface a pairing request for local approval. */
  requestApproval: (pending: PendingPairing) => void;
  /** Dismiss a surfaced request once resolved. */
  dismissApproval: (clientId: string) => void;
  /**
   * One of this Host's invitations changed state, so whoever is displaying its
   * QR can stop offering a code that can no longer be used. Nothing here acts
   * on it — the Host's own map is the authority.
   */
  onInvitationChanged?: (inviteId: string, state: InvitationState) => void;
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

  readonly #createWebSocket: (url: string) => WebSocketLike;
  readonly #createSession?: RemoteHostOptions['createSession'];
  readonly #saveAcl: (hostId: string, records: readonly HostAclRecord[]) => void;
  readonly #requestApproval: (pending: PendingPairing) => void;
  readonly #dismissApproval: (clientId: string) => void;
  readonly #onInvitationChanged: (inviteId: string, state: InvitationState) => void;
  readonly #now: () => number;
  readonly #reconnect: boolean;

  /**
   * Per-client lifecycle state keyed by clientId. Folding the three concerns
   * (pending pairing, pending connection, established session) into one record
   * makes teardown a single `delete` — no handler can leave the collections out
   * of sync.
   */
  readonly #clients = new Map<string, ClientState>();

  /**
   * The invitations this Host has minted and not yet spent, `inviteId → entry`.
   *
   * **The one-use responder key lives only here.** It never reaches the Server,
   * the webview, or the state file: the QR carries its *public* half to a phone
   * camera and no further, and completing IK against it is what proves the
   * scanning phone is talking to the machine whose screen it photographed
   * (`docs/specs/remote-security-model.md` → Pairing).
   *
   * Kept on the Host rather than in the service that composes the QR so its
   * lifetime *is* this Host's: a new Host starts with none, and a Host that
   * reconnects keeps the codes still on screen. Capped at
   * {@link MAX_TOKENS_PER_HOST}, the Server's own bound on the setup tokens
   * these ride with, so the two sides agree on live-versus-spent.
   */
  readonly #invitations = new Map<string, HeldInvitation>();

  /**
   * This Host's long-term Noise identity, imported nonextractably from the
   * enrollment — the responder static every *connection* runs against.
   *
   * Memoized as a promise rather than a value: the import is async, and a
   * connection `init` arriving before `start()`'s import settles must await the
   * same import rather than race a second one or be dropped.
   */
  #noiseStatic: Promise<NoiseKeyPair | null> | null = null;

  /**
   * Frames are handled one at a time, in arrival order. Every `e2e` step awaits
   * WebCrypto, so unchained handlers would let a pipelined `transport` overtake
   * the `init` that has to create its session.
   */
  #chain: Promise<void> = Promise.resolve();

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

    this.#createWebSocket =
      options.createWebSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.#createSession = options.createSession;
    this.#saveAcl = options.saveAcl;
    this.#requestApproval = options.requestApproval;
    this.#dismissApproval = options.dismissApproval;
    this.#onInvitationChanged = options.onInvitationChanged ?? (() => {});
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

  // --- Invitations ---------------------------------------------------------

  /**
   * Mint one invitation for a setup QR: an id, a one-use X25519 responder
   * keypair, and the expiry the code advertises.
   *
   * **One clock.** The Host's own `now` plus the shared pairing TTL bounds the
   * entry; `serverExpiresAtMs` is the Server's opinion about its setup token,
   * and only the *earlier* of the two reaches the QR — an advisory value that
   * over-promised would send a phone into a handshake this Host will refuse.
   *
   * Prunes on insert, since nothing else sweeps this map, and evicts its own
   * oldest at the cap: the code longest on screen is the one whose scanner has
   * most likely given up.
   */
  async mintInvitation(setupToken: string, serverExpiresAtMs: number): Promise<PairingInvitation> {
    const now = this.#now();
    this.#reapInvitations(now);
    while (this.#invitations.size >= MAX_TOKENS_PER_HOST) {
      const oldest = this.#invitations.keys().next();
      if (oldest.done) break;
      this.#retireInvitation(oldest.value, 'consumed');
    }
    const expiresAt = Math.min(now + DEFAULT_PAIRING_TTL_MS, serverExpiresAtMs);
    const keyPair = await generateNoiseKeyPair();
    const inviteId = toBase64Url(
      getWebCrypto().getRandomValues(new Uint8Array(INVITE_ID_BYTE_LENGTH)),
    );
    const invitation: PairingInvitation = {
      hostId: this.#enrollment.hostId,
      inviteId,
      expiry: Math.floor(expiresAt / 1000),
      setupToken,
      ephPub: keyPair.publicKey,
      ephPubBase64Url: toBase64Url(keyPair.publicKey),
    };
    // Throws on a non-uint32 expiry before anything is stored, so a broken clock
    // cannot leave an entry no URL can ever be composed for.
    formatInvitationExpiry(invitation.expiry);
    this.#invitations.set(inviteId, { invitation, keyPair, expiresAt, state: 'live' });
    return invitation;
  }

  /**
   * What one invitation is doing. An id this Host has never held, or no longer
   * holds, reads as `consumed`: from the panel's side those are the same fact —
   * the code on screen can no longer be used.
   */
  invitationState(inviteId: string): InvitationState {
    const held = this.#invitations.get(inviteId);
    if (!held) return 'consumed';
    if (held.expiresAt <= this.#now()) return 'expired';
    return held.state;
  }

  /** Outstanding invitations, for the cap's own test. */
  get outstandingInvitationCount(): number {
    return this.#invitations.size;
  }

  #reapInvitations(now: number): void {
    for (const [inviteId, held] of this.#invitations) {
      if (held.expiresAt <= now) this.#retireInvitation(inviteId, 'expired');
    }
  }

  /** Drop an invitation and its key, announcing the state it ended in. */
  #retireInvitation(inviteId: string, state: 'consumed' | 'expired'): void {
    if (!this.#invitations.delete(inviteId)) return;
    this.#onInvitationChanged(inviteId, state);
  }

  // --- Socket lifecycle ----------------------------------------------------

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
    // Kicked off here so the import is normally settled before the first frame;
    // the connection path awaits the same promise, so a race costs a wait
    // rather than a dropped handshake.
    void this.#loadNoiseStatic();
    this.#connect();
  }

  /**
   * Import the enrolled Noise static once, nonextractably.
   *
   * Resolves `null` rather than rejecting when there is nothing usable: the
   * service refuses to start a Host whose halves disagree
   * (`lib/src/host/remote/service.ts`), so reaching that here means the state
   * file changed underneath us, and a connection that finds no static simply
   * never answers.
   */
  #loadNoiseStatic(): Promise<NoiseKeyPair | null> {
    this.#noiseStatic ??= (async () => {
      const pkcs8 = this.#enrollment.noiseStaticPrivateKey;
      const publicKey = this.#enrollment.noiseStaticPublicKey;
      if (pkcs8 === undefined || publicKey === undefined) return null;
      try {
        return { privateKey: await importNoiseStaticPrivateKey(pkcs8), publicKey: fromBase64Url(publicKey) };
      } catch (error) {
        console.warn('[remote-host] could not import the Noise static key', error);
        return null;
      }
    })();
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

  /**
   * Connection-scoped state resets on a dropped socket (the ACL persists).
   * Invitations go too: the key behind a code belongs to the socket the code
   * was minted over.
   */
  #dropTransientState(): void {
    for (const clientId of [...this.#clients.keys()]) this.#disposeClient(clientId);
    this.#clients.clear();
    for (const inviteId of [...this.#invitations.keys()]) {
      this.#retireInvitation(inviteId, 'consumed');
    }
  }

  /**
   * How many clients this Host is tracking. Exists for the pending bounds'
   * tests: the growth they guard against is in a private map, and a bound
   * nothing can observe is how the first version of such a cap passed its own
   * test while the map kept growing.
   */
  get trackedClientCount(): number {
    return this.#clients.size;
  }

  #clientState(clientId: string): ClientState {
    let state = this.#clients.get(clientId);
    if (!state) {
      state = {};
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

  // --- Frame handling ------------------------------------------------------

  #onFrame(raw: unknown): void {
    let frame: ServerToHostFrame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : '') as ServerToHostFrame;
    } catch {
      return;
    }
    if (!frame || typeof (frame as { t?: unknown }).t !== 'string') return;
    if (frame.t === 'client-gone') {
      // Bounded before it is used as a map key: the relay chooses it, and this
      // is the only frame that reaches the map without the `e2e` guard.
      if (typeof frame.clientId === 'string') this.#onClientGone(frame.clientId);
      return;
    }
    if (frame.t !== 'e2e') return;
    // The shape guard bounds every routing value — including `clientId`, before
    // the ciphertext scan — and this Host runs it rather than trusting the relay
    // to have (`docs/specs/server.md` → Relay).
    if (!isE2eServerToHostFrame(frame)) return;
    const e2e = frame;
    this.#chain = this.#chain.then(() => this.#onE2e(e2e)).catch((error: unknown) => {
      // A ceremony step must never reject into the chain: this Host runs in
      // Node, where an unhandled rejection can take the sidecar or the extension
      // host down rather than merely logging in a webview.
      console.warn('[remote-host] e2e frame failed', error);
    });
  }

  async #onE2e(frame: E2eServerToHostFrame): Promise<void> {
    this.#reapInvitations(this.#now());
    if (frame.kind === 'pairing') {
      if (frame.step === 'init') return await this.#onPairingInit(frame);
      return await this.#onPairingTransport(frame);
    }
    if (frame.step === 'init') return await this.#onConnectionInit(frame);
    return await this.#onConnectionTransport(frame);
  }

  // --- Pairing -------------------------------------------------------------

  /**
   * Noise message 1 against one invitation's key. A frame naming an invitation
   * this Host does not hold live is **dropped without decryption** — an unknown
   * id must cost a map lookup, not a handshake.
   */
  async #onPairingInit(frame: E2eServerToHostFrame): Promise<void> {
    const held = this.#invitations.get(frame.id);
    if (!held || held.state !== 'live') return;
    let handshakeHash: string;
    let clientStaticPublicKey: string;
    let session: NoiseTransportSession;
    let message2: Uint8Array;
    try {
      const handshake = await createNoiseResponder({
        prologue: pairingInvitationPrologue(held.invitation),
        staticKeyPair: held.keyPair,
      });
      const payload = await handshake.readMessage(fromBase64Url(frame.ct));
      // Both handshake payloads are empty; anything else is a peer this Host
      // does not speak the same protocol as.
      if (payload.length !== 0) throw new NoiseError('pairing message 1 carries a payload');
      message2 = await handshake.writeMessage();
      const remoteStatic = handshake.remoteStaticPublicKey;
      if (!remoteStatic) throw new NoiseError('IK did not authenticate a Client static');
      clientStaticPublicKey = toBase64Url(remoteStatic);
      session = new NoiseTransportSession(handshake.session);
      handshakeHash = toBase64Url(session.handshakeHash);
    } catch {
      // The invitation stays live: nothing decrypted against it, so no scanner
      // has been spent — only a valid message 1 reserves one.
      return;
    }
    // Nothing above allocated a client entry: a handshake that fails must cost
    // a WebCrypto call and no map slot under a relay-chosen key.
    //
    // A replacement from the same client supersedes its predecessor, which is
    // told so over its own session before the material is erased.
    if (this.#clients.get(frame.clientId)?.pairing) {
      this.#finishPairing(frame.clientId, 'superseded');
    }
    this.#evictOldestPairingIfFull();
    held.state = 'reserved';
    this.#onInvitationChanged(held.invitation.inviteId, 'reserved');
    const now = this.#now();
    this.#clientState(frame.clientId).pairing = {
      inviteId: held.invitation.inviteId,
      pairingId: toBase64Url(getWebCrypto().getRandomValues(new Uint8Array(INVITE_ID_BYTE_LENGTH))),
      session,
      handshakeHash,
      clientStaticPublicKey,
      requestedAt: now,
      expiresAt: held.expiresAt,
      attempted: false,
    };
    this.#send({
      t: 'e2e',
      clientId: frame.clientId,
      kind: 'pairing',
      id: frame.id,
      step: 'response',
      ct: toBase64Url(message2),
    });
  }

  /**
   * The first Client→Host transport payload of a pairing: a `PairingRequestV1`
   * carrying the two digits, the device label, and the presence proof.
   *
   * Anything else is terminal. The invitation is single-use and the person at
   * the Host is about to be interrupted, so a peer that cannot produce the one
   * message this step expects spends the code rather than being allowed to
   * retry against it.
   */
  async #onPairingTransport(frame: E2eServerToHostFrame): Promise<void> {
    const state = this.#clients.get(frame.clientId);
    const pending = state?.pairing;
    // Processed only for its exact pending id: an unknown one is dropped
    // without decryption.
    if (!pending || pending.inviteId !== frame.id) return;
    if (pending.expiresAt <= this.#now()) {
      this.#finishPairing(frame.clientId, 'invitation-expired');
      return;
    }
    let receipt;
    try {
      receipt = pending.session.receive(fromBase64Url(frame.ct));
    } catch {
      // The first invalid ciphertext destroys its session; there is no
      // resynchronization point in a stream cipher, and nothing can be said
      // over a poisoned one.
      this.#disposePairing(frame.clientId, 'consumed');
      return;
    }
    if (receipt.kind === 'keepalive') return;
    // Already surfaced to the user: further traffic is noise until they answer.
    if (pending.approval) return;
    if (receipt.kind !== 'control' || !isPairingRequestV1(receipt.value)) {
      this.#finishPairing(frame.clientId, 'host-error');
      return;
    }
    const request = receipt.value;
    const binding: PresenceBinding = {
      kind: 'pairing',
      hostId: this.#enrollment.hostId,
      handshakeHash: pending.handshakeHash,
      passkeyCredentialId: request.presence.binding.passkeyCredentialId,
    };
    const proof = await verifyPresenceProof(request.presence, binding, this.#policy);
    // The client may have gone, or been superseded, while WebCrypto ran.
    if (this.#clients.get(frame.clientId)?.pairing !== pending) return;
    if (!proof.ok) {
      console.warn(`[remote-host] pairing presence rejected: ${proof.reason}`);
      this.#finishPairing(frame.clientId, 'presence-rejected');
      return;
    }
    pending.approval = {
      code: request.code,
      accountId: request.presence.accountId,
      passkeyCredentialId: request.presence.binding.passkeyCredentialId,
      passkeyPublicKeyHash: proof.passkeyPublicKeyHash,
      // Attacker-chosen free text rendered in the one dialog the ACL rests on:
      // bounded and stripped once, here, so the queue projection, the modal, and
      // the persisted record all see the same safe value.
      label: boundedPairingLabel(request.label),
    };
    this.#requestApproval({
      clientId: frame.clientId,
      pairingId: pending.pairingId,
      label: pending.approval.label,
      requestedAt: pending.requestedAt,
      approve: (code) => this.#approvePairing(frame.clientId, pending.pairingId, code),
      deny: () => this.#denyPairing(frame.clientId, pending.pairingId),
    });
  }

  /**
   * The local confirmation — the ONLY path that writes the ACL.
   *
   * **Exactly one attempt.** The secret is two digits, so a second guess would
   * be worth 1% of the space; the compare is constant-time for the same reason
   * an early exit anywhere else is a leak, and the attempt is spent before the
   * comparison so a throw cannot leave a retry behind.
   */
  #approvePairing(clientId: string, pairingId: string, code: string): void {
    const pending = this.#clients.get(clientId)?.pairing;
    if (!pending || pending.pairingId !== pairingId || !pending.approval) return;
    if (pending.attempted) return;
    pending.attempted = true;
    if (pending.expiresAt <= this.#now()) {
      this.#finishPairing(clientId, 'invitation-expired');
      return;
    }
    if (!constantTimeEqual(utf8Encode(code), utf8Encode(pending.approval.code))) {
      this.#finishPairing(clientId, 'confirmation-mismatch');
      return;
    }
    const deliveryId = toBase64Url(
      getWebCrypto().getRandomValues(new Uint8Array(DELIVERY_ID_BYTE_LENGTH)),
    );
    const record = this.#acl.approve({
      accountId: pending.approval.accountId,
      passkeyCredentialId: pending.approval.passkeyCredentialId,
      passkeyPublicKeyHash: pending.approval.passkeyPublicKeyHash,
      clientStaticPublicKey: pending.clientStaticPublicKey,
      deliveryId,
      approvedBy: 'host-user',
      label: pending.approval.label,
    });
    this.#saveAcl(this.#enrollment.hostId, this.#acl.records());
    this.#sendPairingOutcome(clientId, pending, {
      ok: true,
      hostStaticPublicKey: this.#enrollment.noiseStaticPublicKey ?? '',
      hostLabel: this.#enrollment.label ?? '',
      accountId: record.accountId,
      passkeyCredentialId: record.passkeyCredentialId,
      passkeyPublicKeyHash: record.passkeyPublicKeyHash,
      deliveryId,
    });
    this.#disposePairing(clientId, 'consumed');
  }

  #denyPairing(clientId: string, pairingId: string): void {
    const pending = this.#clients.get(clientId)?.pairing;
    if (!pending || pending.pairingId !== pairingId) return;
    this.#finishPairing(clientId, 'user-denied');
  }

  /** Send one denial and end the pairing; every terminal outcome runs through here. */
  #finishPairing(clientId: string, code: PairingDenialCode): void {
    const pending = this.#clients.get(clientId)?.pairing;
    if (!pending) return;
    this.#sendPairingOutcome(clientId, pending, { ok: false, code });
    this.#disposePairing(clientId, 'consumed');
  }

  #sendPairingOutcome(
    clientId: string,
    pending: PendingPairingSession,
    outcome: PairingOutcomeV1,
  ): void {
    this.#sendControl(clientId, 'pairing', pending.inviteId, pending.session, outcome);
  }

  /**
   * Erase a pairing's handshake material and spend its invitation. Both, always:
   * an invitation that survived its ceremony would let a second phone reserve
   * the code the person has already answered for.
   */
  #disposePairing(clientId: string, invitationState: 'consumed' | 'expired'): void {
    const state = this.#clients.get(clientId);
    const pending = state?.pairing;
    if (!state || !pending) return;
    state.pairing = undefined;
    this.#retireInvitation(pending.inviteId, invitationState);
    this.#dismissApproval(clientId);
    this.#pruneClient(clientId);
  }

  /**
   * Drop the oldest pending pairing when the queue is full, so a new request
   * displaces one rather than growing the map. Oldest first: whoever initiated
   * it is the least likely to still be waiting on the modal.
   *
   * Bounds the *pairing* path specifically — a connection allocates its own
   * entry, and evicting one that may be established is a different act from
   * denying a pending request.
   */
  #evictOldestPairingIfFull(): void {
    for (;;) {
      let pendingCount = 0;
      let oldestId: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, state] of this.#clients) {
        if (!state.pairing) continue;
        pendingCount++;
        if (state.pairing.requestedAt < oldestAt) {
          oldestAt = state.pairing.requestedAt;
          oldestId = id;
        }
      }
      if (pendingCount < MAX_PENDING_PAIRINGS || oldestId === null) return;
      this.#finishPairing(oldestId, 'superseded');
    }
  }

  // --- Connection ----------------------------------------------------------

  /**
   * Noise message 1 against this Host's long-term static. Message 2's payload
   * is the fresh 32-byte challenge the presence proof must bind to, so
   * completing the handshake proves both statics and authorizes nothing.
   */
  async #onConnectionInit(frame: E2eServerToHostFrame): Promise<void> {
    const staticKeyPair = await this.#loadNoiseStatic();
    if (!staticKeyPair) return;
    const { challenge, expiresAt } = this.#challenges.issue();
    let session: NoiseTransportSession;
    let message2: Uint8Array;
    let clientStaticPublicKey: string;
    try {
      const handshake = await createNoiseResponder({
        prologue: e2eConnectionPrologue(this.#enrollment.hostId, frame.id),
        staticKeyPair,
      });
      const payload = await handshake.readMessage(fromBase64Url(frame.ct));
      if (payload.length !== 0) throw new NoiseError('connection message 1 carries a payload');
      message2 = await handshake.writeMessage(fromBase64Url(challenge));
      const remoteStatic = handshake.remoteStaticPublicKey;
      if (!remoteStatic) throw new NoiseError('IK did not authenticate a Client static');
      clientStaticPublicKey = toBase64Url(remoteStatic);
      session = new NoiseTransportSession(handshake.session);
    } catch {
      // Failures before `Split` yield only a generic outer error: there is no
      // session to encrypt a denial on, so silence is the whole answer.
      return;
    }
    // At most one pending connection per relay client; a replacement disposes
    // its predecessor without answering it. As above, no entry was allocated
    // before the handshake proved itself.
    this.#disposeConnection(frame.clientId);
    this.#evictOldestConnectionIfFull();
    this.#clientState(frame.clientId).connection = {
      connectionId: frame.id,
      session,
      handshakeHash: toBase64Url(session.handshakeHash),
      clientStaticPublicKey,
      hostChallenge: challenge,
      expiresAt,
    };
    this.#send({
      t: 'e2e',
      clientId: frame.clientId,
      kind: 'connection',
      id: frame.id,
      step: 'response',
      ct: toBase64Url(message2),
    });
  }

  /**
   * Transport on a connection: the authorization control while one is pending,
   * then protocol-v1 application messages once it is established.
   */
  async #onConnectionTransport(frame: E2eServerToHostFrame): Promise<void> {
    const state = this.#clients.get(frame.clientId);
    if (!state) return;
    if (state.established?.connectionId === frame.id) {
      this.#onEstablishedFrame(frame.clientId, state.established, frame.ct);
      return;
    }
    const pending = state.connection;
    if (!pending || pending.connectionId !== frame.id) return;
    let receipt;
    try {
      receipt = pending.session.receive(fromBase64Url(frame.ct));
    } catch {
      this.#disposeConnection(frame.clientId);
      return;
    }
    if (receipt.kind === 'keepalive') return;
    if (receipt.kind !== 'control' || !isConnectionRequestV1(receipt.value)) {
      this.#denyConnection(frame.clientId, pending, 'protocol-rejected');
      return;
    }
    const request = receipt.value;
    // Consumed before any other work, so a challenge can never be presented
    // twice whatever the rest of this decision does.
    const challengeValid = this.#challenges.consume(pending.hostChallenge);
    const binding: PresenceBinding = {
      kind: 'connection',
      hostId: this.#enrollment.hostId,
      connectionId: pending.connectionId,
      hostChallenge: pending.hostChallenge,
      handshakeHash: pending.handshakeHash,
      passkeyCredentialId: request.presence.binding.passkeyCredentialId,
    };
    const proof = await verifyPresenceProof(request.presence, binding, this.#policy);
    if (this.#clients.get(frame.clientId)?.connection !== pending) return;
    if (!challengeValid || !proof.ok) {
      console.warn(
        `[remote-host] connection presence rejected: ${challengeValid ? (proof.ok ? '' : proof.reason) : 'challenge-invalid'}`,
      );
      this.#denyConnection(frame.clientId, pending, 'presence-rejected');
      return;
    }
    const authorization = this.#acl.authorize({
      passkeyCredentialId: binding.passkeyCredentialId,
      clientStaticPublicKey: pending.clientStaticPublicKey,
    });
    // One record must hold all four identities. Which one failed is logged
    // owner-locally and never returned: every miss is `pairing-required`.
    const record = authorization.record;
    const miss =
      record === null
        ? authorization.reasons.join(',')
        : record.accountId !== request.presence.accountId
          ? 'account-mismatch'
          : record.passkeyPublicKeyHash !== proof.passkeyPublicKeyHash
            ? 'passkey-key-mismatch'
            : null;
    if (miss !== null) {
      console.warn(`[remote-host] connection refused: ${miss}`);
      this.#denyConnection(frame.clientId, pending, 'pairing-required');
      return;
    }
    this.#promoteConnection(frame.clientId, pending);
  }

  /** Success: answer, then hand the session's byte stream to protocol-v1. */
  #promoteConnection(clientId: string, pending: PendingConnectionSession): void {
    const state = this.#clientState(clientId);
    state.connection = undefined;
    state.established?.api.dispose();
    this.#sendControl(clientId, 'connection', pending.connectionId, pending.session, {
      ok: true,
      hostLabel: this.#enrollment.label ?? '',
    } satisfies ConnectionOutcomeV1);
    if (!this.#createSession) return;
    const api = this.#createSession({
      hostId: this.#enrollment.hostId,
      send: (payload) => {
        this.#sendApp(clientId, pending, payload);
      },
    });
    state.established = { connectionId: pending.connectionId, session: pending.session, api };
  }

  #denyConnection(
    clientId: string,
    pending: PendingConnectionSession,
    code: Exclude<ConnectionOutcomeV1, { ok: true }>['code'],
  ): void {
    this.#sendControl(clientId, 'connection', pending.connectionId, pending.session, {
      ok: false,
      code,
    } satisfies ConnectionOutcomeV1);
    this.#disposeConnection(clientId);
  }

  #disposeConnection(clientId: string): void {
    const state = this.#clients.get(clientId);
    if (!state?.connection) return;
    state.connection = undefined;
    this.#pruneClient(clientId);
  }

  #evictOldestConnectionIfFull(): void {
    for (;;) {
      let pendingCount = 0;
      let oldestId: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, state] of this.#clients) {
        if (!state.connection) continue;
        pendingCount++;
        if (state.connection.expiresAt < oldestAt) {
          oldestAt = state.connection.expiresAt;
          oldestId = id;
        }
      }
      if (pendingCount < MAX_PENDING_CONNECTION_HANDSHAKES || oldestId === null) return;
      // No outcome: the evicted peer never authenticated, and answering it would
      // let a flood of `init` frames buy a reply each.
      this.#disposeConnection(oldestId);
    }
  }

  /** One transport frame on an authorized session: protocol-v1, or a keepalive. */
  #onEstablishedFrame(clientId: string, established: EstablishedSession, ct: string): void {
    let receipt;
    try {
      receipt = established.session.receive(fromBase64Url(ct));
    } catch {
      this.#disposeEstablished(clientId);
      return;
    }
    // Keepalives are accepted and ignored; the idle reaper they feed is staged
    // (`docs/specs/remote-security-model.md` → `## Future` → Host bounds).
    if (receipt.kind !== 'app') return;
    for (const message of receipt.messages) {
      let payload: unknown;
      try {
        payload = JSON.parse(utf8Decode(message));
      } catch {
        // Authenticated, so it came from the paired Client — but a peer sending
        // non-JSON on the application stream is not one this Host can talk to,
        // and parsing failures must not reject into the frame chain.
        console.warn('[remote-host] discarding a non-JSON application message');
        continue;
      }
      established.api.handle(payload);
    }
  }

  #sendApp(clientId: string, pending: PendingConnectionSession, payload: unknown): void {
    try {
      for (const ciphertext of pending.session.sendApp(utf8Encode(JSON.stringify(payload)))) {
        this.#send({
          t: 'e2e',
          clientId,
          kind: 'connection',
          id: pending.connectionId,
          step: 'transport',
          ct: toBase64Url(ciphertext),
        });
      }
    } catch {
      this.#disposeEstablished(clientId);
    }
  }

  #disposeEstablished(clientId: string): void {
    const state = this.#clients.get(clientId);
    if (!state?.established) return;
    state.established.api.dispose();
    state.established = undefined;
    this.#pruneClient(clientId);
  }

  // --- Shared plumbing -----------------------------------------------------

  /**
   * One control message on a ceremony session. Every outcome — approval and
   * denial alike — is the same NUL-padded size, so the relay learns nothing
   * from a length (`docs/specs/server.md` → E2E framing).
   */
  #sendControl(
    clientId: string,
    kind: 'pairing' | 'connection',
    id: string,
    session: NoiseTransportSession,
    value: Record<string, unknown> | PairingOutcomeV1 | ConnectionOutcomeV1,
  ): void {
    let ciphertext: Uint8Array;
    try {
      ciphertext = session.sendControl(value as Record<string, unknown>);
    } catch {
      // A poisoned session has nothing to say; the caller disposes it anyway.
      return;
    }
    this.#send({ t: 'e2e', clientId, kind, id, step: 'transport', ct: toBase64Url(ciphertext) });
  }

  /** Forget a client that holds nothing, so a relay-chosen key cannot accumulate. */
  #pruneClient(clientId: string): void {
    const state = this.#clients.get(clientId);
    if (state && !state.pairing && !state.connection && !state.established) {
      this.#clients.delete(clientId);
    }
  }

  #disposeClient(clientId: string): void {
    const state = this.#clients.get(clientId);
    if (!state) return;
    if (state.pairing) {
      this.#retireInvitation(state.pairing.inviteId, 'consumed');
      state.pairing = undefined;
      this.#dismissApproval(clientId);
    }
    state.connection = undefined;
    state.established?.api.dispose();
    state.established = undefined;
  }

  #onClientGone(clientId: string): void {
    this.#disposeClient(clientId);
    this.#clients.delete(clientId);
  }
}

/** The `code` of a `CloseEvent`, or undefined if the socket gave us none. */
function closeCode(ev: unknown): number | undefined {
  const code = (ev as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}
