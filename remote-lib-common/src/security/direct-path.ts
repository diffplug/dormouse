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
 * The same deadline for the answerer, which arms it a relay round trip later
 * than the offerer does and so **must be the one that gives up first**. Its
 * channel closing is what reaches the offerer while the offerer is still
 * unswitched, so both ends abandon a slow attempt and stay relayed instead of
 * meeting on the fatal rule for a switch onto an abandoned channel. The
 * ordering is pinned by `remote-lib-common/test/direct-path.test.mjs`.
 */
export const DIRECT_ANSWER_TIMEOUT_MS = 10_000;

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

/**
 * How many bytes of held channel frames a receiver holds while awaiting the
 * peer's switch. **The operative bound of the two**: what the window has to
 * cover is one relay one-way hop of a terminal stream, and bytes are what the
 * machine actually holds (`docs/specs/remote-security-model.md` -> "Burrow
 * bounds").
 */
export const MAX_DIRECT_PENDING_BYTES = 4 * 1024 * 1024;

/**
 * How many channel frames a receiver holds, whatever their size. Set above
 * where the ~1 KiB frames a PTY produces can reach it, so it stops only a peer
 * sending thousands of tiny ones; {@link MAX_DIRECT_PENDING_BYTES} is what
 * bounds real traffic. The relationship is pinned by
 * `remote-lib-common/test/direct-path.test.mjs`.
 */
export const MAX_DIRECT_PENDING_FRAMES = 8192;

/**
 * How long this end waits, after putting its own `direct-switch` on the relay,
 * for the peer's to come back the other way.
 *
 * Its own bound rather than the holding queue's: a peer that has stopped
 * switching leaves this end sending into a channel nothing reads, and waiting
 * for {@link MAX_DIRECT_PENDING_BYTES} to fill makes the wait a function of how
 * chatty the session happens to be. Generous next to the relay round trip the
 * peer's switch actually takes.
 */
export const DIRECT_HANDOFF_TIMEOUT_MS = 5_000;

/**
 * How long a connection may sit `disconnected` before the attempt is written
 * off. ICE reports that state on a gap the connection may well recover from — a
 * phone changing networks, a radio blip — and ending a switched session there
 * costs a fresh handshake and a WebAuthn prompt, so the transient case is
 * waited out. `failed` and `closed` are terminal and are never waited on.
 */
export const DIRECT_DISCONNECTED_GRACE_MS = 5_000;

/**
 * How much a sender holds while the channel drains, in bytes and in frames.
 *
 * The same pair of numbers as the receiver's hold, for the same reasons: what a
 * queue has to cover is a burst of a terminal stream, bytes are what the machine
 * actually holds, and the frame count sits above where the ~1 KiB frames a PTY
 * produces can reach it. A sender that overruns them is one whose peer is not
 * draining fast enough to stay in order, which is a dead session rather than a
 * dropped frame — the same answer the receiver gives.
 */
export const MAX_DIRECT_OUTBOUND_BYTES = MAX_DIRECT_PENDING_BYTES;
export const MAX_DIRECT_OUTBOUND_FRAMES = MAX_DIRECT_PENDING_FRAMES;

/**
 * How much the channel implementation may have buffered before a sender stops
 * handing it more and queues instead, and the level it must drain back to
 * before sending resumes.
 *
 * Two levels rather than one, so a busy stream is not woken on every frame.
 * {@link MAX_DIRECT_OUTBOUND_BYTES} is what bounds the wait; these only decide
 * where the ciphertext sits while the association catches up.
 */
export const DIRECT_BUFFER_HIGH = 256 * 1024;
export const DIRECT_BUFFER_LOW = 64 * 1024;

/**
 * A run of channel frames bounded in both frames and bytes, **bytes binding
 * first**.
 *
 * Both of the direct path's queues are one of these — what a receiver holds
 * until the peer's switch decrypts, and what a sender holds while the channel
 * drains — so "over the bound" means one thing in both directions.
 *
 * **A queued frame is copied.** Queueing is what makes a frame outlive the call
 * that produced it, and on the receive side that call's buffer is a view over
 * whatever the runtime handed it.
 */
export class DirectFrameQueue {
  readonly #frames: Uint8Array[] = [];
  readonly #maxFrames: number;
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(maxFrames: number, maxBytes: number) {
    this.#maxFrames = maxFrames;
    this.#maxBytes = maxBytes;
  }

