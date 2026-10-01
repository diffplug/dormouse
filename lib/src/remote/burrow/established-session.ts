/**
 * One authorized end-to-end session, as the Burrow serves it: the promoted Noise
 * transport, the remote-api handler it feeds, the direct path it may move onto,
 * and the idle clock the Burrow reaps it on
 * (`docs/specs/remote-security-model.md` → Burrow bounds;
 * `docs/specs/remote-api.md` → Transport).
 *
 * **Authorization is the owner's, and this module knows nothing of it** — no ACL,
 * no presence proof, no enrollment. It is built only once a session has been
 * authorized, takes ciphertext from the relay path and the channel, and hands
 * ciphertext back for the owner to route. The owner keeps whatever it keys the
 * session on, and disposes it on every path that ends one.
 */

import {
  DIRECT_ONLY_DEADLINE_MS,
  ESTABLISHED_E2E_IDLE_TIMEOUT_MS,
  type DirectPath,
  type DirectRelayCause,
  type DirectSignalV1,
  type NoiseTransportSession,
  type TransportReceipt,
  utf8Decode,
  utf8Encode,
} from 'remote-lib-common';

import { DirectEndpoint, type DirectCarrier } from '../direct/direct-endpoint';
import type { DirectPeering } from '../direct/direct-peer';
import { goodbyeFor, pathRefusal, type PathRefusal } from '../direct/path-refusal';
import type { RemoteTimer } from '../ws';

/**
 * The longest {@link EstablishedE2eSession.end} keeps a direct channel open for
 * the goodbye to leave it. Past it the channel closes regardless: a goodbye
 * still queued behind that much output is not worth holding a peer connection
 * for, and the Client learns of the ending from the close instead.
 */
export const SESSION_END_FLUSH_MS = 500;

/**
 * `value` as one control message on `session`, or `null` for a poisoned
 * session, which has nothing to say — whatever poisoned it disposes it, so the
 * caller need not. The transport pads every control message to the same size
 * (`docs/specs/relay.md` → E2E framing).
 */
export function sealControl(session: NoiseTransportSession, value: object): Uint8Array | null {
  try {
    return session.sendControl({ ...value });
  } catch {
    return null;
  }
}

/**
 * Why a direct-only session can no longer be carried
 * ({@link EstablishedE2eSessionDeps.onDirectOnlyBroken}): an application
 * message arrived over the relay, the path policy refused the path, the direct
 * attempt was given up, or — {@link EstablishedE2eSession.expireDirectOnly},
 * from the owner's reaper off {@link EstablishedE2eSession.directDeadlineAt} —
 * the deadline passed with the session not yet direct.
 */
export type DirectOnlyBreak = 'relayed-app' | 'path-refused' | 'given-up' | 'deadline';

/** The remote-api handler an established session drives. */
export interface RemoteApiSessionLike {
  handle(data: unknown): void;
  dispose(): void;
}

/**
 * What an owner hands the remote-api handler it builds for one authorized
 * session — the argument of both runtimes' `createSession`.
 */
export interface RemoteApiSessionContext {
  /** The Burrow id the hello reports: the enrollment's, or a one-time room's. */
  readonly burrowId: string;
  /** Put one remote-api message on this session. */
  readonly send: (payload: unknown) => void;
  /**
   * Who this session is to the person at the Burrow, as plain text: the ACL
   * record's label, bounded again with `boundedPairingLabel`, or a one-time
   * phone's member of `ONE_TIME_DEVICE_LABELS`.
   */
  readonly label: string;
  /**
   * End this session on purpose, the way its owner ends one: the Client hears
   * the goodbye ({@link EstablishedE2eSession.end}), then everything the
   * session holds goes. A no-op once the session is over.
   */
  readonly end: () => void;
}

