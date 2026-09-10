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
  DIRECT_GATHER_TIMEOUT_MS,
  DIRECT_SETUP_TIMEOUT_MS,
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
  send(data: ArrayBuffer | ArrayBufferView): void;
  close(): void;
  addEventListener(type: string, handler: (ev: unknown) => void): void;
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
 * sees either. **The channel must be open by `DIRECT_SETUP_TIMEOUT_MS`** or the
 * attempt is abandoned and the session stays relayed.
 */
export class DirectPeer {
  readonly #peer: DirectPeerLike;
  #handlers: DirectPeerHandlers;
  readonly #setTimer: RemoteTimer;
  #channel: DirectChannelLike | null = null;
  #cancelSetup: (() => void) | null = null;
  #open = false;
  #closed = false;

  constructor(deps: DirectPeerDeps) {
    this.#peer = deps.peer;
    this.#handlers = deps.handlers;
    this.#setTimer = deps.setTimer ?? realTimer;
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
    this.#armSetupTimeout();
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
    this.#armSetupTimeout();
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
    try {
      channel.send(ciphertext);
      return true;
    } catch {
      return false;
    }
  }

  /** Close the channel and the connection. Idempotent, and reports nothing. */
  close(): void {
    this.#closed = true;
    this.#clearSetupTimeout();
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

  /** Wire one channel's four events, whichever side created it. */
  #adopt(channel: DirectChannelLike): void {
    if (this.#channel) return;
    this.#channel = channel;
    // Set before any message can arrive, so every frame is bytes rather than a
    // `Blob` this stack has no synchronous way to read.
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('open', () => {
      if (this.#closed || this.#open) return;
      this.#open = true;
      this.#clearSetupTimeout();
      this.#handlers.onOpen();
    });
    channel.addEventListener('message', (ev) => this.#onMessage(ev));
    channel.addEventListener('close', () => this.#fail('the direct channel closed'));
    channel.addEventListener('error', () => this.#fail('the direct channel failed'));
  }

  #onMessage(ev: unknown): void {
    if (this.#closed) return;
    const data = (ev as { data?: unknown } | null)?.data;
    let frame: Uint8Array;
    if (data instanceof ArrayBuffer) {
      frame = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      // Copied, not viewed: the cutover may hold this frame until the peer's
      // switch decrypts, and a view over a pooled or reused buffer (the Node
      // polyfill hands over a `Buffer`) would read whatever landed there next.
      frame = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
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
      let settled = false;
      let cancel: (() => void) | null = null;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        cancel?.();
        resolve();
      };
      cancel = this.#setTimer(finish, DIRECT_GATHER_TIMEOUT_MS);
      this.#peer.addEventListener('icegatheringstatechange', () => {
        if (this.#peer.iceGatheringState === 'complete') finish();
      });
    });
  }

  #armSetupTimeout(): void {
    this.#clearSetupTimeout();
    this.#cancelSetup = this.#setTimer(() => {
      this.#cancelSetup = null;
      if (this.#open || this.#closed) return;
      this.#fail('the direct channel did not open in time');
    }, DIRECT_SETUP_TIMEOUT_MS);
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