  get length(): number {
    return this.#frames.length;
  }

  get bytes(): number {
    return this.#bytes;
  }

  /** Whether one more frame of `length` bytes would break either bound. */
  wouldOverflow(length: number): boolean {
    return this.#frames.length >= this.#maxFrames || this.#bytes + length > this.#maxBytes;
  }

  push(frame: Uint8Array): void {
    this.#frames.push(frame.slice());
    this.#bytes += frame.length;
  }

  /** The oldest frame, or `undefined` where there is none. */
  shift(): Uint8Array | undefined {
    const frame = this.#frames.shift();
    if (frame) this.#bytes -= frame.length;
    return frame;
  }

  /** Everything held, in arrival order, leaving the queue empty. */
  take(): Uint8Array[] {
    const frames = [...this.#frames];
    this.clear();
    return frames;
  }

  clear(): void {
    this.#frames.length = 0;
    this.#bytes = 0;
  }
}

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
 * How far this end's one attempt has got: `idle` before it starts, `attempting`
 * from {@link DirectCutover.begin} until {@link DirectCutover.abandon}, and
 * `abandoned` forever after. There is no way back to `idle`, which is what makes
 * the attempt once-per-session.
 */
export type DirectAttemptState = 'idle' | 'attempting' | 'abandoned';

/** What the peer's `direct-switch` turned out to mean; see {@link DirectCutover.onSwitchDecrypted}. */
export type DirectSwitchOutcome =
  | { readonly kind: 'drain'; readonly frames: Uint8Array[] }
  | { readonly kind: 'fatal' };

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
 *
 * The attempt's lifecycle lives here too, so the two ends cannot disagree about
 * when one may start or what a switch means after one has been given up.
 */
export class DirectCutover {
  #state: DirectAttemptState = 'idle';
  #outbound: DirectPath = 'relay';
  #inbound: DirectPath = 'relay';
  readonly #held = new DirectFrameQueue(MAX_DIRECT_PENDING_FRAMES, MAX_DIRECT_PENDING_BYTES);

  /** How far this end's one attempt has got. */
  get state(): DirectAttemptState {
    return this.#state;
  }

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
    return this.#held.bytes;
  }

  /**
   * Claim this session's one attempt. **The one-attempt-per-session gate**: a
   * second call answers `false` and allocates nothing, whatever the first
   * attempt did or is still doing.
   */
  begin(): boolean {
    if (this.#state !== 'idle') return false;
    this.#state = 'attempting';
    return true;
  }

  /**
   * Give the attempt up, leaving the session exactly as relayed as it was, and
   * release what it was holding.
   *
   * **Only legal before either direction has switched** — after that there is no
   * relay left to fall back to, so a caller reaching here has confused an
   * abandoned attempt with burrow loss.
   */
  abandon(): void {
    if (this.switched) throw new Error('a switched direct path cannot be abandoned');
    this.#state = 'abandoned';
    this.clear();
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
   * after it, so `drain` carries the held frames in arrival order and empties
   * the queue.
   *
   * **A switch onto a channel this end has abandoned is `fatal`**: nothing that
   * peer sends can arrive any more, and the alternative is a session whose every
   * request hangs unanswered.
   */
  onSwitchDecrypted(): DirectSwitchOutcome {
    if (this.#state === 'abandoned') return { kind: 'fatal' };
    this.#inbound = 'direct';
    return { kind: 'drain', frames: this.#held.take() };
  }

  /**
   * One inbound channel frame: processed once the peer's switch has been read,
   * held until then, and `overflow` when holding it would break the bound.
   *
   * **A held frame is copied, and only a held frame.** Holding is what makes a
   * frame outlive this call, and the caller's buffer — a view over whatever the
   * runtime handed it — cannot be trusted to still say the same thing when the
   * queue drains ({@link DirectFrameQueue}). A frame answered `process` is
   * decrypted before this returns.
   */
  onChannelFrame(frame: Uint8Array): DirectChannelOutcome {
    if (this.#inbound === 'direct') return 'process';
    if (this.#held.wouldOverflow(frame.length)) return 'overflow';
    this.#held.push(frame);
    return 'held';
  }

  /** Release held frames; a disposed session has nothing left to drain them. */
  clear(): void {
    this.#held.clear();
  }
}
