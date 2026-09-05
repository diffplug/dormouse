/**
 * What rides inside a Noise transport message once `Split` has run
 * (`docs/specs/relay.md` -> "Routing" -> "E2E framing").
 *
 * One implementation, so no two speakers can disagree about what a transport
 * plaintext is; today the harness is the only one. It knows nothing about the
 * relay envelope that carries the ciphertext — routing metadata is never
 * authenticated application content.
 */

import {
  concatBytes,
  lengthPrefixedConcat,
  readUint32BE,
  utf8Decode,
  utf8Encode,
  writeUint32BE,
} from './bytes.js';
import {
  NOISE_MAX_MESSAGE_LENGTH,
  NOISE_TAG_LENGTH,
  NoiseError,
  type NoiseCipherState,
  type NoiseSession,
} from './noise.js';

/** The domain every E2E prologue leads with; one domain per bound transcript. */
export const E2E_PROLOGUE_DOMAIN = 'dormouse/e2e/v1';

/** The first byte of every transport plaintext. */
export const TRANSPORT_KIND_KEEPALIVE = 0x00;
export const TRANSPORT_KIND_STREAM = 0x01;
export const TRANSPORT_KIND_CONTROL = 0x02;

/** A keepalive's body: exactly this many zero bytes, so every one is identical. */
export const KEEPALIVE_BODY_SIZE = 32;

/** Control bodies pad to this, so every one is the same size on the wire. */
export const CONTROL_PAYLOAD_SIZE = 4096;

/** Each application message is `u32 big-endian length || bytes`. */
export const APP_LENGTH_PREFIX_SIZE = 4;

/** The largest application message either side will send or reassemble. */
export const MAX_APP_MESSAGE_LENGTH = 1024 * 1024;

/**
 * The largest stream body one Noise message can carry: the 65,535-byte cap
 * less the Poly1305 tag and the kind byte. The chunker splits on it, and a
 * larger body arriving is a framing violation rather than a Noise failure.
 */
export const MAX_STREAM_BODY_LENGTH = NOISE_MAX_MESSAGE_LENGTH - NOISE_TAG_LENGTH - 1;

const EMPTY = new Uint8Array(0);

/**
 * A framing violation. Extends {@link NoiseError} so one `instanceof` covers
 * every reason a session dies: to the caller, a body that lies about its length
 * and a ciphertext that does not authenticate are the same terminal event.
 */
export class NoiseTransportError extends NoiseError {
  constructor(message: string) {
    super(message);
    this.name = 'NoiseTransportError';
  }
}

// ---------------------------------------------------------------------------
// Prologues

/**
 * The connection prologue: the E2E version, the ceremony kind, the `burrowId`,
 * and this connection's id. Both sides build it from the same routing values
 * they put on the envelope, so a handshake replayed against another Burrow, id,
 * or ceremony fails at message 1.
 */
export function e2eConnectionPrologue(burrowId: string, connectionId: string): Uint8Array {
  return e2ePrologue('connection', burrowId, [connectionId]);
}

/**
 * The pairing prologue: the version, the kind, the `burrowId`, and every
 * invitation field in the order the QR carries them.
 *
 * Positional, and the order is `pairingInvitationFields`' to say
 * (`security/pairing-invitation.ts`) — kept out of this layer so the encoding
 * and the grammar it binds stay in one file each.
 */
export function e2ePairingPrologue(
  burrowId: string,
  invitationFields: readonly string[],
): Uint8Array {
  return e2ePrologue('pairing', burrowId, invitationFields);
}

// `kind` is the `E2eKind` of the envelope this transcript binds; spelled as a
// literal union because `remote/wire.ts` imports this layer, not the reverse.
function e2ePrologue(
  kind: 'connection' | 'pairing',
  burrowId: string,
  extra: readonly string[],
): Uint8Array {
  return lengthPrefixedConcat([
    utf8Encode(E2E_PROLOGUE_DOMAIN),
    utf8Encode(kind),
    utf8Encode(burrowId),
    ...extra.map((field) => utf8Encode(field)),
  ]);
}

// ---------------------------------------------------------------------------
// Transport plaintexts

/** One decoded transport plaintext: `[kind: u8][body]`. */
export type TransportPlaintext =
  | { readonly kind: 'keepalive' }
  | { readonly kind: 'control'; readonly value: Record<string, unknown> }
  | { readonly kind: 'stream'; readonly body: Uint8Array };

