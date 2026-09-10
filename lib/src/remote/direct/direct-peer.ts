/**
 * The `RTCPeerConnection`-shaped seam both ends of the direct path share
 * (`docs/specs/remote-api.md` -> Transport -> "Direct path").
 *
 * **Structural, never the DOM globals.** The interfaces below are the subset of
 * the W3C API this stack calls, so the browser's `RTCPeerConnection`, the
 * sidecar's native polyfill, and the in-memory fake all satisfy the same shape
 * and neither endpoint reaches for a global. Constructing one is the injected
 * factory's job (`PocketClientDeps.createDirectPeer`,
 * `BurrowOptions.createDirectPeer`), which is also where `iceServers: []` is
 * set — nothing here knows what an ICE server is.
 *
 * The wrapper owns the two halves of one negotiation and the channel's four
 * events. It owns no policy: what a closed channel *means* depends on whether
 * the session has already switched, which is the endpoint's question.
 */

import {
  DIRECT_ANSWER_TIMEOUT_MS,
  DIRECT_BUFFER_HIGH,
  DIRECT_BUFFER_LOW,
  DIRECT_DISCONNECTED_GRACE_MS,
  DIRECT_GATHER_TIMEOUT_MS,
  DIRECT_SETUP_TIMEOUT_MS,
  DirectFrameQueue,
  MAX_DIRECT_OUTBOUND_BYTES,
  MAX_DIRECT_OUTBOUND_FRAMES,
  NOISE_MAX_MESSAGE_LENGTH,
  isDirectSdp,
} from 'remote-lib-common';
import { realTimer, type RemoteTimer } from '../ws';

/** The label of the one data channel a session opens. */
export const DIRECT_CHANNEL_LABEL = 'dormouse';

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

/**
 * As much of `RTCSctpTransport` as the size check needs. The association's own
 * limit, negotiated from both ends' `a=max-message-size`, so it is knowable only
 * once the channel is open.
 */
export interface DirectSctpLike {
  readonly maxMessageSize: number;
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
  addEventListener(type: string, handler: (ev: unknown) => void): void;
  close(): void;
}

/** How one endpoint constructs a peer, or answers that it has none. */
export type DirectPeerFactory = () => DirectPeerLike | null;

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
   * synchronized with.
   */
  onViolation(reason: string): void;
}

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
  /** Every deadline below; see {@link RemoteTimer}. */
  readonly setTimer?: RemoteTimer;
}

/**
 * One session's peer connection and its single ordered, reliable data channel.
 *
 * **One negotiation, no trickle**: each side sends its whole description once
 * ICE gathering has completed (or `DIRECT_GATHER_TIMEOUT_MS` has passed), so
 * the candidates travel inside the session with the SDP and the relay never
 * sees either. **The channel must be open by `DIRECT_SETUP_TIMEOUT_MS`** — by
 * `DIRECT_ANSWER_TIMEOUT_MS` on the answering side, which arms later — or the
 * attempt is abandoned and the session stays relayed.
 *
 * **Sends are bounded here, not left to the implementation.** Past
 * `DIRECT_BUFFER_HIGH` the ciphertext queues instead, draining on the channel's
 * own low-water event, so a burst of terminal output waits in a queue with a
 * stated bound rather than in a runtime buffer whose refusal would kill the
 * session.
 */
export class DirectPeer {
  readonly #peer: DirectPeerLike;
  #handlers: DirectPeerHandlers;
  readonly #setTimer: RemoteTimer;
  #channel: DirectChannelLike | null = null;
  /** Ciphertext waiting on the channel to drain; see {@link send}. */
  readonly #outbound = new DirectFrameQueue(MAX_DIRECT_OUTBOUND_FRAMES, MAX_DIRECT_OUTBOUND_BYTES);
  #cancelSetup: (() => void) | null = null;
  /** Cancels the grace a `disconnected` connection is given, if one is running. */
  #cancelDisconnected: (() => void) | null = null;
  /**
   * Settles the gathering wait — cancelling its deadline with it — or null when
   * none is outstanding. Held on the instance because {@link close} has to
   * reach it: `RTCPeerConnection.close()` fires no `icegatheringstatechange`,
   * so nothing else would.
   */
  #endGathering: (() => void) | null = null;
  #open = false;
  #closed = false;

  constructor(deps: DirectPeerDeps) {
    this.#peer = deps.peer;
    this.#handlers = deps.handlers;
    this.#setTimer = deps.setTimer ?? realTimer;
    // Registered before either half of the negotiation runs: a connection that
    // fails while a description is still being built has nothing else watching.
    this.#peer.addEventListener('connectionstatechange', () => this.#onConnectionState());
  }

