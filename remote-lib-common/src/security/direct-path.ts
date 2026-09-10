/**
 * The direct path's shared half: the four signaling controls that ride inside
 * an established session, and the per-end cutover state machine that moves that
 * session off the relay (`docs/specs/remote-api.md` -> Transport -> "Direct
 * path").
 *
 * One implementation, so the two ends cannot disagree about what a switch
 * means. Nothing here knows about `RTCPeerConnection`, the relay envelope, or
 * either endpoint's plumbing: a signal is a control message like any other
 * (`docs/specs/relay.md` -> "E2E framing") and a held frame is bytes.
 */

import { isBoundedString } from './bytes.js';
import { CONTROL_PAYLOAD_SIZE } from './noise-transport.js';

/**
 * How long a peer waits for the channel to open before abandoning the attempt
 * and staying relayed. Generous: gathering, DTLS, and SCTP all fit inside it on
 * a link that works at all, and the cost of waiting is nothing — the session is
 * carrying traffic on the relay the whole time.
 */
export const DIRECT_SETUP_TIMEOUT_MS = 15_000;

/**
 * How long a peer waits for ICE gathering to finish before sending whatever
 * local description it has. There is no trickle path — the SDP crosses inside
 * the session as one control message — so a gatherer that never completes must
 * not strand the attempt.
 */
export const DIRECT_GATHER_TIMEOUT_MS = 3_000;

/**
 * The most SDP one signal may carry, in characters.
 *
 * Derived from {@link CONTROL_PAYLOAD_SIZE}, which every control body is padded
 * to and may not exceed: with the SDP restricted to the characters SDP is made
 * of ({@link isDirectSdp}), JSON encodes each of them as at most two bytes, so
 * `2 * MAX_DIRECT_SDP_LENGTH` plus the envelope always fits. The relationship
 * is pinned by `remote-lib-common/test/direct-path.test.mjs`.
 *
 * A description longer than this is not sent: the offerer skips the attempt and
 * an answerer declines, and the session stays relayed.
 */
export const MAX_DIRECT_SDP_LENGTH = 2000;

/** How many channel frames a receiver holds while awaiting the peer's switch. */
export const MAX_DIRECT_PENDING_FRAMES = 64;

/** How many bytes of held channel frames a receiver holds, whatever the count. */
export const MAX_DIRECT_PENDING_BYTES = 1024 * 1024;

/**
 * Which path carries a session's traffic. `direct` only once **both**
 * directions have switched — until then the relay is still carrying half of it,
 * and telling the user otherwise would be a claim about a path that is not yet
 * the only one.
 */
export type DirectPath = 'relay' | 'direct';

/**
 * The signaling messages, as `control` transport plaintexts on an established
 * session. Versioned and discriminated so a peer that does not know them
 * ignores them rather than failing the session.
 *
 * `direct-offer` is Client->Burrow, `direct-answer` and `direct-decline` are
 * Burrow->Client, and `direct-switch` travels in either direction as its
 * sender's last message on the relay path.
 */
export type DirectSignalV1 =
  | { readonly v: 1; readonly t: 'direct-offer'; readonly sdp: string }
  | { readonly v: 1; readonly t: 'direct-answer'; readonly sdp: string }
  | { readonly v: 1; readonly t: 'direct-decline' }
  | { readonly v: 1; readonly t: 'direct-switch' };

/** The `t` of every signal, so a dispatcher cannot invent a fifth. */
export type DirectSignalType = DirectSignalV1['t'];

/**
 * The characters an SDP may be made of: printable US-ASCII plus CR and LF.
 *
 * Restricting them is what turns {@link MAX_DIRECT_SDP_LENGTH} from a character
 * bound into a byte bound — every one of these JSON-encodes to at most two
 * bytes — and every description either end generates is already inside it. A
 * description that is not stays out of the session: the attempt is abandoned
 * and the relay keeps carrying it.
 */
export function isDirectSdp(value: unknown): value is string {
  if (!isBoundedString(value, MAX_DIRECT_SDP_LENGTH)) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x0d || code === 0x0a) continue;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/**
 * Structural validation of a decrypted control message that claims to be a
 * signal. Authenticated by Noise, which proves *who* sent it and nothing about
 * its shape — so the keys are exact, the version is the one this end speaks,
 * and the SDP is bounded before anything reads it.
 *
 * Answers `false` for every other control message rather than throwing: an
 * unknown control shape on an established session is ignored, never a session
 * failure, which is what lets a peer without this stack stay talking.
 */