/**
 * The one encoder. Its inverse is {@link decodeTransportPlaintext}; nothing
 * else in the system may write a transport plaintext.
 */
export function encodeTransportPlaintext(frame: TransportPlaintext): Uint8Array {
  switch (frame.kind) {
    case 'keepalive':
      return concatBytes(
        Uint8Array.of(TRANSPORT_KIND_KEEPALIVE),
        new Uint8Array(KEEPALIVE_BODY_SIZE),
      );
    case 'control':
      return concatBytes(Uint8Array.of(TRANSPORT_KIND_CONTROL), encodeControlBody(frame.value));
    case 'stream':
      if (frame.body.length > MAX_STREAM_BODY_LENGTH) {
        throw new NoiseTransportError('stream body exceeds one Noise message');
      }
      return concatBytes(Uint8Array.of(TRANSPORT_KIND_STREAM), frame.body);
  }
}

/**
 * The one decoder. Every length is checked before any UTF-8 decode or JSON
 * parse, so a malformed plaintext costs a comparison rather than a parse.
 */
export function decodeTransportPlaintext(plaintext: Uint8Array): TransportPlaintext {
  if (plaintext.length === 0) throw new NoiseTransportError('transport plaintext is empty');
  const body = plaintext.subarray(1);
  switch (plaintext[0]) {
    case TRANSPORT_KIND_KEEPALIVE: {
      if (body.length !== KEEPALIVE_BODY_SIZE) {
        throw new NoiseTransportError('keepalive body must be 32 bytes');
      }
      for (const byte of body) {
        if (byte !== 0) throw new NoiseTransportError('keepalive body must be zero');
      }
      return { kind: 'keepalive' };
    }
    case TRANSPORT_KIND_STREAM: {
      if (body.length > MAX_STREAM_BODY_LENGTH) {
        throw new NoiseTransportError('stream body exceeds one Noise message');
      }
      // Copied: this decoder is exported, and Node hands a WebSocket frame over
      // as a `Buffer` whose `subarray` is a live view the caller may reuse.
      return { kind: 'stream', body: new Uint8Array(body) };
    }
    case TRANSPORT_KIND_CONTROL:
      return { kind: 'control', value: decodeControlBody(body) };
    default:
      throw new NoiseTransportError('unknown transport kind');
  }
}

/** UTF-8 JSON, NUL-padded to exactly {@link CONTROL_PAYLOAD_SIZE}. */
function encodeControlBody(value: Record<string, unknown>): Uint8Array {
  const json = utf8Encode(JSON.stringify(value));
  if (json.length > CONTROL_PAYLOAD_SIZE) {
    throw new NoiseTransportError('control message exceeds the control payload size');
  }
  const body = new Uint8Array(CONTROL_PAYLOAD_SIZE);
  body.set(json);
  return body;
}

function decodeControlBody(body: Uint8Array): Record<string, unknown> {
  if (body.length !== CONTROL_PAYLOAD_SIZE) {
    throw new NoiseTransportError('control body is not the control payload size');
  }
  let end = body.length;
  while (end > 0 && body[end - 1] === 0) end--;
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decode(body.subarray(0, end)));
  } catch {
    throw new NoiseTransportError('control message is not JSON');
  }
  // A plain object only: an array or a bare number would reach consumers that
  // read named fields off whatever they were handed.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new NoiseTransportError('control message is not an object');
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The application byte stream

/** Split one application message into stream bodies, length prefix included. */
export function chunkAppMessage(message: Uint8Array): Uint8Array[] {
  if (message.length > MAX_APP_MESSAGE_LENGTH) {
    throw new NoiseTransportError('application message exceeds the 1 MiB cap');
  }
  const framed = new Uint8Array(APP_LENGTH_PREFIX_SIZE + message.length);
  writeUint32BE(framed, 0, message.length);
  framed.set(message, APP_LENGTH_PREFIX_SIZE);
  const bodies: Uint8Array[] = [];
  for (let offset = 0; offset < framed.length; offset += MAX_STREAM_BODY_LENGTH) {
    bodies.push(framed.subarray(offset, offset + MAX_STREAM_BODY_LENGTH));
  }
  return bodies;
}

/**
 * The most a drained reassembler keeps rather than releasing: one maximal
 * stream body and its length prefix. Ordinary traffic never reallocates, and a
 * session that once carried a 1 MiB message does not hold that megabyte for the
 * rest of its life.
 */