export interface EstablishedE2eSessionDeps {
  /** The promoted transport: the two cipher states the handshake split into. */
  readonly session: NoiseTransportSession;
  /**
   * Build the remote-api handler this session drives, handed the one way it may
   * answer. Called once, from the constructor.
   */
  createApi(send: (payload: unknown) => void): RemoteApiSessionLike;
  /**
   * How this host takes the direct path: with no factory every `direct-offer`
   * is declined and the session stays relayed; a path policy's refusal
   * (`docs/specs/remote-network.md` -> "Local networks") breaks a direct-only
   * session, `path-refused`, and ends any other through {@link onFatal}.
   */
  readonly directPeering: DirectPeering;
  /**
   * Put one transport ciphertext on the relay path, in whatever envelope the
   * owner's socket carries. Every Burrow→Client byte this session sends before
   * the switch — protocol-v1 and the direct path's signals — goes through here.
   */
  sendRelay(ciphertext: Uint8Array): void;
  /**
   * The session is unrecoverable: the owner disposes it and drops its record.
   * **Never called once this session is disposed**, so a report can never end
   * whatever replaced it.
   */
  onFatal(reason: string): void;
  /**
   * Notified whenever the direct path's {@link DirectPath} or
   * {@link DirectRelayCause} changes — `direct` once **both** directions have
   * switched. For an owner whose lifecycle turns on the switch.
   */
  onTransportChanged?(path: DirectPath, cause: DirectRelayCause | null): void;
  /**
   * **The direct path or nothing**: the one-time runtime always, and a paired
   * Burrow exactly where its path policy is held
   * (`docs/specs/remote-network.md` -> "Local networks"). Such a session has
   * {@link EstablishedE2eSession.directDeadlineAt} to switch; an application
   * message decrypted off the relay is **never handed to the remote-api
   * handler**; and a given-up attempt leaves it nothing to stay on. Each is
   * reported through {@link onDirectOnlyBroken}. Absent, the relay carries
   * protocol-v1 like the channel.
   */
  readonly directOnly?: boolean;
  /**
   * A direct-only session can no longer be carried: the owner ends it, which
   * is what makes this the last report — with {@link EstablishedE2eSession.end},
   * whose goodbye carries {@link EstablishedE2eSession.pathRefusal}, where the
   * path ended it. Like {@link onFatal}, never called once this session is
   * disposed. A given-up attempt is reported a microtask later, so the decline
   * the endpoint sends right after giving up goes out first.
   */
  onDirectOnlyBroken?(reason: DirectOnlyBreak): void;
  /** The owner's clock, which the idle deadline is read against. */
  readonly now: () => number;
  /** Every deadline the direct path arms; see {@link RemoteTimer}. */
  readonly setTimer?: RemoteTimer;
}

export class EstablishedE2eSession {
  readonly #session: NoiseTransportSession;
  readonly #api: RemoteApiSessionLike;
  /**
   * This session's direct path, as the answerer runs it. Created with the
   * session and disposed with it, so a peer connection can neither precede
   * authorization nor outlive it — past the goodbye's bounded flush
   * ({@link end}).
   */
  readonly #direct: DirectEndpoint;
  readonly #sendRelay: (ciphertext: Uint8Array) => void;
  readonly #onFatal: EstablishedE2eSessionDeps['onFatal'];
  readonly #onDirectOnlyBroken: ((reason: DirectOnlyBreak) => void) | null;
  /** When a direct-only session must be direct by; `null` for one the relay may carry. */
  readonly #directOnlyBy: number | null;
  /** Whether a path policy holds this session's direct path. */
  readonly #pathHeld: boolean;
  /** Set where the path ended this session; see {@link pathRefusal}. */
  #pathRefusal: PathRefusal | null = null;
  readonly #now: () => number;
  #lastClientActivityAt: number;
  #disposed = false;

