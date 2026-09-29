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
import type { DirectPeerFactory } from '../direct/direct-peer';
import type { RemoteTimer } from '../ws';

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

/** The remote-api handler an established session drives. */
export interface RemoteApiSessionLike {
  handle(data: unknown): void;
  dispose(): void;
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
   * How this host builds a peer connection for the direct path, or `null` where
   * it has none — then every `direct-offer` is declined and the session stays
   * relayed.
   */
  readonly createDirectPeer: DirectPeerFactory | null;
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
   * Present only where the owner requires application data to arrive on the
   * direct path alone: an application message decrypted off the relay is then
   * **never handed to the remote-api handler**, and this is called instead, for
   * the owner to end the session. Like {@link onFatal}, never called once this
   * session is disposed. Absent, the relay carries protocol-v1 like the channel.
   */
  onRelayedApp?(): void;
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
   * authorization nor outlive it.
   */
  readonly #direct: DirectEndpoint;
  readonly #sendRelay: (ciphertext: Uint8Array) => void;
  readonly #onFatal: (reason: string) => void;
  readonly #onRelayedApp: (() => void) | null;
  readonly #now: () => number;
  #lastClientActivityAt: number;
  #disposed = false;

  constructor(deps: EstablishedE2eSessionDeps) {
    this.#session = deps.session;
    this.#sendRelay = deps.sendRelay;
    this.#onFatal = deps.onFatal;
    this.#onRelayedApp = deps.onRelayedApp ?? null;
    this.#now = deps.now;
    this.#api = deps.createApi((payload) => this.#sendApp(payload));
    this.#direct = new DirectEndpoint('answerer', {
      createPeer: deps.createDirectPeer,
      sendSignal: (signal) => this.#sendSignal(signal),
      sendRelay: this.#sendRelay,
      receive: (ciphertext, carrier) => this.#receive(ciphertext, carrier),
      fatal: (reason) => {
        console.warn(`[burrow] the direct path ended this session: ${reason}`);
        this.#fatal(reason);
      },
      // **Disposal is this session's one test for being over.** Its owner
      // disposes it on every route that replaces or tears one down, so a
      // session that is not disposed is the live one.
      isCurrent: () => !this.#disposed,
      onTransportChanged: deps.onTransportChanged,
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
   * One transport frame's `ct` off the relay. Every rule about a frame on an
   * authorized session — which path may carry it, and that its `ct` must
   * decode — is the endpoint's (`docs/specs/remote-api.md` → Transport →
   * "Direct path").
   */
  onRelayFrame(ct: string): void {
    this.#direct.onRelayFrame(ct);
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
    // Any stream chunk counts, a partial one included: an owner that requires
    // the direct path wants no application byte on the relay at all.
    if (receipt.kind === 'app' && carrier === 'relay' && this.#onRelayedApp) {
      this.#onRelayedApp();
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
