/**
 * The `RTCPeerConnection`-shaped seam both ends of the direct path share
 * (`docs/specs/remote-api.md` -> Transport -> "Direct path").
 *
 * **Structural, never the DOM globals.** The interfaces below are the subset of
 * the W3C API this stack calls, so the browser's `RTCPeerConnection`, the
 * sidecar's native polyfill, and the in-memory fake all satisfy the same shape
 * and neither endpoint reaches for a global. Constructing one is the injected
 * factory's job (`PocketClientDeps.createDirectPeer`, a Burrow runtime's
 * {@link DirectPeering}), which is also where the ICE servers are chosen
 * (`ice-servers.ts`) — nothing here knows what an ICE server is.
 *
 * The wrapper owns the two halves of one negotiation and the channel's four
 * events. It owns no policy: what a closed channel *means* depends on whether
 * the session has already switched, which is the endpoint's question.
 */

import {
  DIRECT_ANSWER_TIMEOUT_MS,
  DIRECT_BUFFER_HIGH,
  DIRECT_CHANNEL_LABEL,
  DIRECT_BUFFER_LOW,
  DIRECT_DISCONNECTED_GRACE_MS,
  DIRECT_GATHER_TIMEOUT_MS,
  DIRECT_SETUP_TIMEOUT_MS,
  DIRECT_SRFLX_GRACE_MS,
  DirectFrameQueue,
  MAX_DIRECT_PENDING_BYTES,
  MAX_DIRECT_PENDING_FRAMES,
  NOISE_MAX_MESSAGE_LENGTH,
  isDirectSdp,
  isIpLiteral,
  type PathAddressSource,
} from 'remote-lib-common';
import { realTimer, type RemoteTimer } from '../ws';

/**
 * How often a path policy re-reads an open channel's selected pair
 * (`docs/specs/remote-network.md` -> "Local networks"): `node-datachannel`'s
 * ICE agent moves a completed connection onto a newly nominated pair without
 * any event, so a state change alone would never see it.
 */
export const DIRECT_PATH_RECHECK_MS = 1_000;

/**
 * A server-reflexive candidate (RFC 8839 `typ srflx`), in an SDP line or an
 * `icecandidate` event's string: `candidate:…` in a browser, `a=candidate:…` in
 * `node-datachannel`'s polyfill.
 */
const SRFLX_CANDIDATE = / typ srflx\b/;

/** The four `RTCSdpType` values, so a real description assigns to ours. */
export type DirectSdpType = 'offer' | 'answer' | 'pranswer' | 'rollback';

/** As much of `RTCSessionDescriptionInit` as one negotiation needs. */
export interface DirectSessionDescription {
  readonly type: DirectSdpType;
  readonly sdp?: string;
}

/** The subset of `RTCDataChannel` a Noise transport rides on. */
export interface DirectChannelLike {
  binaryType: string;
  /** The four properties {@link DirectPeer} checks before it adopts a channel. */
  readonly label: string;
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime: number | null;
  /** What the implementation is still holding; see {@link DIRECT_BUFFER_HIGH}. */
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: ArrayBuffer | ArrayBufferView): void;
  close(): void;
  addEventListener(type: string, handler: (ev: unknown) => void): void;
}

/** One end of a candidate pair: as much of `RTCIceCandidate` as the path check reads. */
export interface DirectCandidateLike {
  readonly address: string | null;
}

/**
 * As much of `RTCSctpTransport` as the size and path checks need. The size is
 * the association's own limit, negotiated from both ends' `a=max-message-size`,
 * so it is knowable only once the channel is open — `node-datachannel`'s
 * polyfill exposes the transport from construction and leaves this null until
 * then, which is why it is nullable here even though the W3C type is not.
 */
export interface DirectSctpLike {
  readonly maxMessageSize: number | null;
  /**
   * `RTCDtlsTransport` → `RTCIceTransport`, whose selected pair a
   * {@link DirectPathPolicy} checks. Optional all the way down: only a
   * restricted Burrow reads it, and a peer that cannot say is refused there.
   */
  readonly transport?: {
    readonly iceTransport?: {
      getSelectedCandidatePair?(): DirectCandidatePairLike | null;
    };
  };
}

/** A selected candidate pair, as either read in {@link DirectPeerLike} reports it. */
export interface DirectCandidatePairLike {
  readonly local?: DirectCandidateLike;
  readonly remote?: DirectCandidateLike;
}

