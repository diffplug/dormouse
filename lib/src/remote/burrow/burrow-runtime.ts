/**
 * Burrow-side relay controller. The Burrow speaks exactly two frames — the `e2e`
 * envelope and `client-gone` — and runs both end-to-end ceremonies itself:
 * `docs/specs/remote-security-model.md` owns Pairing, Connection, and the Burrow
 * bounds; `docs/specs/relay.md` → Relay owns the envelope it rides in. The
 * remote-api session is injected, keeping this module environment-free.
 */

import {
  DEFAULT_PAIRING_TTL_MS,
  E2E_INIT_BURST,
  E2E_INIT_REFILL_INTERVAL_MS,
  ESTABLISHED_E2E_IDLE_TIMEOUT_MS,
  BurrowAcl,
  ChallengeIssuer,
  MAX_ESTABLISHED_E2E_SESSIONS,
  MAX_PENDING_PAIRINGS,
  MAX_TOKENS_PER_BURROW,
  NoiseError,
  NoiseTransportSession,
  TokenBucket,
  WS_CLOSE_BURROW_REPLACED,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  boundedBurrowLabel,
  boundedPairingLabel,
  constantTimeEqual,
  createNoiseResponder,
  formatInvitationExpiry,
  fromBase64Url,
  generateNoiseKeyPair,
  importNoiseStaticPrivateKey,
  isBoundedString,
  isConnectionRequestV1,
  isE2eRelayToBurrowFrame,
  isPairingRequestV1,
  MAX_CLIENT_ID_LENGTH,
  MAX_SERVER_TO_BURROW_FRAME_LENGTH,
  pairingInvitationPrologue,
  e2eConnectionPrologue,
  randomBase64Url,
  sealPush,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  verifyPresenceProof,
  DELIVERY_ID_BYTE_LENGTH,
  type ConnectionOutcomeV1,
  type ConnectionPolicy,
  type E2eRelayToBurrowFrame,
  type BurrowAclRecord,
  type BurrowFrame,
  type NoiseKeyPair,
  type PairingDenialCode,
  type PairingInvitation,
  type PairingOutcomeV1,
  type PresenceBinding,
  type SealedPushV1,
  type RelayToBurrowFrame,
} from 'remote-lib-common';
import type { BurrowEnrollment } from './enrollment';
import { burrowTimer, type RemoteTimer, type RemoteWebSocket } from '../ws';
import { loadBurrowAcl } from './acl';
import type { PendingPairing } from './pairing-approval';

/** The remote-api handler this controller drives per authorized client. */
export interface RemoteApiSessionLike {
  handle(data: unknown): void;
  dispose(): void;
}

/** Minimal WebSocket surface, so tests can inject a fake. */
export type WebSocketLike = RemoteWebSocket;

/**
 * Re-exported beside {@link WebSocketLike} on purpose: a burrow that constructs a
 * real socket must hand it this as `maxPayload`, and the burrows reach this file
 * by relative path without `remote-lib-common` on their own resolution path.
 * Two numbers here would be two bounds that could drift.
 */
export { MAX_SERVER_TO_BURROW_FRAME_LENGTH } from 'remote-lib-common';

/**
 * How many connection handshakes may be mid-flight across every client.
 *
 * Burrow-enforced and independent of the relay (`docs/specs/remote-security-model.md`
 * → Burrow bounds). Sibling of {@link MAX_PENDING_PAIRINGS}, and separate from it
 * because a connection allocates no modal and expires on the challenge TTL
 * rather than on a human's deliberation.
 */
export const MAX_PENDING_CONNECTION_HANDSHAKES = 8;

/**
 * What one invitation is doing, as the QR panel renders it.
 *
 * **`dropped` is not `consumed`.** A code the Burrow discarded un-scanned — its
 * relay socket went, or a newer mint evicted it — must not be reported as a
 * scan, or the panel tells the user to finish on a phone that never asked.
 */
export type InvitationState = 'live' | 'reserved' | 'consumed' | 'expired' | 'dropped';

/**
 * The subset a *change* can carry. `live` is a resting state a query answers
 * with, never one this Burrow announces an invitation moving to, and naming the
 * difference once keeps every consumer from re-deriving it.
 */
export type TerminalInvitationState = Exclude<InvitationState, 'live'>;

/**
 * How one pairing ceremony ended, for the person standing at this machine.
 *
 * **Not {@link InvitationState}, which is about a code.** An invitation is also
 * retired by things that decided nothing — a lost relay socket, a TTL nobody
 * reached — and only a ceremony a phone actually started has an outcome. So the
 * two travel together and neither is derivable from the other: every outcome
 * rides a `consumed`, and a `consumed` may carry none.
 *
 * A closed set this Burrow picks locally. `paired` is the only member that wrote
 * an ACL record; the other five name why nothing was. The webview renders fixed
 * copy per member and never wire text
 * (`docs/specs/remote-security-model.md` → Pairing).
 */
export type PairingOutcome =
  | 'paired'
  | 'code-mismatch'
  | 'cancelled'
  | 'expired'
  | 'superseded'
  | 'burrow-error';

/**
 * What each denial reports locally. A `Record` so a new denial code is a type
 * error here rather than a ceremony that ends in silence at the panel.
 *
 * `presence-rejected` reads as `burrow-error`: from this machine's side both are
 * "it could not finish, and nothing was paired", and the phone — which is where
 * the passkey that failed lives — gets its own sentence for it
 * (`PAIRING_DENIAL_MESSAGES` in `lib/src/remote/client/pocket-client.ts`).
 */
const PAIRING_OUTCOME_FOR_DENIAL: Record<PairingDenialCode, PairingOutcome> = {
  'user-denied': 'cancelled',
  'confirmation-mismatch': 'code-mismatch',
  'presence-rejected': 'burrow-error',
  'invitation-expired': 'expired',
  superseded: 'superseded',
  'burrow-error': 'burrow-error',
};

/**
 * How many bytes name one thing this Burrow mints locally: the invitation id the
 * QR carries, and the pairing id the modal echoes back. 16, the length every
 * routing id on the `e2e` envelope is — the QR grammar pins the invitation id
 * at exactly that (`remote-lib-common/src/security/pairing-invitation.ts`), and
 * a longer one would render a code no parser accepts.
 */
const LOCAL_ID_BYTE_LENGTH = 16;