export function isDirectSignalV1(value: unknown): value is DirectSignalV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const signal = value as Record<string, unknown>;
  if (signal.v !== 1) return false;
  const keys = Object.keys(signal);
  switch (signal.t) {
    case 'direct-offer':
    case 'direct-answer':
      return keys.length === 3 && isDirectSdp(signal.sdp);
    case 'direct-decline':
    case 'direct-switch':
      return keys.length === 2;
    default:
      return false;
  }
}

/** What a relay transport frame may do once this end has read the peer's switch. */
export type DirectRelayOutcome = 'process' | 'violation';

/** What one inbound channel frame turned out to be. */
export type DirectChannelOutcome = 'process' | 'held' | 'overflow';

/**
 * One end's view of the cutover, which is per direction and never negotiated:
 * each side switches its own sends and learns about the peer's when the peer's
 * `direct-switch` decrypts.
 *
 * **Order is preserved per direction** because a sender's switch is its last
 * relay message and a receiver holds channel frames until it has read that
 * switch — so nothing sent after it can be processed before what was sent
 * before it. The holding queue is bounded in both frames and bytes; a peer that
 * overruns it is one this end cannot keep in order, which is a dead session
 * rather than a dropped frame.
 */
export class DirectCutover {
  #outbound: DirectPath = 'relay';
  #inbound: DirectPath = 'relay';
  readonly #held: Uint8Array[] = [];
  #heldBytes = 0;

  /** Where this end's own messages go. */
  get outbound(): DirectPath {
    return this.#outbound;
  }

  /** Where the peer's messages come from, as of the last switch it sent. */
  get inbound(): DirectPath {
    return this.#inbound;
  }

  /** What carries the session as a whole; see {@link DirectPath}. */
  get path(): DirectPath {
    return this.#outbound === 'direct' && this.#inbound === 'direct' ? 'direct' : 'relay';
  }

  /** Whether either direction has left the relay — what a channel loss ends. */
  get switched(): boolean {
    return this.#outbound === 'direct' || this.#inbound === 'direct';
  }

  get pendingFrames(): number {
    return this.#held.length;
  }

  get pendingBytes(): number {
    return this.#heldBytes;
  }

  /**
   * Move this end's sends onto the channel. The caller sends its
   * `direct-switch` on the relay *first*: this is the line after which nothing
   * else may.
   *
   * Answers `false` for a second call, so a duplicate open cannot put two
   * switches on the wire.
   */
  switchOutbound(): boolean {
    if (this.#outbound === 'direct') return false;
    this.#outbound = 'direct';
    return true;
  }

  /**
   * One transport frame arriving on the relay. Once the peer has switched there
   * is nothing left for it to send there, so a frame that arrives anyway is a
   * peer this end can no longer keep in order with the channel.
   */
  onRelayTransport(): DirectRelayOutcome {
    return this.#inbound === 'direct' ? 'violation' : 'process';
  }

  /**
   * The peer's `direct-switch` decrypted: everything held is now known to come
   * after it. Returns the held frames in arrival order, and empties the queue.
   */
  onSwitchDecrypted(): Uint8Array[] {
    this.#inbound = 'direct';
    const drained = [...this.#held];
    this.#held.length = 0;
    this.#heldBytes = 0;
    return drained;
  }

  /**
   * One inbound channel frame: processed once the peer's switch has been read,
   * held until then, and `overflow` when holding it would break the bound.
   */
  onChannelFrame(frame: Uint8Array): DirectChannelOutcome {
    if (this.#inbound === 'direct') return 'process';
    if (
      this.#held.length >= MAX_DIRECT_PENDING_FRAMES ||
      this.#heldBytes + frame.length > MAX_DIRECT_PENDING_BYTES
    ) {
      return 'overflow';
    }
    this.#held.push(frame);
    this.#heldBytes += frame.length;
    return 'held';
  }

  /** Release held frames; a disposed session has nothing left to drain them. */
  clear(): void {
    this.#held.length = 0;
    this.#heldBytes = 0;
  }
}