/** The subset of `RTCPeerConnection` one negotiation needs. */
export interface DirectPeerLike {
  createDataChannel(label: string, init?: { ordered?: boolean }): DirectChannelLike;
  createOffer(): Promise<DirectSessionDescription>;
  createAnswer(): Promise<DirectSessionDescription>;
  setLocalDescription(description: DirectSessionDescription): Promise<void>;
  setRemoteDescription(description: DirectSessionDescription): Promise<void>;
  readonly localDescription: DirectSessionDescription | null;
  readonly iceGatheringState: string;
  /** Null until the association exists; see {@link DirectSctpLike}. */
  readonly sctp: DirectSctpLike | null;
  readonly connectionState: string;
  /**
   * `node-datachannel`'s polyfill only: the native `PeerConnection`'s selected
   * pair, each end's `address` read straight from the ICE agent. Read in place
   * of the transport's, which rebuilds each end as an `RTCIceCandidate` whose
   * constructor throws on a candidate with no mid — a pair the agent may still
   * be sending on. A browser has none, and holds no path policy.
   */
  selectedCandidatePair?(): DirectCandidatePairLike | null;
  addEventListener(type: string, handler: (ev: unknown) => void): void;
  close(): void;
}

/**
 * How one endpoint constructs a peer, or answers that it has none. A Burrow's
 * endpoint hands it the attempt's {@link DirectPathPolicy}, if it has one, for
 * the socket it binds.
 */
export type DirectPeerFactory = (pathPolicy?: DirectPathPolicy) => DirectPeerLike | null;

/**
 * How one end takes the direct path, as one value: the factory that builds
 * each attempt's peer, `null` where this end has none, and what the Burrow's
 * network policy holds each attempt to, absent for no restriction. A Burrow
 * host chooses both from one policy (`docs/specs/remote-network.md` ->
 * "Anywhere"), and they reach the endpoint together.
 */
export interface DirectPeering {
  readonly createPeer: DirectPeerFactory | null;
  readonly pathPolicy?: DirectPathPolicy;
}

/** The selected candidate pair's two addresses, each `null` where unreported. */
export interface DirectSelectedPair {
  readonly local: string | null;
  readonly remote: string | null;
}

/**
 * The one address a path refusal can name, and where it came from
 * (`docs/specs/remote-network.md` -> "Local networks"): an IP literal, never a
 * name.
 */
export interface PathAddress {
  readonly address: string;
  readonly source: PathAddressSource;
}

/**
 * Which end of the selected pair a path policy refused: `local` this
 * machine's, `remote` the peer's.
 */
export type PathEnd = 'local' | 'remote';

/**
 * Why a path policy refused a selected pair, and which end it refused — `null`
 * where the stack reported no pair, which blames neither.
 */
export interface PathPolicyRefusal {
  readonly reason: string;
  readonly end: PathEnd | null;
}

/**
 * Which end of this attempt's path a refusal names, and the one address it
 * may name there (`docs/specs/remote-network.md` -> "Local networks"): the
 * peer's ({@link PathAddress}), or this machine's own on the refused pair.
 */
export type RefusedEnd =
  | { readonly end: 'remote'; readonly address: PathAddress | null }
  | { readonly end: 'local'; readonly address: string | null };

/**
 * `address` as a refusal names it — an IPv4-mapped IPv6 address as its IPv4
 * half — or `null` for anything that is not an IP literal.
 */
function shownAddress(address: string | null): string | null {
  const unmapped = address?.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '') ?? null;
  return isIpLiteral(unmapped) ? unmapped : null;
}

/** One end's address as a pair read reports it, or `null` where it gives no string. */
function addressOf(candidate: DirectCandidateLike | undefined): string | null {
  const address = candidate?.address;
  return typeof address === 'string' ? address : null;
}

/** A selected pair whose read threw: refused, never read as no pair. */
const UNREADABLE_PAIR = 'unreadable';

/**
 * What a Burrow whose network policy restricts the direct path holds one
 * attempt to (`docs/specs/remote-network.md` -> "Local networks"). Built
 * host-side, where the address math is; a peer without one is unrestricted.
 */
