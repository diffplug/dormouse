/**
 * One authorized session's direct path, as both ends run it
 * (`docs/specs/remote-api.md` -> Transport -> "Direct path").
 *
 * **One policy, two ends.** The Client and the Burrow differ in exactly four
 * things — who offers, how a control message is put on the relay, how a
 * ciphertext is decrypted, and what "the session is over" does — so those are
 * injected ({@link DirectEndpointDeps}) and everything else is here: the
 * attempt, the peer, the cutover, and every rule about what a channel event
 * means. Two copies of that were two chances to disagree about a switch.
 *
 * One per authorized session, created at promotion and disposed with it, so a
 * peer connection can neither precede authorization nor outlive it.
 */

import {
  DIRECT_HANDOFF_TIMEOUT_MS,
  DirectCutover,
  fromBase64Url,
  isDirectSignalV1,
  type DirectPath,
  type DirectRelayCause,
  type DirectSignalV1,
  type TransportReceipt,
} from 'remote-lib-common';

import { DirectPeer, type DirectPeerFactory } from './direct-peer';
import { realTimer, type RemoteTimer } from '../ws';

/**
 * Which half of the negotiation this end plays. The Client offers and the
 * Burrow answers, and each ignores the signals that are the other's to send.
 */
export type DirectRole = 'offerer' | 'answerer';

export interface DirectEndpointDeps {
  /** How this runtime builds a peer connection, or `null` where it has none. */
  readonly createPeer: DirectPeerFactory | null;
  /**
   * Encrypt one signal as a control message and put it on the relay path;
   * `false` if the session could not send it.
   */
  sendSignal(signal: DirectSignalV1): boolean;
  /**
   * Decrypt one transport ciphertext, whichever path carried it, process
   * everything that is not a signal, and answer the receipt. `null` where the
   * decrypt failed — a poisoned session, which the owner has already disposed.
   *
   * A signal is left in the receipt rather than dispatched by the owner: the
   * endpoint is the only thing that knows what one means.
   */
  receive(ciphertext: Uint8Array): TransportReceipt | null;
  /**
   * The session is unrecoverable: the endpoint's owner disposes it (the Burrow
   * through `#disposeEstablished`, the Client through `#loseBurrow`).
   */
  fatal(reason: string): void;
  /**
   * Whether this endpoint's session is still the live one. Both ends re-check
   * it after every await, because a promotion or a teardown can replace the
   * session while a description is being built.
   */
  isCurrent(): boolean;
  /**
   * Notified whenever {@link DirectEndpoint.path} or {@link
   * DirectEndpoint.relayCause} changes; the Client's indicator.
   */
  onTransportChanged?(path: DirectPath, cause: DirectRelayCause | null): void;
  /** Every deadline the peer arms; see {@link RemoteTimer}. */
  readonly setTimer?: RemoteTimer;
}

export class DirectEndpoint {
  readonly #role: DirectRole;
  readonly #deps: DirectEndpointDeps;
  readonly #cutover = new DirectCutover();
  readonly #setTimer: RemoteTimer;
  #peer: DirectPeer | null = null;
  #disposed = false;
  #cause: DirectRelayCause | null = null;
  /** Whether an offer has been taken up and not yet answered or declined. */
  #owesAnswer = false;
  /** Cancels the wait for the peer's switch; see {@link #settle}. */
  #cancelHandoff: (() => void) | null = null;
  /** The last pair announced, so an unchanged one is not announced twice. */
  #announced: { path: DirectPath; cause: DirectRelayCause | null } = { path: 'relay', cause: null };

  constructor(role: DirectRole, deps: DirectEndpointDeps) {
    this.#role = role;
    this.#deps = deps;
    this.#setTimer = deps.setTimer ?? realTimer;
  }

  /** What carries this session; `direct` only once **both** directions have switched. */
  get path(): DirectPath {
    return this.#disposed ? 'relay' : this.#cutover.path;
  }