  /** Whether the channel has opened and not since gone. */
  get isOpen(): boolean {
    return this.#open && !this.#closed;
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
      await this.#peer.setRemoteDescription({ type: 'offer', sdp: offerSdp });
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
   * Answers `false` where the channel cannot take it rather than throwing: the
   * endpoint decides what a refused send means, and on a session that has
   * already switched it is burrow loss rather than an error for the caller.
   */
  send(ciphertext: Uint8Array): boolean {
    const channel = this.#channel;
    if (!channel || !this.isOpen) return false;
    // **Once anything is queued, everything queues.** A frame handed straight to
    // the channel while others wait would reach the peer ahead of ciphertext
    // encrypted before it, and a Noise stream has no way back from a counter
    // read out of order.
    if (this.#outbound.length === 0 && channel.bufferedAmount < DIRECT_BUFFER_HIGH) {
      return this.#write(channel, ciphertext);
    }
    if (this.#outbound.wouldOverflow(ciphertext.length)) return false;
    this.#outbound.push(ciphertext);
    return true;
  }

  /** Close the channel and the connection. Idempotent, and reports nothing. */
  close(): void {
    this.#closed = true;
    this.#clearSetupTimeout();
    this.#cancelDisconnected?.();
    this.#cancelDisconnected = null;
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
    channel.addEventListener('bufferedamountlow', () => this.#drain());
    channel.addEventListener('close', () => this.#fail('the direct channel closed'));
    channel.addEventListener('error', () => this.#fail('the direct channel failed'));
  }

  /**
   * The channel reported open.
   *
   * **The association's message limit is checked here**, where the attempt can
   * still be abandoned onto a relay that is still carrying the session. One
   * Noise transport message is one channel frame and may be
   * {@link NOISE_MAX_MESSAGE_LENGTH} bytes, so an association that would refuse
   * one is a session that dies on its first large paste instead.
   */
  #onOpen(): void {
    if (this.#closed || this.#open) return;
    const limit = this.#peer.sctp?.maxMessageSize;
    // Unknown is not small: an implementation reporting no association yet, or
    // no usable number, is one this cannot rule out either way — and every
    // inbound frame is bounded again in `#onMessage` regardless.
    if (typeof limit === 'number' && limit > 0 && limit < NOISE_MAX_MESSAGE_LENGTH) {
      this.#fail(`the direct channel carries only ${limit} bytes per message`);
      return;
    }
    this.#open = true;
    this.#clearSetupTimeout();
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
    while (this.#outbound.length > 0 && channel.bufferedAmount < DIRECT_BUFFER_HIGH) {
      const frame = this.#outbound.shift();
      if (!frame) return;
      if (this.#write(channel, frame)) continue;
      // The channel took this frame into the queue and will not take it now:
      // it is gone, and the endpoint decides what that costs.
      this.#fail('the direct channel refused a message');
      return;
    }
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
   * ICE reports it on a gap the connection often recovers from, and ending a
   * switched session there costs a fresh handshake and a WebAuthn prompt.
   * `failed` and `closed` are terminal and end the attempt at once.
   */
  #onConnectionState(): void {
    if (this.#closed) return;
    const state = this.#peer.connectionState;
    if (state === 'failed' || state === 'closed') {
      this.#fail(`the direct connection ${state}`);
      return;
    }
    if (state !== 'disconnected') {
      this.#cancelDisconnected?.();
      this.#cancelDisconnected = null;
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
    const sdp = this.#peer.localDescription?.sdp;
    return isDirectSdp(sdp) ? sdp : null;
  }

  /**
   * Wait for `iceGatheringState === 'complete'`, bounded by
   * {@link DIRECT_GATHER_TIMEOUT_MS} — after which the description as it stands
   * is what gets sent, candidates gathered so far included.
   */
  #awaitGathering(): Promise<void> {
    if (this.#peer.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise<void>((resolve) => {
      let cancel: (() => void) | null = null;
      const finish = (): void => {
        if (this.#endGathering !== finish) return;
        this.#endGathering = null;
        cancel?.();
        resolve();
      };
      this.#endGathering = finish;
      cancel = this.#setTimer(finish, DIRECT_GATHER_TIMEOUT_MS);
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

  /** Report the channel gone, once, and take the connection down with it. */
  #fail(reason: string): void {
    if (this.#closed) return;
    // Read before the close silences them: this is the one report a close owes.
    const handlers = this.#handlers;
    this.close();
    handlers.onClosed(reason);
  }
}