/** One invitation the Burrow is holding, with the key only it knows. */
interface HeldInvitation {
  readonly invitation: PairingInvitation;
  /** The one-use responder keypair; erased with the entry. */
  readonly keyPair: NoiseKeyPair;
  /** This Burrow's own clock, never the Relay's — see {@link BurrowRuntime.mintInvitation}. */
  readonly expiresAt: number;
  state: 'live' | 'reserved';
}

/** A pairing that has completed Noise and is awaiting the person at the Burrow. */
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
  readonly burrowChallenge: string;
  readonly expiresAt: number;
}

/** An authorized session: the two cipher states plus the remote-api handler. */
interface EstablishedSession {
  readonly connectionId: string;
  readonly session: NoiseTransportSession;
  readonly api: RemoteApiSessionLike;
  /** The IK-authenticated Client static — what the session cap is keyed on. */
  readonly clientStaticPublicKey: string;
  /** When this Burrow last **decrypted** a Client→Burrow transport message here. */
  lastClientActivityAt: number;
}

/** Per-client lifecycle state tracked by the Burrow, keyed by clientId. */
interface ClientState {
  pairing?: PendingPairingSession;
  connection?: PendingConnectionSession;
  established?: EstablishedSession;
}

/**
 * `disconnected` is a socket we expect to get back (a reconnect is armed);
 * `displaced` is a socket another Burrow took from us and no timer will restore
 * (see {@link BurrowRuntime.start}); `stopped` is a socket we closed ourselves.
 */
export type BurrowStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'displaced'
  | 'stopped';

export interface BurrowOptions {
  enrollment: BurrowEnrollment;
  createWebSocket?: (url: string) => WebSocketLike;
  /** Build the remote-api handler for an authorized client (see activation.ts). */
  createSession?: (opts: {
    burrowId: string;
    send: (payload: unknown) => void;
  }) => RemoteApiSessionLike;
  /**
   * Where the ACL comes from and goes. Required, with no webview-store default:
   * this controller runs in the Tauri sidecar and the VS Code extension host, so
   * a default would drag `localStorage` into both Node bundles — and a forgotten
   * `saveAcl` has to be a type error rather than an approval that is lost at the
   * next restart.
   */
  loadAcl: (burrowId: string) => BurrowAclRecord[];
  saveAcl: (burrowId: string, records: readonly BurrowAclRecord[]) => void;
  /** Surface a pairing request for local approval. */
  requestApproval: (pending: PendingPairing) => void;
  /** Dismiss a surfaced request once resolved. */
  dismissApproval: (clientId: string) => void;
  /**
   * One of this Burrow's invitations changed state, so whoever is displaying its
   * QR can stop offering a code that can no longer be used. Nothing here acts
   * on it — the Burrow's own map is the authority.
   *
   * `outcome` is present only where a pairing ceremony ended, and says how
   * ({@link PairingOutcome}).
   */
  onInvitationChanged?: (
    inviteId: string,
    state: InvitationState,
    outcome?: PairingOutcome,
  ) => void;
  now?: () => number;
  /**
   * Every timer this Burrow arms — the reaper's and the reconnect backoff's — as
   * `(run, delayMs) => cancel`. Injectable so a test driving `now` off a fake
   * clock can fire expiry deterministically instead of waiting out a five-minute
   * TTL in real milliseconds, and so `stop()` leaving nothing armed is a thing a
   * test can observe.
   */
  setTimer?: RemoteTimer;
  /** Auto-reconnect with backoff (default true; tests pass false). */
  reconnect?: boolean;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export class BurrowRuntime {
  readonly #enrollment: BurrowEnrollment;
  readonly #policy: ConnectionPolicy;
  readonly #acl: BurrowAcl;
  readonly #challenges: ChallengeIssuer;

  readonly #createWebSocket: (url: string) => WebSocketLike;
  readonly #createSession?: BurrowOptions['createSession'];
  readonly #saveAcl: (burrowId: string, records: readonly BurrowAclRecord[]) => void;
  readonly #requestApproval: (pending: PendingPairing) => void;
  readonly #dismissApproval: (clientId: string) => void;
  readonly #onInvitationChanged: NonNullable<BurrowOptions['onInvitationChanged']>;
  readonly #now: () => number;
  readonly #setTimer: RemoteTimer;
  readonly #reconnect: boolean;

  /**
   * Per-client lifecycle state keyed by clientId. Folding the three concerns
   * (pending pairing, pending connection, established session) into one record
   * makes teardown a single `delete` — no handler can leave the collections out
   * of sync.
   */
  readonly #clients = new Map<string, ClientState>();

  /**
   * The invitations this Burrow has minted and not yet spent, `inviteId → entry`.
   *
   * **The one-use responder key lives only here.** It never reaches the Relay,
   * the webview, or the state file: the QR carries its *public* half to a phone
   * camera and no further, and completing IK against it is what proves the
   * scanning phone is talking to the machine whose screen it photographed
   * (`docs/specs/remote-security-model.md` → Pairing).
   *
   * Kept on the Burrow rather than in the service that composes the QR so its
   * lifetime *is* this Burrow's: a new Burrow starts with none, and a Burrow that
   * reconnects keeps the codes still on screen. Capped at
   * {@link MAX_TOKENS_PER_BURROW}, the Relay's own bound on the setup tokens
   * these ride with, so the two sides agree on live-versus-spent.
   */
  readonly #invitations = new Map<string, HeldInvitation>();

  /**
   * This Burrow's long-term Noise identity, imported nonextractably from the
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

  /**
   * Bumped by every teardown ({@link BurrowRuntime.#dropTransientState}).
   *
   * The chain orders frames against each other, but teardown is **not** a
   * frame: `stop()` and the socket's own `close` run it synchronously, so it
   * can land before a queued step begins or in the middle of one's awaits. It
   * stays synchronous deliberately — the service clears its mirrored pairing
   * queue the instant `stop()` returns, and a deferred teardown would write to
   * that queue afterwards, possibly past a replacement Burrow — so
   * {@link BurrowRuntime.#enqueue} stamps each step with the epoch it was queued
   * under instead. Without it a handshake finishing after teardown reserves an
   * invitation that was just retired and allocates a client entry nothing will
   * ever remove: after `stop()` there is no later close to clean it up.
   */
  #epoch = 0;

  /**
   * The crypto token bucket, Burrow-global and driven by the injected clock
   * (`docs/specs/remote-security-model.md` → Burrow bounds).
   */
  readonly #initTokens: TokenBucket;

  /** `take()` answers `null` on success; neither call site wants the wait. */
  #spendInitToken(): boolean {
    return this.#initTokens.take() === null;
  }