export interface DirectPathPolicy {
  /**
   * The one address this attempt's socket binds on this machine now, or `null`
   * to bind every interface. Read by the peer factory, once per attempt.
   */
  bindAddress(): string | null;
  /**
   * This end's description as it may be sent, every candidate outside the
   * allowed networks removed — or `null` where none is left, which refuses the
   * attempt.
   */
  describe(sdp: string): string | null;
  /**
   * The peer's description as this end applies it: every candidate that is not
   * an IP address inside the allowed networks removed, a name included, so the
   * ICE agent sends no check and makes no lookup toward one. None left is not a
   * refusal: the peer's own checks still reach this end's allowed candidates.
   */
  acceptRemote(sdp: string): string;
  /**
   * The first public IP literal outside the allowed networks among the
   * candidates of the peer's description as it arrived, before
   * {@link acceptRemote} — a phone's server-reflexive candidate, most often —
   * or `null`. **A diagnostic for the person reading a refusal, never path
   * evidence**: nothing decides on it.
   */
  reportedAddress(sdp: string): string | null;
  /**
   * Why the connection's selected candidate pair may not carry the session,
   * and which end it refuses, or `null` when it may. `pair` is `null` where the
   * peer reports none.
   */
  refusal(pair: DirectSelectedPair | null): PathPolicyRefusal | null;
}

export interface DirectPeerHandlers {
  /** The channel is open: this end may switch its sends onto it. */
  onOpen(): void;
  /** One inbound channel frame, already bounded at `NOISE_MAX_MESSAGE_LENGTH`. */
  onFrame(frame: Uint8Array): void;
  /**
   * The channel went away — closed, errored, or never opened in time. Whether
   * that is burrow loss or an abandoned attempt is the endpoint's call.
   */
  onClosed(reason: string): void;
  /**
   * The peer put something on the channel this protocol has no reading for: a
   * non-binary message, or one too large to be a Noise transport message. The
   * session dies whichever direction has switched, because a peer speaking a
   * different protocol on the channel is not one the counters can be kept
   * synchronized with. `cause` is `path-refused` where the path policy refused
   * the path instead, which ends the session the same way.
   */
  onViolation(reason: string, cause?: DirectViolationCause): void;
}

/** A violation that was not the peer's protocol: see {@link DirectPeerHandlers.onViolation}. */
export type DirectViolationCause = 'path-refused';

/** What a closed peer reports to: nothing, so it retains nothing either. */
const SILENT_HANDLERS: DirectPeerHandlers = {
  onOpen: () => {},
  onFrame: () => {},
  onClosed: () => {},
  onViolation: () => {},
};

export interface DirectPeerDeps {
  readonly peer: DirectPeerLike;
  readonly handlers: DirectPeerHandlers;
  /** The network policy's hold on this attempt, if it has one; see {@link DirectPathPolicy}. */
  readonly pathPolicy?: DirectPathPolicy;
  /** Every deadline below; see {@link RemoteTimer}. */
  readonly setTimer?: RemoteTimer;
}

/**
 * One session's peer connection and its single ordered, reliable data channel.
 *
 * **One negotiation, no trickle**: each side sends its whole description once
 * gathering settles ({@link #awaitGathering}), so the candidates travel inside
 * the session with the SDP and the relay never sees either. **The channel must
 * be open by `DIRECT_SETUP_TIMEOUT_MS`** — by `DIRECT_ANSWER_TIMEOUT_MS` on the
 * answering side, which arms later — or the attempt is abandoned and the
 * session stays relayed.
 *
 * **Sends are bounded here, not left to the implementation.** Past
 * `DIRECT_BUFFER_HIGH` the ciphertext queues instead, draining on the channel's
 * own low-water event, so a burst of terminal output waits in a queue with a
 * stated bound rather than in a runtime buffer whose refusal would kill the
 * session.
 *
 * **A path policy is consulted before the open is reported and again while
 * connected**, and its refusal is a violation: the session ends whichever
 * direction has switched, since a restricted session has no relay to stay on.
 */