const RETAINED_BUFFER_CAPACITY = MAX_STREAM_BODY_LENGTH + APP_LENGTH_PREFIX_SIZE;

/**
 * The most a reassembler can ever hold: it stops accepting at one maximal
 * message plus its prefix, and the body that carries it past that point is
 * itself capped. Growth is clamped here so no arithmetic can outrun the bound.
 */
const MAX_BUFFER_CAPACITY =
  APP_LENGTH_PREFIX_SIZE + MAX_APP_MESSAGE_LENGTH + MAX_STREAM_BODY_LENGTH;

/** The first capacity a growing buffer takes, before doubling. */
const INITIAL_BUFFER_CAPACITY = 1024;

/**
 * Reassemble stream bodies, in order, into complete application messages.
 *
 * Every failure is terminal for the session that owns it: a declared length
 * over the cap means the peer is not speaking this framing, and there is no
 * resynchronization point in a byte stream to recover to.
 *
 * **Bodies are compacted into one geometrically-grown buffer**, never queued
 * one array entry per body: a per-body queue is bounded in bytes and unbounded
 * in *entries*, and a megabyte declared and delivered a byte at a time cost
 * 234 MB of live `Uint8Array` headers (measured 2026-08). Re-concatenating on
 * every arrival instead would be quadratic.
 */
export class StreamReassembler {
  #buffer = EMPTY;
  /** First undrained byte of {@link #buffer}. */
  #start = 0;
  /** One past the last undrained byte. */
  #end = 0;
  /**
   * Latched by the first failure, because every failure here is terminal and
   * this class is exported on its own: a caller that keeps pushing after one
   * must keep getting the same {@link NoiseTransportError}, not grow past the
   * bound and eventually throw a bare `RangeError` out of a typed-array write.
   * Inside a session `#requireLive` gets there first.
   */
  #failed = false;

  /** Backing bytes held right now — what the memory bound's own test reads. */
  get capacity(): number {
    return this.#buffer.length;
  }

  /** Undrained bytes, always under one maximal message plus one body. */
  get queued(): number {
    return this.#end - this.#start;
  }