  /** Cancels the armed reaper timer, or null when none is armed. */
  #cancelReaper: (() => void) | null = null;
  /** The instant the armed timer is for, so an unchanged deadline is not re-armed. */
  #reaperAt: number | null = null;

  #ws: WebSocketLike | null = null;
  #status: BurrowStatus = 'idle';
  #stopped = false;
  /** Latched by a {@link WS_CLOSE_BURROW_REPLACED} close; only `start()` clears it. */
  #displaced = false;
  #backoffMs = INITIAL_BACKOFF_MS;
  /** Cancels the armed reconnect, or null when none is armed. */
  #cancelReconnect: (() => void) | null = null;

  constructor(options: BurrowOptions) {
    this.#enrollment = options.enrollment;
    this.#policy = {
      rpId: options.enrollment.rpId,
      origin: options.enrollment.origin,
      // Mirrored from the Relay at enrollment. Both sides must demand the
      // same thing: the Burrow is the final authority, so a Relay enforcing UV
      // while the Burrow does not would leave the weaker verifier deciding.
      requireUserVerification: options.enrollment.requireUserVerification ?? false,
    };
    this.#now = options.now ?? (() => Date.now());
    this.#initTokens = new TokenBucket({
      capacity: E2E_INIT_BURST,
      refillIntervalMs: E2E_INIT_REFILL_INTERVAL_MS,
      now: this.#now,
    });
    this.#acl = loadBurrowAcl(options.enrollment.burrowId, options.loadAcl);
    this.#challenges = new ChallengeIssuer({ now: this.#now });

    this.#createWebSocket =
      options.createWebSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.#createSession = options.createSession;
    this.#saveAcl = options.saveAcl;
    this.#requestApproval = options.requestApproval;
    this.#dismissApproval = options.dismissApproval;
    this.#onInvitationChanged = options.onInvitationChanged ?? (() => {});
    this.#setTimer = options.setTimer ?? burrowTimer;
    this.#reconnect = options.reconnect ?? true;
  }

  get status(): BurrowStatus {
    return this.#status;
  }

  get burrowId(): string {
    return this.#enrollment.burrowId;
  }

  get activeRecords(): BurrowAclRecord[] {
    return this.#acl.activeRecords();
  }

  /**
   * Seal one push plaintext to one paired Client, or `null` when this Burrow has
   * no usable Noise static. The private key never leaves this class, which is
   * why the delivery path asks rather than borrowing it
   * (`docs/specs/remote-security-model.md` -> Push sealing).
   *
   * Answers `null` rather than throwing on a corrupt `clientStaticPublicKey`,
   * because the caller's job is to notify the phones it can and warn about the
   * rest.
   */
  async sealPushForClient(
    clientStaticPublicKey: string,
    plaintext: Uint8Array,
  ): Promise<SealedPushV1 | null> {
    const noiseStatic = await this.#loadNoiseStatic();
    if (!noiseStatic) return null;
    try {
      return await sealPush({
        burrowStaticPrivateKey: noiseStatic.privateKey,
        clientStaticPublicKey: fromBase64Url(clientStaticPublicKey),
        plaintext,
      });
    } catch (error) {
      console.warn('[burrow] could not seal a push for a paired client', error);
      return null;
    }
  }

  // --- Invitations ---------------------------------------------------------

  /**
   * Mint one invitation for a setup QR: an id, a one-use X25519 responder
   * keypair, and the expiry the code advertises.
   *
   * **One clock.** The Burrow's own `now` plus the shared pairing TTL bounds the
   * entry; `relayExpiresAtMs` is the Relay's opinion about its setup token,
   * and only the *earlier* of the two reaches the QR — an advisory value that
   * over-promised would send a phone into a handshake this Burrow will refuse.
   *
   * Prunes on insert, since nothing else sweeps this map, and evicts its own
   * oldest at the cap: the code longest on screen is the one whose scanner has
   * most likely given up.
   *
   * **Everything that decides what this Burrow holds runs after the keygen, on
   * one synchronous stretch.** `generateNoiseKeyPair` is the only await here,
   * and two mints overlapping across it would each evict against the same
   * pre-await size and then both insert — leaving `MAX_TOKENS_PER_BURROW + 1`
   * live invitations, which is the cap the Relay's own setup-token bound is
   * shared with. A teardown in that same window is the other half, and it is
   * guarded by the epoch {@link BurrowRuntime.#enqueue} uses rather than by
   * `#stopped`: invitations go with the socket, so a close — not only a
   * `stop()` — retires them, and inserting afterwards would re-arm the reaper
   * and return a QR the panel paints `live` over a relay socket that is gone.
   */
  async mintInvitation(setupToken: string, relayExpiresAtMs: number): Promise<PairingInvitation> {
    const epoch = this.#epoch;
    const keyPair = await generateNoiseKeyPair();
    // Worded for every teardown the epoch covers, not only `stop()`: a dropped
    // socket reaches here too, and on that one the panel is about to read
    // connected again. Prefixed like `#setupQr`'s other refusals, since this
    // string is what the person tapping *Show a code* is shown.
    if (this.#epoch !== epoch) {
      throw new Error(
        'could not mint a setup code: this machine’s connection to the Relay dropped. Try again.',
      );
    }
    this.#reap();
    const now = this.#now();
    while (this.#invitations.size >= MAX_TOKENS_PER_BURROW) {
      const oldest = this.#invitations.entries().next();
      if (oldest.done) break;
      // Unstated, so the entry's own state decides: eviction reaches the oldest
      // by insertion whatever it happens to be doing.
      this.#retireInvitation(oldest.value[0]);
    }
    const expiresAt = Math.min(now + DEFAULT_PAIRING_TTL_MS, relayExpiresAtMs);
    const inviteId = randomBase64Url(LOCAL_ID_BYTE_LENGTH);
    const invitation: PairingInvitation = {
      burrowId: this.#enrollment.burrowId,
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
    this.#armReaper();
    return invitation;
  }

  /**
   * What one invitation is doing. An id this Burrow has never held, or no longer
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

  /**
   * Unredeemed connection challenges. Exists for the same reason
   * {@link trackedClientCount} does: "a rejected handshake allocates nothing"
   * is not a property a test can check through the wire.
   */
  get pendingChallengeCount(): number {
    return this.#challenges.pendingCount;
  }

  // --- The reaper ----------------------------------------------------------

  /**
   * Every deadline this Burrow owns, as `{ at, expire }` over absolute
   * timestamps. One enumeration, so a fifth deadline is one edit and the
   * arithmetic behind an instant is written once
   * (`docs/specs/remote-security-model.md` → Burrow bounds).
   *
   * A snapshot, because `expire` runs injected callbacks — `dismissApproval`,
   * `api.dispose` — that may re-enter and mutate the maps being walked.
   *
   * **An expiry emits the applicable outcome only where a transport cipher
   * exists to encrypt one on**, and only where someone is still owed one: a
   * pending connection whose challenge is dead earns the `presence-rejected` a
   * late request would have, while an idle session's peer stopped waiting long
   * ago and hears nothing.
   *
   * **Clients before invitations**, because a pairing shares its invitation's
   * `expiresAt` and both fall in one sweep: the pairing's own deadline is the
   * only one that knows the ceremony timed out, and retiring its invitation
   * first would leave that outcome with nothing left to announce it on
   * ({@link BurrowRuntime.#retireInvitation} answers for an id it no longer holds
   * by doing nothing at all).
   */
  #deadlines(): Array<{ at: number; expire: () => void }> {
    const out: Array<{ at: number; expire: () => void }> = [];
    for (const [clientId, state] of this.#clients) {
      const { pairing, connection, established } = state;
      if (pairing) {
        out.push({
          at: pairing.expiresAt,
          expire: () => this.#finishPairing(clientId, 'invitation-expired'),
        });
      }
      if (connection) {
        out.push({
          at: connection.expiresAt,
          // Re-read, because this is a snapshot and `#denyConnection` — unlike
          // its three siblings here — takes the record rather than looking it
          // up: answering on a cipher the entry no longer holds would tear down
          // whatever replaced it.
          expire: () => {
            if (this.#clients.get(clientId)?.connection !== connection) return;
            this.#denyConnection(clientId, connection, 'presence-rejected');
          },
        });
      }
      if (established) {
        out.push({
          at: established.lastClientActivityAt + ESTABLISHED_E2E_IDLE_TIMEOUT_MS,
          expire: () => this.#disposeEstablished(clientId),
        });
      }
    }
    for (const [inviteId, held] of this.#invitations) {
      out.push({ at: held.expiresAt, expire: () => this.#retireInvitation(inviteId, 'expired') });
    }
    return out;
  }

  /**
   * **One reaper.** Every deadline is swept here and nowhere else, so a rule
   * added to a terminal outcome cannot be missing from the path that reclaims
   * one nobody answered. Runs on every `init`, every local decision, every
   * relay lifecycle event, and its own next-expiry timer, so a Burrow whose relay
   * socket never delivers another frame still reclaims everything it holds.
   */
  #reap(): void {
    const now = this.#now();
    for (const deadline of this.#deadlines()) {
      if (deadline.at <= now) deadline.expire();
    }
    this.#armReaper();
  }

  /**
   * Arm the reaper for the soonest deadline it does not already cover. A
   * deadline that moved *later* — a keepalive refreshing an idle session —
   * needs no re-arm: the armed timer fires early, reaps nothing, and arms
   * itself again on the way out.
   */
  #armReaper(): void {
    let deadline = Number.POSITIVE_INFINITY;
    for (const held of this.#deadlines()) deadline = Math.min(deadline, held.at);
    if (!Number.isFinite(deadline)) {
      this.#clearReaper();
      return;
    }
    if (this.#reaperAt !== null && deadline >= this.#reaperAt) return;
    this.#clearReaper();
    this.#reaperAt = deadline;
    this.#cancelReaper = this.#setTimer(() => {
      this.#cancelReaper = null;
      this.#reaperAt = null;
      this.#reap();
    }, Math.max(0, deadline - this.#now()));
  }

  #clearReaper(): void {
    this.#cancelReaper?.();
    this.#cancelReaper = null;
    this.#reaperAt = null;
  }

  /**
   * Drop an invitation and its key, announcing the state it ended in.
   *
   * **A `reserved` entry always ends `consumed`, whatever retired it**, and a
   * caller's `state` only labels one nobody scanned. `dropped` and `expired`
   * both mean *un-scanned* — the QR panel renders them in those words — so the
   * TTL sweep, which cannot tell the two apart, must not report a code a phone
   * completed message 1 against as one nobody touched
   * (`docs/specs/remote-security-model.md` → Pairing). With no `state` at all
   * the entry's own decides it, for a retirement that is not about a cause.
   *
   * `outcome` rides along for the ceremony that ended, so the panel learns the
   * code is spent and *how* in one change rather than in two it would have to
   * order for itself.
   */
  #retireInvitation(
    inviteId: string,
    state?: Exclude<InvitationState, 'live' | 'reserved'>,
    outcome?: PairingOutcome,
  ): void {
    const held = this.#invitations.get(inviteId);
    if (!held) return;
    this.#invitations.delete(inviteId);
    this.#onInvitationChanged(
      inviteId,
      held.state === 'reserved' ? 'consumed' : (state ?? 'dropped'),
      outcome,
    );
  }

  // --- Socket lifecycle ----------------------------------------------------

  /**
   * Open the relay socket. Also the one way back from `displaced`: an evicted
   * Burrow never reconnects on a timer, so returning is a deliberate act that
   * evicts whichever Burrow currently holds the burrowId. Idempotent while a socket
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
   * service refuses to start a Burrow whose halves disagree
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
        console.warn('[burrow] could not import the Noise static key', error);
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
    // A stopped Burrow leaves no timer behind to wake the process it runs in.
    this.#clearReaper();
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
    const wsBase = this.#enrollment.relayUrl.replace(/^http/, 'ws');
    const url = `${wsBase}${WS_ROUTES.burrow}?${WS_TOKEN_PARAM}=${encodeURIComponent(this.#enrollment.burrowToken)}`;
    const ws = this.#createWebSocket(url);
    this.#ws = ws;
    ws.addEventListener('open', () => {
      this.#status = 'connected';
      this.#backoffMs = INITIAL_BACKOFF_MS;
      this.#reap();
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
      // open a second one, and make this Burrow displace *itself*.
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
    if (code === WS_CLOSE_BURROW_REPLACED) {
      // Another Burrow claimed this burrowId and the relay evicted us on purpose
      // (relay/src/relay.ts `registerBurrow`). Reconnecting would evict that one,
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
    this.#cancelReconnect = this.#setTimer(() => {
      this.#cancelReconnect = null;
      this.#connect();
    }, delay);
  }

  #clearReconnectTimer(): void {
    this.#cancelReconnect?.();
    this.#cancelReconnect = null;
  }

  /**
   * Connection-scoped state resets on a dropped socket; the ACL persists, and
   * invitations go with the socket (`docs/specs/remote-security-model.md` →
   * Burrow bounds).
   */
  #dropTransientState(): void {
    // First, so a ceremony step already awaiting sees it the moment it resumes.
    this.#epoch += 1;
    for (const clientId of [...this.#clients.keys()]) this.#disposeClient(clientId);
    for (const inviteId of [...this.#invitations.keys()]) this.#retireInvitation(inviteId);
    this.#armReaper();
  }

  /**
   * How many clients this Burrow is tracking. Exists for the pending bounds'
   * tests: the growth they guard against is in a private map, and a bound
   * nothing can observe is how the first version of such a cap passed its own
   * test while the map kept growing.
   */
  get trackedClientCount(): number {
    return this.#clients.size;
  }

  /** Authorized sessions this Burrow is holding, for {@link MAX_ESTABLISHED_E2E_SESSIONS}' test. */
  get establishedSessionCount(): number {
    let count = 0;
    for (const state of this.#clients.values()) if (state.established) count += 1;
    return count;
  }

  #clientState(clientId: string): ClientState {
    let state = this.#clients.get(clientId);
    if (!state) {
      state = {};
      this.#clients.set(clientId, state);
    }
    return state;
  }

  #send(frame: BurrowFrame): void {
    try {
      this.#ws?.send(JSON.stringify(frame));
    } catch {
      // socket mid-close
    }
  }

  /** One `e2e` envelope. Every Burrow→Client byte in this file goes through here. */
  #sendE2e(
    clientId: string,
    kind: 'pairing' | 'connection',
    id: string,
    step: 'response' | 'transport',
    ciphertext: Uint8Array,
  ): void {
    this.#send({ t: 'e2e', clientId, kind, id, step, ct: toBase64Url(ciphertext) });
  }

  // --- Frame handling ------------------------------------------------------

  #onFrame(raw: unknown): void {
    // Measured before the parse, not after: every guard below reads a value
    // `JSON.parse` has already materialized, so without this a hostile relay
    // buys an unbounded string parse in the process that owns every PTY. The
    // socket's own `maxPayload` is the same number where the implementation
    // takes one (`vscode-ext/src/burrow.ts`); this is the bound that holds
    // on every implementation.
    if (typeof raw !== 'string' || raw.length > MAX_SERVER_TO_BURROW_FRAME_LENGTH) return;
    let frame: RelayToBurrowFrame;
    try {
      frame = JSON.parse(raw) as RelayToBurrowFrame;
    } catch {
      return;
    }
    if (!frame || typeof (frame as { t?: unknown }).t !== 'string') return;
    if (frame.t === 'client-gone') {
      // Bounded before it is used as a map key: the relay chooses it, and this
      // is the only frame that reaches the map without the `e2e` guard.
      if (!isBoundedString(frame.clientId, MAX_CLIENT_ID_LENGTH)) return;
      // Queued on the same chain as every `e2e` step, not run inline. A
      // ceremony step is several awaits long, and a teardown that ran *between*
      // them would find nothing to dispose and then watch the resumed step
      // reserve an invitation and allocate a client entry for a peer the relay
      // has already forgotten — one nothing would ever remove.
      this.#enqueue(() => {
        this.#onClientGone(frame.clientId);
      });
      return;
    }
    if (frame.t !== 'e2e') return;
    // The shape guard bounds every routing value — including `clientId`, before
    // the ciphertext scan — and this Burrow runs it rather than trusting the relay
    // to have (`docs/specs/relay.md` → Relay).
    if (!isE2eRelayToBurrowFrame(frame)) return;
    const e2e = frame;
    this.#enqueue((epoch) => this.#onE2e(e2e, epoch));
  }

  /**
   * Run `step` after everything already queued for this socket, in arrival
   * order. Every frame that touches the client map goes through here.
   *
   * The {@link BurrowRuntime.#epoch} is captured **here**, not when the step runs:
   * a step is queued on the microtask queue, so a `stop()` on the very next
   * line tears down before it has begun. A step whose epoch is already stale
   * never runs at all; one that goes stale mid-flight is handed its epoch so it
   * can refuse to mutate afterwards.
   */
  #enqueue(step: (epoch: number) => void | Promise<void>): void {
    const epoch = this.#epoch;
    this.#chain = this.#chain
      .then(() => (this.#epoch === epoch ? step(epoch) : undefined))
      .catch((error: unknown) => {
      // A ceremony step must never reject into the chain: this Burrow runs in
      // Node, where an unhandled rejection can take the sidecar or the extension
      // burrow down rather than merely logging in a webview.
        console.warn('[burrow] frame handling failed', error);
      });
  }

  async #onE2e(frame: E2eRelayToBurrowFrame, epoch: number): Promise<void> {
    // An `init` is the frame that allocates, so it is the one that reaps first.
    // A transport frame checks its own pending record's deadline, and the armed
    // timer covers everything else — sweeping the whole Burrow on every keystroke
    // from every phone would put two O(sessions) walks on the terminal path.
    if (frame.step === 'init') this.#reap();
    if (frame.kind === 'pairing') {
      if (frame.step === 'init') return await this.#onPairingInit(frame, epoch);
      return await this.#onPairingTransport(frame);
    }
    if (frame.step === 'init') return await this.#onConnectionInit(frame, epoch);
    return await this.#onConnectionTransport(frame);
  }

  // --- Pairing -------------------------------------------------------------

  /** Noise message 1 against one invitation's key; an unknown id costs a map lookup. */
  async #onPairingInit(frame: E2eRelayToBurrowFrame, epoch: number): Promise<void> {
    const held = this.#invitations.get(frame.id);
    if (!held || held.state !== 'live') return;
    // The last gate before any WebCrypto runs, so a flood that names live
    // invitations costs a map lookup each and nothing more.
    if (!this.#spendInitToken()) return;
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
      // Both handshake payloads are empty; anything else is a peer this Burrow
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
    // `held` must still be the entry this id names, on both counts. A teardown
    // retired it and dropped every client (the epoch), and `mintInvitation`
    // runs *off* this chain — the panel can reap it or evict it at the cap
    // while the WebCrypto above is in flight. Either way it is now a detached
    // object: writing `reserved` onto it would announce a state change for an
    // id already reported gone, and the entry below would name an invitation
    // no later dispose can retire.
    if (this.#epoch !== epoch || this.#invitations.get(frame.id) !== held) return;
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
      pairingId: randomBase64Url(LOCAL_ID_BYTE_LENGTH),
      session,
      handshakeHash,
      clientStaticPublicKey,
      requestedAt: now,
      expiresAt: held.expiresAt,
      attempted: false,
    };
    this.#armReaper();
    this.#sendE2e(frame.clientId, 'pairing', frame.id, 'response', message2);
  }

  /**
   * The first Client→Burrow transport payload of a pairing: a `PairingRequestV1`
   * carrying the two digits, the device label, and the presence proof. Anything
   * else is terminal (`docs/specs/remote-security-model.md` → Pairing).
   */
  async #onPairingTransport(frame: E2eRelayToBurrowFrame): Promise<void> {
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
      // The first invalid ciphertext destroys its session, and nothing can be
      // said over a poisoned one. The person at this machine is still owed the
      // fact that a ceremony ended without pairing anything, which is what
      // `burrow-error` says here.
      this.#disposePairing(frame.clientId, 'burrow-error');
      return;
    }
    if (receipt.kind === 'keepalive') return;
    // Already surfaced to the user: further traffic is noise until they answer.
    if (pending.approval) return;
    if (receipt.kind !== 'control' || !isPairingRequestV1(receipt.value)) {
      this.#finishPairing(frame.clientId, 'burrow-error');
      return;
    }
    const request = receipt.value;
    const binding: PresenceBinding = {
      kind: 'pairing',
      burrowId: this.#enrollment.burrowId,
      handshakeHash: pending.handshakeHash,
      passkeyCredentialId: request.presence.binding.passkeyCredentialId,
    };
    const proof = await verifyPresenceProof(request.presence, binding, this.#policy);
    // The client may have gone, or been superseded, while WebCrypto ran.
    if (this.#clients.get(frame.clientId)?.pairing !== pending) return;
    if (!proof.ok) {
      console.warn(`[burrow] pairing presence rejected: ${proof.reason}`);
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
   * The local confirmation — the ONLY path that writes the ACL, and **exactly
   * one attempt** (`docs/specs/remote-security-model.md` → Pairing). The
   * attempt is spent *before* the comparison, so no throw can leave a retry
   * behind.
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
    const burrowStaticPublicKey = this.#enrollment.noiseStaticPublicKey;
    if (burrowStaticPublicKey === undefined) {
      // There is nothing for the Client to pin. Writing a record here would
      // authorize a Client whose very next connection cannot complete IK
      // against a static this Burrow does not have — a pairing into a dead end,
      // reported as success. The service refuses to start such a Burrow
      // (`lib/src/host/remote/service.ts`), so this is the belt to that brace.
      console.warn('[burrow] refusing to pair: this Burrow has no Noise static to present');
      this.#finishPairing(clientId, 'burrow-error');
      return;
    }
    if (!constantTimeEqual(utf8Encode(code), utf8Encode(pending.approval.code))) {
      this.#finishPairing(clientId, 'confirmation-mismatch');
      return;
    }
    const deliveryId = randomBase64Url(DELIVERY_ID_BYTE_LENGTH);
    const record = this.#acl.approve({
      accountId: pending.approval.accountId,
      passkeyCredentialId: pending.approval.passkeyCredentialId,
      passkeyPublicKeyHash: pending.approval.passkeyPublicKeyHash,
      clientStaticPublicKey: pending.clientStaticPublicKey,
      deliveryId,
      approvedBy: 'burrow-user',
      label: pending.approval.label,
    });
    this.#saveAcl(this.#enrollment.burrowId, this.#acl.records());
    this.#sendPairingOutcome(clientId, pending, {
      ok: true,
      burrowStaticPublicKey,
      burrowLabel: boundedBurrowLabel(this.#enrollment.label),
      accountId: record.accountId,
      passkeyCredentialId: record.passkeyCredentialId,
      passkeyPublicKeyHash: record.passkeyPublicKeyHash,
      deliveryId,
    });
    this.#disposePairing(clientId, 'paired');
    this.#reap();
  }

  #denyPairing(clientId: string, pairingId: string): void {
    const pending = this.#clients.get(clientId)?.pairing;
    if (!pending || pending.pairingId !== pairingId) return;
    this.#finishPairing(clientId, 'user-denied');
    this.#reap();
  }

  /** Send one denial and end the pairing; every terminal outcome runs through here. */
  #finishPairing(clientId: string, code: PairingDenialCode): void {
    const pending = this.#clients.get(clientId)?.pairing;
    if (!pending) return;
    this.#sendPairingOutcome(clientId, pending, { ok: false, code });
    this.#disposePairing(clientId, PAIRING_OUTCOME_FOR_DENIAL[code]);
  }

  #sendPairingOutcome(
    clientId: string,
    pending: PendingPairingSession,
    outcome: PairingOutcomeV1,
  ): void {
    this.#sendControl(clientId, 'pairing', pending.inviteId, pending.session, outcome);
  }

  /**
   * Erase a pairing's handshake material and spend its invitation — both, on
   * every terminal outcome (`docs/specs/remote-security-model.md` → Pairing).
   *
   * **`outcome` is what a decision ended it**, and its absence is not a
   * default: a teardown decides nothing ({@link PairingOutcome}), and reporting
   * one there would put a sentence about a pairing under a panel whose machine
   * is busy reconnecting.
   */
  #disposePairing(clientId: string, outcome?: PairingOutcome): void {
    const state = this.#clients.get(clientId);
    const pending = state?.pairing;
    if (!state || !pending) return;
    state.pairing = undefined;
    // Always `consumed`: reaching here means a phone completed message 1
    // against this invitation, whatever ended the ceremony afterwards.
    this.#retireInvitation(pending.inviteId, 'consumed', outcome);
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
    this.#evictOldestIfFull(
      (state) => state.pairing?.requestedAt,
      MAX_PENDING_PAIRINGS,
      // Answered, because a person may be looking at the modal it removes.
      (clientId) => this.#finishPairing(clientId, 'superseded'),
    );
  }

  // --- Connection ----------------------------------------------------------

  /**
   * Noise message 1 against this Burrow's long-term static; message 2's payload is
   * the fresh challenge the proof must bind to
   * (`docs/specs/remote-security-model.md` → Connection).
   */
  async #onConnectionInit(frame: E2eRelayToBurrowFrame, epoch: number): Promise<void> {
    // Before the await, so a refused frame cannot even reach the one-time
    // import behind it: a bucket that gated only the responder would still let
    // a flood decide when this Burrow does WebCrypto.
    if (!this.#spendInitToken()) return;
    const staticKeyPair = await this.#loadNoiseStatic();
    if (!staticKeyPair) return;
    let session: NoiseTransportSession;
    let message2: Uint8Array;
    let clientStaticPublicKey: string;
    let challenge: string;
    let expiresAt: number;
    try {
      const handshake = await createNoiseResponder({
        prologue: e2eConnectionPrologue(this.#enrollment.burrowId, frame.id),
        staticKeyPair,
      });
      const payload = await handshake.readMessage(fromBase64Url(frame.ct));
      if (payload.length !== 0) throw new NoiseError('connection message 1 carries a payload');
      // Issued only once message 1 has decrypted: minting one per *attempted*
      // `init` would let a relay grow the issuer with frames that never
      // authenticated at all.
      ({ challenge, expiresAt } = this.#challenges.issue());
      message2 = await handshake.writeMessage(fromBase64Url(challenge));
      const remoteStatic = handshake.remoteStaticPublicKey;
      if (!remoteStatic) throw new NoiseError('IK did not authenticate a Client static');
      clientStaticPublicKey = toBase64Url(remoteStatic);
      session = new NoiseTransportSession(handshake.session);
    } catch {
      // Nothing to answer on: there is no session yet.
      return;
    }
    // A teardown during the handshake drops the entry this would create, and
    // the challenge it minted expires on its own TTL (see `#onPairingInit`).
    if (this.#epoch !== epoch) return;
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
      burrowChallenge: challenge,
      expiresAt,
    };
    this.#armReaper();
    this.#sendE2e(frame.clientId, 'connection', frame.id, 'response', message2);
  }

  /**
   * Transport on a connection: the authorization control while one is pending,
   * then protocol-v1 application messages once it is established.
   */
  async #onConnectionTransport(frame: E2eRelayToBurrowFrame): Promise<void> {
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
    const challengeValid = this.#challenges.consume(pending.burrowChallenge);
    const binding: PresenceBinding = {
      kind: 'connection',
      burrowId: this.#enrollment.burrowId,
      connectionId: pending.connectionId,
      burrowChallenge: pending.burrowChallenge,
      handshakeHash: pending.handshakeHash,
      passkeyCredentialId: request.presence.binding.passkeyCredentialId,
    };
    const proof = await verifyPresenceProof(request.presence, binding, this.#policy);
    if (this.#clients.get(frame.clientId)?.connection !== pending) return;
    if (!challengeValid || !proof.ok) {
      const why = challengeValid && !proof.ok ? proof.reason : 'challenge-invalid';
      console.warn(`[burrow] connection presence rejected: ${why}`);
      this.#denyConnection(frame.clientId, pending, 'presence-rejected');
      return;
    }
    const miss = this.#aclMiss(
      binding.passkeyCredentialId,
      pending.clientStaticPublicKey,
      request.presence.accountId,
      proof.passkeyPublicKeyHash,
    );
    if (miss !== null) {
      console.warn(`[burrow] connection refused: ${miss}`);
      this.#denyConnection(frame.clientId, pending, 'pairing-required');
      return;
    }
    this.#promoteConnection(frame.clientId, pending);
  }

  /**
   * Why the ACL refuses this connection, or `null` if it authorizes it.
   *
   * **One record must hold all four identities.** The reason is for the
   * owner-local log only — every miss answers `pairing-required`
   * (`docs/specs/remote-security-model.md` → Connection).
   */
  #aclMiss(
    passkeyCredentialId: string,
    clientStaticPublicKey: string,
    accountId: string,
    passkeyPublicKeyHash: string,
  ): string | null {
    const authorization = this.#acl.authorize({ passkeyCredentialId, clientStaticPublicKey });
    const record = authorization.record;
    if (record === null) return authorization.reasons.join(',');
    if (record.accountId !== accountId) return 'account-mismatch';
    if (record.passkeyPublicKeyHash !== passkeyPublicKeyHash) return 'passkey-key-mismatch';
    return null;
  }

  /**
   * Success: answer, then hand the session's byte stream to protocol-v1.
   *
   * **{@link MAX_ESTABLISHED_E2E_SESSIONS} is checked here and only here**, and
   * a Client static replaces its own session rather than counting against it
   * (`docs/specs/remote-security-model.md` → Burrow bounds). This is the first
   * point at which the presence proof and the ACL conjunction have both
   * succeeded, so the only thing that can fill the cap is authorized phones.
   */
  #promoteConnection(clientId: string, pending: PendingConnectionSession): void {
    const { incumbent, others } = this.#establishedFor(
      pending.clientStaticPublicKey,
      clientId,
    );
    if (incumbent === null && others >= MAX_ESTABLISHED_E2E_SESSIONS) {
      this.#denyConnection(clientId, pending, 'burrow-busy');
      return;
    }
    const state = this.#clientState(clientId);
    state.connection = undefined;
    // The same static under a different relay-chosen key: its predecessor goes
    // before the replacement is promoted, so the cap is never briefly exceeded.
    if (incumbent !== null && incumbent !== clientId) this.#disposeEstablished(incumbent);
    // Cleared with the dispose, not merely overwritten below: without a session
    // factory there is no replacement, and a leftover reference would route the
    // next frame on the old id into a handler that has already been disposed.
    state.established?.api.dispose();
    state.established = undefined;
    this.#sendControl(clientId, 'connection', pending.connectionId, pending.session, {
      ok: true,
      burrowLabel: boundedBurrowLabel(this.#enrollment.label),
    } satisfies ConnectionOutcomeV1);
    if (!this.#createSession) {
      // No remote-api behind this Burrow: the outcome is the whole answer, and
      // the entry holds nothing, so it must not stay under a relay-chosen key.
      this.#pruneClient(clientId);
      return;
    }
    // Destructured, so the `send` closure retains only what an established
    // session is — the id and the two cipher states — and not the pending
    // record, whose handshake hash, Client static and challenge are spent.
    const { connectionId, session, clientStaticPublicKey } = pending;
    const api = this.#createSession({
      burrowId: this.#enrollment.burrowId,
      send: (payload) => {
        this.#sendApp(clientId, connectionId, session, payload);
      },
    });
    state.established = {
      connectionId,
      session,
      api,
      clientStaticPublicKey,
      lastClientActivityAt: this.#now(),
    };
    this.#armReaper();
  }

  /**
   * One walk answering both questions a promotion asks: which client entry
   * already holds a session for `staticKey`, and how many sessions other than
   * `exceptClientId`'s exist. `others` is what the cap is compared against,
   * because a promotion always replaces whatever its own entry held.
   */
  #establishedFor(
    staticKey: string,
    exceptClientId: string,
  ): { incumbent: string | null; others: number } {
    let incumbent: string | null = null;
    let others = 0;
    for (const [id, state] of this.#clients) {
      if (!state.established) continue;
      if (state.established.clientStaticPublicKey === staticKey) incumbent = id;
      if (id !== exceptClientId) others += 1;
    }
    return { incumbent, others };
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
    // **A challenge dies with the record that named it**, on every path that
    // drops one — a replacement `init`, a cap eviction, a denial, the reaper,
    // `client-gone`. Without this the issuer's own lazy sweep is the only thing
    // that reclaims an abandoned challenge, which is the second reclaim policy
    // the reaper exists to remove. Already-consumed is a no-op.
    this.#challenges.consume(state.connection.burrowChallenge);
    state.connection = undefined;
    this.#pruneClient(clientId);
  }

  #evictOldestConnectionIfFull(): void {
    this.#evictOldestIfFull(
      (state) => state.connection?.expiresAt,
      MAX_PENDING_CONNECTION_HANDSHAKES,
      // No outcome: the evicted peer never authenticated, and answering it would
      // let a flood of `init` frames buy a reply each.
      (clientId) => this.#disposeConnection(clientId),
    );
  }

  /**
   * Keep one kind of pending work under `cap` by evicting its oldest.
   *
   * One scan per eviction, repeated until under the cap: the callers each add
   * at most one entry, so this normally evicts once — the loop is what makes a
   * cap true rather than nearly true.
   */
  #evictOldestIfFull(
    age: (state: ClientState) => number | undefined,
    cap: number,
    evict: (clientId: string) => void,
  ): void {
    for (;;) {
      let pendingCount = 0;
      let oldestId: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, state] of this.#clients) {
        const at = age(state);
        if (at === undefined) continue;
        pendingCount++;
        if (at < oldestAt) {
          oldestAt = at;
          oldestId = id;
        }
      }
      if (pendingCount < cap || oldestId === null) return;
      evict(oldestId);
    }
  }

  /** One transport frame on an authorized session: protocol-v1, or a keepalive. */
  #onEstablishedFrame(clientId: string, established: EstablishedSession, ct: string): void {
    let receipt;
    try {
      receipt = established.session.receive(fromBase64Url(ct));
    } catch {
      // A failed decrypt is not activity: it proves only that *something*
      // reached the relay, and the session is dead either way.
      this.#disposeEstablished(clientId);
      return;
    }
    // The one thing that refreshes the idle deadline, keepalive or application
    // data alike (`docs/specs/remote-security-model.md` → Burrow bounds).
    established.lastClientActivityAt = this.#now();
    if (receipt.kind !== 'app') return;
    for (const message of receipt.messages) {
      let payload: unknown;
      try {
        payload = JSON.parse(utf8Decode(message));
      } catch {
        // Authenticated, so it came from the paired Client — but a peer sending
        // non-JSON on the application stream is not one this Burrow can talk to,
        // and parsing failures must not reject into the frame chain.
        console.warn('[burrow] discarding a non-JSON application message');
        continue;
      }
      established.api.handle(payload);
      // `handle` can send, and a send on a poisoned cipher disposes this
      // session from inside this loop. Handing the rest of the receipt to an
      // api that is already disposed would leave whatever it allocates with no
      // owner left to tear it down.
      if (this.#clients.get(clientId)?.established !== established) return;
    }
  }

  #sendApp(
    clientId: string,
    connectionId: string,
    session: NoiseTransportSession,
    payload: unknown,
  ): void {
    try {
      for (const ciphertext of session.sendApp(utf8Encode(JSON.stringify(payload)))) {
        this.#sendE2e(clientId, 'connection', connectionId, 'transport', ciphertext);
      }
    } catch {
      // **Only a poisoned session is burrow loss.** An over-cap message is
      // refused before the first `encryptWithAd`, so no ciphertext exists and
      // no counter moved; disposing there would turn a caller's size error into
      // a re-handshake, re-entrantly from inside `#onEstablishedFrame`'s loop.
      if (!session.isPoisoned) {
        console.warn('[burrow] discarding an application message the transport refused');
        return;
      }
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
   * One control message on a ceremony session; the transport pads every one to
   * the same size (`docs/specs/relay.md` → E2E framing).
   */
  #sendControl(
    clientId: string,
    kind: 'pairing' | 'connection',
    id: string,
    session: NoiseTransportSession,
    value: PairingOutcomeV1 | ConnectionOutcomeV1,
  ): void {
    let ciphertext: Uint8Array;
    try {
      ciphertext = session.sendControl({ ...value });
    } catch {
      // A poisoned session has nothing to say; the caller disposes it anyway.
      return;
    }
    this.#sendE2e(clientId, kind, id, 'transport', ciphertext);
  }

  /** Forget a client that holds nothing, so a relay-chosen key cannot accumulate. */
  #pruneClient(clientId: string): void {
    const state = this.#clients.get(clientId);
    if (state && !state.pairing && !state.connection && !state.established) {
      this.#clients.delete(clientId);
    }
  }

  /**
   * Everything one client holds, torn down through the same three paths a
   * terminal outcome uses — never re-implemented here, so a rule added to one
   * of them cannot be missing from the socket-loss path.
   */
  #disposeClient(clientId: string): void {
    if (!this.#clients.has(clientId)) return;
    this.#disposePairing(clientId);
    this.#disposeConnection(clientId);
    this.#disposeEstablished(clientId);
    this.#clients.delete(clientId);
  }

  #onClientGone(clientId: string): void {
    this.#disposeClient(clientId);
    this.#reap();
  }
}

/** The `code` of a `CloseEvent`, or undefined if the socket gave us none. */
function closeCode(ev: unknown): number | undefined {
  const code = (ev as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}