export class DirectPeer {
  readonly #peer: DirectPeerLike;
  #handlers: DirectPeerHandlers;
  readonly #pathPolicy: DirectPathPolicy | null;
  readonly #setTimer: RemoteTimer;
  #channel: DirectChannelLike | null = null;
  /** Ciphertext waiting on the channel to drain; see {@link send}. */
  readonly #outbound = new DirectFrameQueue(MAX_DIRECT_PENDING_FRAMES, MAX_DIRECT_PENDING_BYTES);
  #cancelSetup: (() => void) | null = null;
  /** Cancels the grace a `disconnected` connection is given, if one is running. */
  #cancelDisconnected: (() => void) | null = null;
  /** Cancels the next {@link DIRECT_PATH_RECHECK_MS} check, while one is armed. */
  #cancelPathRecheck: (() => void) | null = null;
  /**
   * Settles the gathering wait — cancelling its deadlines with it — or null
   * when none is outstanding. Held on the instance because {@link close} has to
   * reach it: `RTCPeerConnection.close()` fires no `icegatheringstatechange`,
   * so nothing else would.
   */
  #endGathering: (() => void) | null = null;
  /** Everyone waiting for what this end sent to leave; see {@link afterFlush}. */
  readonly #flushWaiters: Array<() => void> = [];
  #open = false;
  #closed = false;
  /** The end of the path the policy refused, where it named one; see {@link refusedEnd}. */
  #refused: PathEnd | null = null;
  /** The refused end's address on the selected pair, an IP literal; see {@link refusedEnd}. */
  #refusedAddress: string | null = null;
  /** {@link DirectPathPolicy.reportedAddress} of the offer this end answered; see {@link refusedEnd}. */
  #reported: string | null = null;

  constructor(deps: DirectPeerDeps) {
    this.#peer = deps.peer;
    this.#handlers = deps.handlers;
    this.#pathPolicy = deps.pathPolicy ?? null;
    this.#setTimer = deps.setTimer ?? realTimer;
    // Registered before either half of the negotiation runs: a connection that
    // fails while a description is still being built has nothing else watching.
    this.#peer.addEventListener('connectionstatechange', () => this.#onConnectionState());
    // ICE can move the session onto another pair without the connection's own
    // state changing, sometimes with an ICE state change and sometimes with
    // none, which is what {@link DIRECT_PATH_RECHECK_MS} is for.
    this.#peer.addEventListener('iceconnectionstatechange', () => this.#recheckPath());
  }

  /** Whether the channel has opened and not since gone. */
  get isOpen(): boolean {
    return this.#open && !this.#closed;
  }

  /**
   * The end a refusal of this attempt names, under a path policy. **`local`
   * where the policy refused this machine's end** — the pair's local end off
   * the allowed networks, or no candidate of this end on one — with that local
   * address where the pair had one, and never the peer's. **Otherwise
   * `remote`**, naming the refused pair's remote end as this end's ICE agent
   * reported it (`observed`), the only path evidence, else the first public
   * address outside the allowed networks the peer's offer carried
   * (`reported`), a diagnostic alone — for a refused remote end, or any
   * attempt whose offer carried one. `null` where neither applies.
   */
  get refusedEnd(): RefusedEnd | null {
    if (this.#refused === 'local') return { end: 'local', address: this.#refusedAddress };
    if (this.#refused === 'remote' && this.#refusedAddress !== null) {
      return { end: 'remote', address: { address: this.#refusedAddress, source: 'observed' } };
    }
    const reported: PathAddress | null =
      this.#reported === null ? null : { address: this.#reported, source: 'reported' };
    if (this.#refused === 'remote' || reported) return { end: 'remote', address: reported };
    return null;
  }

  /**
   * The offerer's half: create the channel, describe it, and answer with the
   * SDP to put in a `direct-offer`.
   *
   * Answers `null` where there is nothing to send — a description this peer
   * would not accept back, or a negotiation that threw — and the caller simply
   * never offers.
   */
  async offer(): Promise<string | null> {
    this.#armSetupTimeout(DIRECT_SETUP_TIMEOUT_MS);
    try {
      this.#adopt(this.#peer.createDataChannel(DIRECT_CHANNEL_LABEL, { ordered: true }));
      const offer = await this.#peer.createOffer();
      await this.#peer.setLocalDescription(offer);
      return await this.#gatheredSdp();
    } catch (error) {
      this.#fail(`could not describe a direct path: ${String(error)}`);
      return null;
    }
  }

  /**
   * The answerer's half: take the offer, wait for the channel it describes, and
   * answer with the SDP to put in a `direct-answer`. `null` means decline.
   */
  async answer(offerSdp: string): Promise<string | null> {
    // The shorter budget, because this end arms it a relay hop after the
    // offerer armed its own; see {@link DIRECT_ANSWER_TIMEOUT_MS}.
    this.#armSetupTimeout(DIRECT_ANSWER_TIMEOUT_MS);
    try {
      // Registered before the remote description is set: the channel event can
      // fire inside `setRemoteDescription`, and a listener added after it would
      // miss the only one this negotiation sends.
      this.#peer.addEventListener('datachannel', (ev) => {
        const channel = (ev as { channel?: DirectChannelLike } | null)?.channel;
        if (channel) this.#adopt(channel);
      });
      const policy = this.#pathPolicy;
      // Read before the strip, which is what removes it: a phone off every
      // allowed network offers nothing the ICE agent may check.
      if (policy) this.#reported = shownAddress(policy.reportedAddress(offerSdp));
      await this.#peer.setRemoteDescription({
        type: 'offer',
        sdp: policy ? policy.acceptRemote(offerSdp) : offerSdp,
      });
      const answer = await this.#peer.createAnswer();
      await this.#peer.setLocalDescription(answer);
      return await this.#gatheredSdp();
    } catch (error) {
      this.#fail(`could not answer a direct path: ${String(error)}`);
      return null;
    }
  }