  /**
   * Why the session is still relayed, or `null` where there is nothing to say.
   * Set by every route that gives an attempt up, so a session that stayed
   * relayed can say which of the three {@link DirectRelayCause}s it was.
   */
  get relayCause(): DirectRelayCause | null {
    return this.#cause;
  }

  /**
   * Offer a direct path, which is the offerer's alone to do: **once per session,
   * never retried**. The whole description travels inside the session, so the
   * Relay never sees an SDP, a candidate, or that a direct path exists.
   *
   * Every failure is silent and terminal for the attempt alone — no factory, a
   * description too large to fit one control message, a negotiation that threw —
   * and the session keeps running on the relay.
   */
  async offer(): Promise<void> {
    if (this.#role !== 'offerer' || !this.#cutover.begin()) return;
    const peer = this.#build();
    if (!peer) {
      this.#giveUp('this runtime builds no peer connection', 'unsupported');
      return;
    }
    const sdp = await peer.offer();
    if (!this.#stillOurs(peer)) return;
    if (sdp === null || !this.#deps.sendSignal({ v: 1, t: 'direct-offer', sdp })) this.#giveUp();
  }

  /**
   * One decrypted control message on this session. **An unknown control shape is
   * ignored, never a session failure**, which is what lets a peer without this
   * stack simply stay relayed — as is a signal that is the other role's to send.
   */
  onSignal(value: Record<string, unknown>): void {
    if (!isDirectSignalV1(value) || !this.#alive()) return;
    switch (value.t) {
      case 'direct-offer':
        if (this.#role === 'answerer') void this.#answer(value.sdp);
        return;
      case 'direct-answer':
        if (this.#role === 'offerer') void this.#peer?.acceptAnswer(value.sdp);
        return;
      case 'direct-decline':
        if (this.#role === 'offerer') this.#giveUp('the peer declined a direct path', 'declined');
        return;
      case 'direct-switch': {
        const outcome = this.#cutover.onSwitchDecrypted();
        if (outcome.kind === 'fatal') {
          this.#deps.fatal('the peer moved to a direct path this end had abandoned');
          return;
        }
        this.#settle();
        // In arrival order, through the same decrypt path the relay's frames
        // take: what was held is exactly what was sent after the switch.
        for (const frame of outcome.frames) {
          if (!this.#alive()) return;
          this.#deliver(frame);
        }
        return;
      }
    }
  }

  /**
   * One transport frame arriving on the relay, as the envelope carried it.
   * **Both ends read a relay frame through here**, so every rule about what may
   * arrive on which path is stated once.
   *
   * **After the peer has switched there is nothing left for it to send there**,
   * so a frame that arrives anyway is a peer whose two paths this end can no
   * longer keep in order. **A `ct` that will not decode ends the session too**:
   * the wire guard bounds the alphabet and the length, not the padding, so the
   * decode belongs inside the session's own failure path rather than thrown out
   * of a socket handler.
   */
  onRelayFrame(ct: string): void {
    if (!this.#alive()) return;
    if (this.#cutover.onRelayTransport() !== 'process') {
      this.#deps.fatal('a relay frame arrived after the direct switch');
      return;
    }
    let ciphertext: Uint8Array;
    try {
      ciphertext = fromBase64Url(ct);
    } catch {
      this.#deps.fatal('a relay frame was not a ciphertext');
      return;
    }
    this.#deliver(ciphertext);
  }

  /**
   * One transport ciphertext, `true` once it is consumed. The caller puts it on
   * the relay when this answers `false`, so "after the switch, nothing on the
   * relay" is one line rather than a rule each caller keeps.
   *
   * **A disposed endpoint consumes it too.** A refused send disposes the session
   * synchronously, and the caller's loop is mid-message: the remaining chunks
   * belong nowhere, least of all on the relay of a session that is over. The
   * callers stop on their own next check; this only keeps the interval between
   * the two from reaching the wire.
   */
  send(ciphertext: Uint8Array): boolean {
    if (this.#disposed) return true;
    if (this.#cutover.outbound !== 'direct') return false;
    // Switched, so the channel is the only path this may take — there is no
    // relay left to re-route onto. A peer that cannot carry it says why through
    // `onClosed`, and this end's rule about a channel lost after a switch does
    // the rest.
    this.#peer?.send(ciphertext);
    return true;
  }

  /**
   * Close the peer and release what the cutover held. Idempotent, and called on
   * every path that ends the session, so no peer connection outlives the session
   * that authorized it.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#peer?.close();
    this.#peer = null;
    this.#cutover.clear();
    this.#settle();
  }

  // --- Internals -------------------------------------------------------------

  /**
   * Answer one offer, or decline it. A runtime with no peer factory — or one
   * whose answer would not fit a signal — declines rather than leaving the
   * offerer waiting out the setup deadline.
   */
  async #answer(offerSdp: string): Promise<void> {
    if (!this.#cutover.begin()) return;
    this.#owesAnswer = true;
    const peer = this.#build();
    if (!peer) {
      this.#decline('this runtime builds no peer connection', 'unsupported');
      return;
    }
    const sdp = await peer.answer(offerSdp);
    if (!this.#stillOurs(peer)) return;
    if (sdp === null) {
      this.#decline('this end could not describe a direct connection');
      return;
    }
    this.#owesAnswer = false;
    if (!this.#deps.sendSignal({ v: 1, t: 'direct-answer', sdp })) this.#giveUp();
  }

  /**
   * Whether `peer` is still this endpoint's own live attempt. A promotion or a
   * teardown can replace the session while a description is being built, and a
   * peer left over from one is not this one's — it is closed here.
   */
  #stillOurs(peer: DirectPeer): boolean {
    if (this.#alive() && this.#peer === peer) return true;
    peer.close();
    return false;
  }

  /**
   * Give the attempt up and say so, rather than leaving the offerer to wait out
   * its setup deadline for a channel that is never coming.
   *
   * **Only where the attempt was merely abandoned.** A peer that put its own
   * `direct-switch` on the relay before this end had answered leaves
   * {@link #giveUp} taking its fatal branch instead — and a decline encrypted
   * onto a session its owner has just disposed would reach a Client that reads
   * it as a refusal rather than as the channel that never opened.
   */
  #decline(reason: string, cause: DirectRelayCause = 'failed'): void {
    this.#owesAnswer = false;
    if (this.#giveUp(reason, cause)) this.#deps.sendSignal({ v: 1, t: 'direct-decline' });
  }

  /** This attempt's peer, wired to the four channel events, or null if there is none. */
  #build(): DirectPeer | null {
    const factory = this.#deps.createPeer;
    if (!factory) return null;
    let connection;
    try {
      connection = factory();
    } catch (error) {
      console.warn('[direct] could not build a peer connection', error);
      return null;
    }
    if (!connection) return null;
    this.#peer = new DirectPeer({
      peer: connection,
      setTimer: this.#setTimer,
      handlers: {
        onOpen: () => this.#onOpen(),
        onFrame: (frame) => this.#onFrame(frame),
        onClosed: (reason) => this.#onClosed(reason),
        onViolation: (reason) => this.#onViolation(reason),
      },
    });
    return this.#peer;
  }

  /**
   * The channel is open. **The `direct-switch` is this end's last message on the
   * relay** — everything after it goes on the channel, which is what keeps order
   * per direction.
   */
  #onOpen(): void {
    if (!this.#alive()) return;
    if (!this.#deps.sendSignal({ v: 1, t: 'direct-switch' })) {
      this.#giveUp();
      return;
    }
    this.#cutover.switchOutbound();
    this.#cause = null;
    this.#settle();
  }

  /** One frame off the channel: processed, held until the peer's switch, or fatal. */
  #onFrame(frame: Uint8Array): void {
    if (!this.#alive()) return;
    switch (this.#cutover.onChannelFrame(frame)) {
      case 'process':
        this.#deliver(frame);
        return;
      case 'held':
        return;
      case 'overflow':
        this.#deps.fatal('the direct path outran what can be held in order');
        return;
    }
  }

  /**
   * One transport ciphertext into the session, whichever path carried it. **A
   * control message on an established session is one of this path's signals**,
   * and reading it here is what keeps the two ends' receive paths identical.
   */
  #deliver(ciphertext: Uint8Array): void {
    const receipt = this.#deps.receive(ciphertext);
    if (receipt?.kind === 'control') this.onSignal(receipt.value);
  }

  /**
   * The channel went away. **An answerer that has not answered yet owes the
   * offerer a decline**: the peer has heard nothing back and would otherwise
   * wait out its whole setup budget for a channel that is never coming. The
   * route matters because this can run *inside* `peer.answer()` — a channel
   * refused on adopt reports here before the description is even built — and
   * `#answer` then finds the peer already replaced and returns without a word.
   */
  #onClosed(reason: string): void {
    if (!this.#alive()) return;
    if (this.#owesAnswer) this.#decline(reason);
    else this.#giveUp(reason);
  }

  /**
   * A peer speaking something else on the channel is not one this session's
   * counters can stay synchronized with, switched or not — but only *this*
   * session's, so it is gated like every other channel event: a leftover
   * channel must never end the session that replaced it.
   */
  #onViolation(reason: string): void {
    if (!this.#alive()) return;
    this.#deps.fatal(reason);
  }

  /**
   * The attempt is over. **Before either direction has switched that is merely an
   * abandoned attempt** and the session carries on relayed; afterwards what was
   * riding the channel is gone and a stream cipher has no resynchronization
   * point, so the session is over.
   *
   * Answers whether the attempt was abandoned — `false` means the session went
   * with it, and the caller has nothing left to say on it.
   */
  #giveUp(reason = 'the direct path was abandoned', cause: DirectRelayCause = 'failed'): boolean {
    if (this.#cutover.switched) {
      this.#deps.fatal(reason);
      return false;
    }
    this.#peer?.close();
    this.#peer = null;
    this.#cutover.abandon();
    this.#cause = cause;
    this.#settle();
    return true;
  }

  /** Whether this endpoint still belongs to the session the caller is serving. */
  #alive(): boolean {
    return !this.#disposed && this.#deps.isCurrent();
  }

  /**
   * Reconcile the handoff deadline with the cutover, then announce.
   *
   * **The deadline is derived, never remembered.** It is armed exactly while
   * this end has switched and its peer has not — the one window in which this
   * end sends only on the channel while nothing can reach it back — so every
   * route that moves the cutover reconciles it by calling this, rather than by
   * remembering to arm or clear.
   *
   * Its expiry is burrow loss, since there is no relay left to fall back to.
   * Without it the wait would end only when the held frames overran their
   * bound, which is a function of how chatty the session happens to be rather
   * than of anything going wrong.
   */
  #settle(): void {
    const waiting =
      !this.#disposed && this.#cutover.outbound === 'direct' && this.#cutover.inbound === 'relay';
    if (waiting && !this.#cancelHandoff) {
      this.#cancelHandoff = this.#setTimer(() => {
        this.#cancelHandoff = null;
        if (!this.#alive()) return;
        this.#deps.fatal('the peer did not follow onto the direct path');
      }, DIRECT_HANDOFF_TIMEOUT_MS);
    } else if (!waiting && this.#cancelHandoff) {
      this.#cancelHandoff();
      this.#cancelHandoff = null;
    }
    const path = this.path;
    const cause = this.#cause;
    if (path === this.#announced.path && cause === this.#announced.cause) return;
    this.#announced = { path, cause };
    this.#deps.onTransportChanged?.(path, cause);
  }
}