  /** Accept one stream body; returns the messages it completed, in order. */
  push(body: Uint8Array): Uint8Array[] {
    if (this.#failed) throw new NoiseTransportError('reassembly already failed');
    if (body.length > MAX_STREAM_BODY_LENGTH) {
      throw this.#fail('stream body exceeds one Noise message');
    }
    if (body.length > 0) this.#append(body);
    const messages: Uint8Array[] = [];
    for (;;) {
      if (this.queued < APP_LENGTH_PREFIX_SIZE) break;
      // The declared length is what bounds the buffer: this loop only ever
      // stops holding fewer than `APP_LENGTH_PREFIX_SIZE + length` bytes, so
      // rejecting an over-cap length here is what keeps it under one maximal
      // message. A separate capacity check would never fire.
      const length = readUint32BE(this.#buffer, this.#start);
      if (length > MAX_APP_MESSAGE_LENGTH) {
        throw this.#fail('application message exceeds the 1 MiB cap');
      }
      if (this.queued < APP_LENGTH_PREFIX_SIZE + length) break;
      const from = this.#start + APP_LENGTH_PREFIX_SIZE;
      // Copied out: the caller keeps this past the next push, which reuses the
      // bytes behind it.
      messages.push(this.#buffer.slice(from, from + length));
      this.#start = from + length;
    }
    if (this.#start === this.#end) this.#drain();
    return messages;
  }

  /**
   * Copy one body in, moving the live window to the front or doubling the
   * buffer when it no longer fits behind it.
   */
  #append(body: Uint8Array): void {
    if (this.#end + body.length > this.#buffer.length) {
      const live = this.queued;
      const needed = live + body.length;
      if (needed <= this.#buffer.length) {
        this.#buffer.copyWithin(0, this.#start, this.#end);
      } else {
        const grown = new Uint8Array(
          Math.min(
            MAX_BUFFER_CAPACITY,
            Math.max(needed, this.#buffer.length * 2, INITIAL_BUFFER_CAPACITY),
          ),
        );
        grown.set(this.#buffer.subarray(this.#start, this.#end));
        this.#buffer = grown;
      }
      this.#start = 0;
      this.#end = live;
    }
    this.#buffer.set(body, this.#end);
    this.#end += body.length;
  }

  /** Latch the failure, release the buffer, and hand back what to throw. */
  #fail(why: string): NoiseTransportError {
    this.#failed = true;
    this.#buffer = EMPTY;
    this.#start = 0;
    this.#end = 0;
    return new NoiseTransportError(why);
  }

  /** Nothing is queued: rewind, and release a buffer one big message grew. */
  #drain(): void {
    this.#start = 0;
    this.#end = 0;
    if (this.#buffer.length > RETAINED_BUFFER_CAPACITY) this.#buffer = EMPTY;
  }
}

// ---------------------------------------------------------------------------
// The session

/**
 * What one received transport message turned out to be: a plaintext, with the
 * `stream` arm replaced by the messages it completed (none, mid-message).
 */
export type TransportReceipt =
  | Exclude<TransportPlaintext, { readonly kind: 'stream' }>
  | { readonly kind: 'app'; readonly messages: readonly Uint8Array[] };

/**
 * One established E2E session: the two directional `CipherState`s from `Split`,
 * the handshake hash the application authenticates against, and the framing
 * above.
 *
 * **The first failure is permanent** (relay.md -> E2E framing): a decrypt
 * failure, a nonce gap or reorder, or a framing violation poisons the session
 * and every later call throws. A session that kept going after one rejected
 * frame would be one an attacker can steer by dropping frames.
 *
 * The exception is a caller handing `sendControl` or `sendApp` something too
 * big: that is refused before the first `encryptWithAd`, so no ciphertext
 * exists, no counter moved, and the stream is exactly as synchronized as it
 * was. Killing the session there would turn a caller's size error into a
 * re-handshake — which costs fresh user presence.
 */
export class NoiseTransportSession {
  readonly #send: NoiseCipherState;
  readonly #receive: NoiseCipherState;
  readonly #handshakeHash: Uint8Array;
  readonly #reassembler = new StreamReassembler();
  #poison: string | undefined;

  constructor(session: NoiseSession) {
    this.#send = session.send;
    this.#receive = session.receive;
    this.#handshakeHash = new Uint8Array(session.handshakeHash);
  }

  /** Noise's final handshake hash — what application authentication binds to. */
  get handshakeHash(): Uint8Array {
    return new Uint8Array(this.#handshakeHash);
  }

  get isPoisoned(): boolean {
    return this.#poison !== undefined;
  }

  /** The counter the receive direction expects next — a test's reorder evidence. */
  get receiveNonce(): bigint {
    return this.#receive.nonce;
  }

  sendKeepalive(): Uint8Array {
    return this.#guarded(() => this.#encrypt({ kind: 'keepalive' }));
  }

  sendControl(value: Record<string, unknown>): Uint8Array {
    this.#requireLive();
    // Encoded outside the guard: an over-size value is the caller's error, and
    // refusing it must not destroy a session that has emitted nothing.
    const plaintext = encodeTransportPlaintext({ kind: 'control', value });
    return this.#guarded(() => this.#send.encryptWithAd(EMPTY, plaintext));
  }

  /** One application message as one or more transport ciphertexts, in order. */
  sendApp(message: Uint8Array): Uint8Array[] {
    this.#requireLive();
    const bodies = chunkAppMessage(message);
    return this.#guarded(() => bodies.map((body) => this.#encrypt({ kind: 'stream', body })));
  }

  receive(ciphertext: Uint8Array): TransportReceipt {
    return this.#guarded(() => {
      const frame = decodeTransportPlaintext(this.#receive.decryptWithAd(EMPTY, ciphertext));
      if (frame.kind !== 'stream') return frame;
      return { kind: 'app', messages: this.#reassembler.push(frame.body) };
    });
  }

  #encrypt(frame: TransportPlaintext): Uint8Array {
    return this.#send.encryptWithAd(EMPTY, encodeTransportPlaintext(frame));
  }

  #requireLive(): void {
    if (this.#poison !== undefined) {
      throw new NoiseTransportError(`session is destroyed: ${this.#poison}`);
    }
  }

  #guarded<T>(run: () => T): T {
    this.#requireLive();
    try {
      return run();
    } catch (error) {
      this.#poison = error instanceof Error ? error.message : 'transport failure';
      throw error instanceof NoiseError ? error : new NoiseTransportError('transport failure');
    }
  }
}