  /** The offerer's second half, once `direct-answer` has decrypted. */
  async acceptAnswer(answerSdp: string): Promise<void> {
    try {
      await this.#peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    } catch (error) {
      this.#fail(`could not accept a direct answer: ${String(error)}`);
    }
  }

  /**
   * One Noise transport message as one channel frame — raw bytes, never base64
   * or JSON, so the channel carries exactly what the relay would have.
   *
   * **Every way this can fail is reported here, in its own words**, through
   * `onClosed`: the channel refusing a write and this end's own queue
   * overrunning are opposite diagnoses — one is the peer's stack, one is our
   * bound — and an operator reading a burrow-loss log has only the reason to
   * tell them apart. What a report *costs* is still the endpoint's question.
   *
   * The frame is kept by reference: it is ciphertext the session just minted
   * and nothing else holds ({@link DirectFrameQueue}).
   */
  send(ciphertext: Uint8Array): void {
    const channel = this.#channel;
    if (!channel || !this.isOpen) return;
    // **Once anything is queued, everything queues.** A frame handed straight to
    // the channel while others wait would reach the peer ahead of ciphertext
    // encrypted before it, and a Noise stream has no way back from a counter
    // read out of order.
    if (this.#outbound.length === 0 && channel.bufferedAmount < DIRECT_BUFFER_HIGH) {
      if (!this.#write(channel, ciphertext)) this.#fail('the direct channel refused a message');
      return;
    }
    if (!this.#outbound.push(ciphertext)) {
      this.#fail('the direct path outran what a sender can hold in order');
    }
  }

  /**
   * Run `done` once nothing this end has sent is still waiting — neither in its
   * own queue nor in the channel's `bufferedAmount` — or the channel is gone;
   * at once if that is already so. For a sender about to {@link close}, which
   * would otherwise drop both: `RTCPeerConnection.close()` takes the
   * association down with whatever it had not yet sent. Unbounded here; the
   * caller bounds its own wait.
   */
  afterFlush(done: () => void): void {
    if (this.#flushed()) {
      done();
      return;
    }
    // Woken at empty rather than at the low-water mark, so the next
    // `bufferedamountlow` is the one that means the channel has let go.
    this.#channel!.bufferedAmountLowThreshold = 0;
    this.#flushWaiters.push(done);
  }

  /** Close the channel and the connection. Idempotent, and reports nothing. */
  close(): void {
    this.#closed = true;
    this.#clearSetupTimeout();
    this.#clearDisconnectedGrace();
    this.#cancelPathRecheck?.();
    this.#cancelPathRecheck = null;
    this.#outbound.clear();
    // The suspended `offer()`/`answer()` finishes here rather than in three
    // seconds' time: it sees `#closed`, answers `null`, and releases the
    // endpoint and the session it was still holding open.
    this.#endGathering?.();
    try {
      this.#channel?.close();
    } catch {
      // Already closing.
    }
    try {
      this.#peer.close();
    } catch {
      // Already closed.
    }
    // Dropped rather than merely flagged: the channel's own listeners still
    // point here, and a closed peer must retain neither the endpoint that owned
    // these handlers nor whatever the channel is still holding.
    this.#channel = null;
    this.#handlers = SILENT_HANDLERS;
    // Nothing is left to wait for: whatever was still buffered went with it.
    this.#settleFlush();
  }

  // --- Internals -------------------------------------------------------------

  /**
   * Wire one channel's events, whichever side created it.
   *
   * **Reliable and ordered, or not at all.** A Noise stream is one counter per
   * direction with no resynchronization point, so a channel that may drop or
   * reorder a frame is one the session would die on at the first gap rather
   * than the first byte — and dying here, before any switch, only abandons the
   * attempt. The label is checked alongside them: this negotiation creates
   * exactly one channel and calls it {@link DIRECT_CHANNEL_LABEL}.
   *
   * **The reliability half reaches only as far as the implementation reports
   * it.** A browser hands an answerer the parameters the offerer actually
   * negotiated, so there the check bites. `node-datachannel`'s polyfill builds
   * every incoming channel with its own defaults instead — measured against
   * 0.33.2, an offerer's `{ordered: false, maxRetransmits: 0}` reaches the
   * answerer as `ordered: true, maxRetransmits: null` — so on the standalone
   * Burrow only the label comparison is load-bearing, and a paired Client that
   * opened an unordered channel would be adopted. Pinned, so a version that
   * starts reporting them is noticed, by
   * `lib/src/host/remote/native-direct-peer.test.ts`.
   */
  #adopt(channel: DirectChannelLike): void {
    if (this.#channel) return;
    if (
      channel.label !== DIRECT_CHANNEL_LABEL ||
      !channel.ordered ||
      channel.maxRetransmits !== null ||
      channel.maxPacketLifeTime !== null
    ) {
      try {
        channel.close();
      } catch {
        // Never adopted, so nothing here depends on it closing cleanly.
      }
      this.#fail('the direct channel is not the reliable ordered one this session opens');
      return;
    }
    this.#channel = channel;
    // Set before any message can arrive, so every frame is bytes rather than a
    // `Blob` this stack has no synchronous way to read.
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = DIRECT_BUFFER_LOW;
    channel.addEventListener('open', () => this.#onOpen());
    channel.addEventListener('message', (ev) => this.#onMessage(ev));
    channel.addEventListener('bufferedamountlow', () => {
      this.#drain();
      this.#settleFlush();
    });
    channel.addEventListener('close', () => this.#fail('the direct channel closed'));
    channel.addEventListener('error', () => this.#fail('the direct channel failed'));
  }

  /**
   * The channel reported open.
   *
   * **The association's message limit is checked here**, the first moment it is
   * knowable — until the association is up neither stack has a number to give.
   * One Noise transport message is one channel frame and may be
   * {@link NOISE_MAX_MESSAGE_LENGTH} bytes, so an association that would refuse
   * one is a session that dies on its first large paste instead.
   *
   * **The number is the *remote's* advertised limit, so it is per direction.**
   * Where both ends advertise the same — as both shipped stacks do, at 262 144
   * — they abandon together and the session stays relayed. Where they disagree
   * and only one end refuses, a peer that had already switched has no relay
   * left to fall back to and loses the session. That is accepted: the
   * alternative is carrying a session that dies on its first large frame
   * anyway (`docs/specs/remote-api.md` -> Transport -> "Direct path").
   */
  #onOpen(): void {
    if (this.#closed || this.#open) return;
    // Unknown is not small: an implementation reporting no association yet, or
    // no usable number, is one this cannot rule out either way — and every
    // inbound frame is bounded again in `#onMessage` regardless.
    const limit = this.#peer.sctp?.maxMessageSize ?? 0;
    if (limit > 0 && limit < NOISE_MAX_MESSAGE_LENGTH) {
      this.#fail(`the direct channel carries only ${limit} bytes per message`);
      return;
    }
    if (this.#pathRefused()) return;
    this.#open = true;
    this.#clearSetupTimeout();
    this.#armPathRecheck();
    this.#handlers.onOpen();
  }

  /**
   * Hand the channel as much of the queue as it will take.
   *
   * **A frame is written once or not at all**: `send` either consumes the
   * message or throws, so retrying one here would put ciphertext the peer has
   * already counted on the wire twice.
   */
  #drain(): void {
    const channel = this.#channel;
    if (!channel || !this.isOpen) return;
    while (channel.bufferedAmount < DIRECT_BUFFER_HIGH) {
      const frame = this.#outbound.shift();
      if (!frame) return;
      if (this.#write(channel, frame)) continue;
      // Accepted into the queue and refused now: the channel is gone.
      this.#fail('the direct channel refused a message');
      return;
    }
  }

  /** Whether nothing this end sent is still waiting to leave, or there is no channel to leave by. */
  #flushed(): boolean {
    const channel = this.#channel;
    return !channel || !this.isOpen || (this.#outbound.length === 0 && channel.bufferedAmount === 0);
  }

  #settleFlush(): void {
    if (this.#flushWaiters.length === 0 || !this.#flushed()) return;
    for (const done of this.#flushWaiters.splice(0)) done();
  }

  #write(channel: DirectChannelLike, frame: Uint8Array): boolean {
    try {
      channel.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The connection's own state, which reaches here before the channel's does.
   *
   * **`disconnected` is waited out** ({@link DIRECT_DISCONNECTED_GRACE_MS}):
   * ICE reports it on a gap that often recovers, so it is not a report of loss
   * until it persists. `failed` and `closed` are terminal and end the attempt
   * at once.
   */
  #onConnectionState(): void {
    if (this.#closed) return;
    const state = this.#peer.connectionState;
    if (state === 'failed' || state === 'closed') {
      this.#fail(`the direct connection ${state}`);
      return;
    }
    if (state !== 'disconnected') {
      this.#clearDisconnectedGrace();
      this.#recheckPath();
      return;
    }
    if (this.#cancelDisconnected) return;
    this.#cancelDisconnected = this.#setTimer(() => {
      this.#cancelDisconnected = null;
      if (this.#closed || this.#peer.connectionState !== 'disconnected') return;
      this.#fail('the direct connection stayed disconnected');
    }, DIRECT_DISCONNECTED_GRACE_MS);
  }

  #onMessage(ev: unknown): void {
    if (this.#closed) return;
    // A frame no stack should deliver before its channel's open is one whose
    // path has not been checked yet, so it is checked here instead.
    if (!this.#open && this.#pathRefused()) return;
    const data = (ev as { data?: unknown } | null)?.data;
    let frame: Uint8Array;
    // A view either way, never a copy: everything downstream reads the frame
    // inside this call, except the one the cutover holds until the peer's
    // switch decrypts — and `DirectCutover.onChannelFrame` copies that one,
    // which is the only place that knows a frame is about to outlive its
    // buffer.
    if (data instanceof ArrayBuffer) {
      frame = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      frame = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      this.#handlers.onViolation('a direct channel message was not binary');
      return;
    }
    // Bounded before it reaches a cipher, exactly as a relay ciphertext is: one
    // channel frame is one Noise transport message and can be no larger.
    if (frame.length > NOISE_MAX_MESSAGE_LENGTH) {
      this.#handlers.onViolation('a direct channel frame exceeds one Noise message');
      return;
    }
    this.#handlers.onFrame(frame);
  }

  /**
   * The local description once gathering has settled, or `null` if it is not one
   * that fits a signal. Bounded here rather than at the caller so both halves
   * refuse the same descriptions.
   */
  async #gatheredSdp(): Promise<string | null> {
    await this.#awaitGathering();
    if (this.#closed) return null;
    let sdp = this.#peer.localDescription?.sdp;
    // Before the bound: what is sent is the described SDP, not the stack's.
    if (this.#pathPolicy && typeof sdp === 'string') {
      const described = this.#pathPolicy.describe(sdp);
      if (described === null) {
        this.#refused = 'local';
        this.#refuse('no candidate of this end is on an allowed network');
        return null;
      }
      sdp = described;
    }
    return isDirectSdp(sdp) ? sdp : null;
  }

  /**
   * Wait for gathering to settle, at the first of: `iceGatheringState ===
   * 'complete'`; {@link DIRECT_SRFLX_GRACE_MS} from the first server-reflexive
   * candidate or the wait's start, whichever is later; or
   * {@link DIRECT_GATHER_TIMEOUT_MS} from the wait's start — after which the
   * description as it stands is what gets sent, candidates gathered so far
   * included. The wait starts once the local description is set, and finds a
   * srflx already in it: an answerer's stack gathers from inside
   * `setRemoteDescription`, before there is a wait to hear the event.
   */
  #awaitGathering(): Promise<void> {
    if (this.#peer.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise<void>((resolve) => {
      let cancelGrace: (() => void) | null = null;
      const finish = (): void => {
        if (this.#endGathering !== finish) return;
        this.#endGathering = null;
        cancelDeadline();
        cancelGrace?.();
        resolve();
      };
      // Once, and only while the wait is outstanding: the listener outlives it.
      // It reads the stack's own candidates, so a srflx a path policy's
      // `describe` would strip still arms it; no level combines the two today
      // (`burrowUsesStun` is Anywhere alone, `holdsToAllowedNetworks` Local
      // networks alone, in `lib/src/remote/network-policy.ts`).
      const graceIfSrflx = (text: unknown): void => {
        if (this.#endGathering !== finish || typeof text !== 'string') return;
        if (SRFLX_CANDIDATE.test(text)) cancelGrace ??= this.#setTimer(finish, DIRECT_SRFLX_GRACE_MS);
      };
      this.#endGathering = finish;
      const cancelDeadline = this.#setTimer(finish, DIRECT_GATHER_TIMEOUT_MS);
      graceIfSrflx(this.#peer.localDescription?.sdp);
      this.#peer.addEventListener('icecandidate', (ev) =>
        graceIfSrflx((ev as { candidate?: { candidate?: unknown } | null } | null)?.candidate?.candidate),
      );
      this.#peer.addEventListener('icegatheringstatechange', () => {
        if (this.#peer.iceGatheringState === 'complete') finish();
      });
    });
  }

  #armSetupTimeout(budgetMs: number): void {
    this.#clearSetupTimeout();
    this.#cancelSetup = this.#setTimer(() => {
      this.#cancelSetup = null;
      if (this.#open || this.#closed) return;
      this.#fail('the direct channel did not open in time');
    }, budgetMs);
  }

  #clearSetupTimeout(): void {
    this.#cancelSetup?.();
    this.#cancelSetup = null;
  }

  #clearDisconnectedGrace(): void {
    this.#cancelDisconnected?.();
    this.#cancelDisconnected = null;
  }

  /**
   * Check the path again while the channel is open and the connection reports
   * `connected` — on a state change, and every {@link DIRECT_PATH_RECHECK_MS}.
   * A connection on its way down is `#onConnectionState`'s, never a refused
   * path — and so, once open, is a reading of no pair: a stack with no selected
   * pair has nowhere to send, and loses the connection by its state. **A pair
   * the stack could not read is refused**, open or not: it may be one the
   * agent is sending on.
   */
  #recheckPath(): void {
    if (!this.#pathPolicy || this.#closed || !this.#open || this.#peer.connectionState !== 'connected') {
      return;
    }
    const pair = this.#selectedPair();
    if (pair !== null) this.#pathRefused(pair);
  }

  /** Re-read the path every {@link DIRECT_PATH_RECHECK_MS} until the peer closes, where a policy holds it. */
  #armPathRecheck(): void {
    if (!this.#pathPolicy || this.#closed) return;
    this.#cancelPathRecheck = this.#setTimer(() => {
      this.#cancelPathRecheck = null;
      this.#recheckPath();
      this.#armPathRecheck();
    }, DIRECT_PATH_RECHECK_MS);
  }

  /** Run the path policy, if there is one, refusing on its behalf; whether it refused. */
  #pathRefused(pair = this.#selectedPair()): boolean {
    const policy = this.#pathPolicy;
    if (!policy) return false;
    if (pair === UNREADABLE_PAIR) {
      this.#refuse('the connection’s selected candidate pair could not be read');
      return true;
    }
    const refusal = policy.refusal(pair);
    if (refusal === null) return false;
    // The end refused, and its own address on the pair: the remote one is the
    // one address a refusal may name as where the phone connected from.
    this.#refused = refusal.end;
    this.#refusedAddress = shownAddress(refusal.end === null ? null : (pair?.[refusal.end] ?? null));
    this.#refuse(refusal.reason);
    return true;
  }

  /**
   * The selected pair's addresses — from the native read where the peer has
   * one ({@link DirectPeerLike.selectedCandidatePair}), else the transport's —
   * `null` where the stack reports none, or {@link UNREADABLE_PAIR} where
   * reading it threw.
   */
  #selectedPair(): DirectSelectedPair | null | typeof UNREADABLE_PAIR {
    const peer = this.#peer;
    try {
      const pair = peer.selectedCandidatePair
        ? peer.selectedCandidatePair()
        : peer.sctp?.transport?.iceTransport?.getSelectedCandidatePair?.();
      return pair ? { local: addressOf(pair.local), remote: addressOf(pair.remote) } : null;
    } catch {
      return UNREADABLE_PAIR;
    }
  }

  /** The path is not one the policy allows: dispose like a violation, once. */
  #refuse(reason: string): void {
    if (this.#closed) return;
    const handlers = this.#handlers;
    this.close();
    handlers.onViolation(reason, 'path-refused');
  }

  /** Report the channel gone, once, and take the connection down with it. */
  #fail(reason: string): void {
    if (this.#closed) return;
    // Read before the close silences them: this is the one report a close owes.
    const handlers = this.#handlers;
    this.close();
    handlers.onClosed(reason);
  }
}