  constructor(deps: EstablishedE2eSessionDeps) {
    this.#session = deps.session;
    this.#sendRelay = deps.sendRelay;
    this.#onFatal = deps.onFatal;
    this.#now = deps.now;
    const directOnly = deps.directOnly === true;
    this.#onDirectOnlyBroken = directOnly ? (deps.onDirectOnlyBroken ?? null) : null;
    this.#directOnlyBy = directOnly ? this.#now() + DIRECT_ONLY_DEADLINE_MS : null;
    this.#pathHeld = deps.directPeering.pathPolicy !== undefined;
    this.#api = deps.createApi((payload) => this.#sendApp(payload));
    this.#direct = new DirectEndpoint('answerer', {
      peering: deps.directPeering,
      sendSignal: (signal) => this.#sendSignal(signal),
      sendRelay: this.#sendRelay,
      receive: (ciphertext, carrier) => this.#receive(ciphertext, carrier),
      fatal: (reason, cause) => {
        console.warn(`[burrow] the direct path ended this session: ${reason}`);
        if (cause === 'path-refused' && directOnly) this.#breakDirectOnly('path-refused');
        else this.#fatal(reason);
      },
      // **Disposal is this session's one test for being over.** Its owner
      // disposes it on every route that replaces or tears one down, so a
      // session that is not disposed is the live one.
      isCurrent: () => !this.#disposed,
      onTransportChanged: (path, cause) => {
        deps.onTransportChanged?.(path, cause);
        // A given-up attempt leaves only the relay, which may not carry a
        // direct-only session. Deferred, so the decline the endpoint sends
        // right after giving up reaches the Client before the owner's ending.
        if (directOnly && path === 'relay' && cause !== null) {
          queueMicrotask(() => this.#breakDirectOnly('given-up'));
        }
      },
      setTimer: deps.setTimer,
    });
    this.#lastClientActivityAt = this.#now();
  }

  /**
   * When the Burrow reaps this session: `ESTABLISHED_E2E_IDLE_TIMEOUT_MS` after
   * it last **decrypted** a Client→Burrow transport message here, on either
   * path — the idle deadline is path-agnostic.
   */
  get idleDeadlineAt(): number {
    return this.#lastClientActivityAt + ESTABLISHED_E2E_IDLE_TIMEOUT_MS;
  }

  /**
   * When a direct-only session must carry both directions on the direct path
   * by — `DIRECT_ONLY_DEADLINE_MS` from its promotion — for the owner's reaper
   * to end it with `'deadline'`. `null` for a session the relay may carry, and
   * once both directions have switched: the deadline is met for good.
   */
  get directDeadlineAt(): number | null {
    return this.#direct.path === 'direct' ? null : this.#directOnlyBy;
  }

  /**
   * Why the path ended this session, where it did
   * (`docs/specs/remote-network.md` -> "Local networks"), else `null`: set by a
   * break of a direct-only session a path policy holds — a refused path, or a
   * given-up attempt or a missed deadline once the phone offered one — before
   * the owner hears of it. It names the end refused, and that end's address
   * where there is one ({@link DirectEndpoint.refusedEnd}).
   */
  get pathRefusal(): PathRefusal | null {
    return this.#pathRefusal;
  }

  /**
   * The owner's reaper found {@link directDeadlineAt} passed: break the session
   * `deadline`, as every other break is, through
   * {@link EstablishedE2eSessionDeps.onDirectOnlyBroken}. A no-op once over.
   */
  expireDirectOnly(): void {
    if (this.directDeadlineAt === null) return;
    this.#breakDirectOnly('deadline');
  }

  /**
   * One transport frame's `ct` off the relay. Every rule about a frame on an
   * authorized session — which path may carry it, and that its `ct` must
   * decode — is the endpoint's (`docs/specs/remote-api.md` → Transport →
   * "Direct path").
   */
  onRelayFrame(ct: string): void {
    this.#direct.onRelayFrame(ct);
  }

  /**
   * End this session on purpose: tell the Client with the goodbye, on whichever
   * path it rides, and dispose. **Only for an ending the Burrow chose while the
   * cipher is healthy** — a poisoned session has nothing to say, and
   * {@link sealControl} answers nothing for one, so this degrades to the
   * dispose. Never a substitute for it: the session is over from this call.
   *
   * **Over at once, closed once the goodbye has left.** Nothing more is read
   * and the remote-api handler goes now, so no input lands after the ending;
   * but a channel closed in the same tick drops whatever it had not yet sent,
   * so the direct path closes only once the goodbye has left it, bounded by
   * {@link SESSION_END_FLUSH_MS}. The relay send is synchronous onto the
   * owner's socket, which the dispose leaves open.
   *
   * `flush: false` is for an owner that is stopping and must leave no timer
   * behind: the goodbye is sent best-effort and the channel closes at once.
   */
  end({ flush = true }: { flush?: boolean } = {}): void {
    if (this.#disposed) return;
    const goodbye = sealControl(this.#session, goodbyeFor(this.#pathRefusal));
    // Before the send: a channel that refuses the goodbye reports its close,
    // and a session that is already over has nothing left to report it to.
    this.#disposed = true;
    if (goodbye) this.#direct.send(goodbye);
    this.#api.dispose();
    if (goodbye && flush) this.#direct.disposeAfterFlush(SESSION_END_FLUSH_MS);
    else this.#direct.dispose();
  }

  /** Close the direct path, then the remote-api handler. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#direct.dispose();
    this.#api.dispose();
  }

  #fatal(reason: string): void {
    if (this.#disposed) return;
    this.#onFatal(reason);
  }

  /**
   * Report a break, recording the refusal first where the path is why: a
   * refused path always, and a given-up attempt or a missed deadline only once
   * the phone offered one — a phone that never tried says nothing about the
   * path.
   */
  #breakDirectOnly(reason: DirectOnlyBreak): void {
    if (this.#disposed) return;
    const forPath = reason === 'path-refused' || (reason !== 'relayed-app' && this.#direct.attempted);
    if (this.#pathHeld && forPath) {
      this.#pathRefusal = pathRefusal(this.#now(), reason as PathRefusal['kind'], this.#direct.refusedEnd);
    }
    this.#onDirectOnlyBroken?.(reason);
  }

  /**
   * Decrypt one transport ciphertext, whichever path carried it — protocol-v1,
   * a keepalive, or one of the direct path's signals — and answer the receipt
   * for the endpoint to read a signal out of.
   */
  #receive(ciphertext: Uint8Array, carrier: DirectCarrier): TransportReceipt | null {
    let receipt: TransportReceipt;
    try {
      receipt = this.#session.receive(ciphertext);
    } catch {
      // A failed decrypt is not activity: it proves only that *something*
      // reached this Burrow, and the session is dead either way.
      this.#fatal('a transport message failed to decrypt');
      return null;
    }
    // Any stream chunk counts, a partial one included: a direct-only session
    // takes no application byte off the relay at all.
    if (receipt.kind === 'app' && carrier === 'relay' && this.#directOnlyBy !== null) {
      this.#breakDirectOnly('relayed-app');
      return null;
    }
    // The one thing that refreshes the idle deadline, keepalive or application
    // data alike, and on either path
    // (`docs/specs/remote-security-model.md` → Burrow bounds).
    this.#lastClientActivityAt = this.#now();
    if (receipt.kind !== 'app') return receipt;
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
      this.#api.handle(payload);
      // `handle` can send, and a send on a poisoned cipher disposes this
      // session from inside this loop. Handing the rest of the receipt to an
      // api that is already disposed would leave whatever it allocates with no
      // owner left to tear it down.
      if (this.#disposed) return null;
    }
    return receipt;
  }

  /**
   * One protocol-v1 message on this session, chunked as it needs. **The
   * endpoint routes every chunk**, relay or channel, so which path carries them
   * is {@link DirectEndpoint.send}'s rule rather than this loop's.
   */
  #sendApp(payload: unknown): void {
    const session = this.#session;
    const direct = this.#direct;
    try {
      for (const ciphertext of session.sendApp(utf8Encode(JSON.stringify(payload)))) {
        // A channel that refuses a chunk disposes this session synchronously,
        // and so does the promotion that replaces it: the rest of the message
        // has no session left to belong to, and must reach neither path.
        if (direct.disposed) return;
        direct.send(ciphertext);
      }
    } catch {
      // **Only a poisoned session is burrow loss.** An over-cap message is
      // refused before the first `encryptWithAd`, so no ciphertext exists and
      // no counter moved; disposing there would turn a caller's size error into
      // a re-handshake, re-entrantly from inside `#receive`'s loop.
      if (!session.isPoisoned) {
        console.warn('[burrow] discarding an application message the transport refused');
        return;
      }
      this.#fatal('the transport refused a send');
    }
  }

  /**
   * One of the direct path's signals, as a control message on the relay path —
   * signals ride the relay until the switch. Answers `false` for a poisoned
   * session; see {@link sealControl}.
   */
  #sendSignal(signal: DirectSignalV1): boolean {
    const ciphertext = sealControl(this.#session, signal);
    if (!ciphertext) return false;
    this.#sendRelay(ciphertext);
    return true;
  }
}
