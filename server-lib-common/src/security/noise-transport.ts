/**
 * What rides inside a Noise transport message once `Split` has run
 * (`docs/specs/server.md` -> Relay -> "E2E framing").
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
 * The connection prologue: the E2E version, the ceremony kind, the `hostId`,
 * and this connection's id. Both sides build it from the same routing values
 * they put on the envelope, so a handshake replayed against another Host, id,
 * or ceremony fails at message 1.
 */
export function e2eConnectionPrologue(hostId: string, connectionId: string): Uint8Array {
  return e2ePrologue('connection', hostId, [connectionId]);
}

/**
 * The pairing prologue: the version, the kind, the `hostId`, and every
 * invitation field in the order the QR carries them.
 *
 * Positional, and the order is `pairingInvitationFields`' to say
 * (`security/pairing-invitation.ts`) — kept out of this layer so the encoding
 * and the grammar it binds stay in one file each.
 */
export function e2ePairingPrologue(
  hostId: string,
  invitationFields: readonly string[],
): Uint8Array {
  return e2ePrologue('pairing', hostId, invitationFields);
}

// `kind` is the `E2eKind` of the envelope this transcript binds; spelled as a
// literal union because `remote/wire.ts` imports this layer, not the reverse.
function e2ePrologue(
  kind: 'connection' | 'pairing',
  hostId: string,
  extra: readonly string[],
): Uint8Array {
  return lengthPrefixedConcat([
    utf8Encode(E2E_PROLOGUE_DOMAIN),
    utf8Encode(kind),
    utf8Encode(hostId),
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
 * Reassemble stream bodies, in order, into complete application messages.
 *
 * Every failure is terminal for the session that owns it: a declared length
 * over the cap, or a buffer that would grow past one maximal message, means the
 * peer is not speaking this framing, and there is no resynchronization point in
 * a byte stream to recover to.
 *
 * Bodies are queued and copied once, when a message completes, rather than
 * concatenated on arrival. `MAX_STREAM_BODY_LENGTH` is a maximum, not a
 * minimum: a peer may legally split one 1 MiB message into single-byte bodies,
 * and re-concatenating a growing buffer on each of those is quadratic —
 * seconds of blocking memcpy on the process that also owns the terminal UI.
 */
export class StreamReassembler {
  /**
   * Bodies received and not yet drained. Consumed via {@link #head} rather than
   * `shift()`, which memmoves the whole array and would restore the quadratic
   * term this design exists to remove.
   */
  #queue: Uint8Array[] = [];
  #head = 0;
  /** Total undrained bytes across the live tail of {@link #queue}. */
  #queued = 0;

  /** Accept one stream body; returns the messages it completed, in order. */
  push(body: Uint8Array): Uint8Array[] {
    if (body.length > MAX_STREAM_BODY_LENGTH) {
      throw new NoiseTransportError('stream body exceeds one Noise message');
    }
    if (body.length > 0) {
      // Copied for the same reason `decodeTransportPlaintext` copies, and
      // because a queued body outlives the call that delivered it.
      this.#queue.push(new Uint8Array(body));
      this.#queued += body.length;
    }
    const messages: Uint8Array[] = [];
    for (;;) {
      if (this.#queued < APP_LENGTH_PREFIX_SIZE) break;
      // The declared length is what bounds the queue: this loop only ever
      // stops holding fewer than `APP_LENGTH_PREFIX_SIZE + length` bytes, so
      // rejecting an over-cap length here is what keeps the queue under one
      // maximal message. A separate queue check would never fire.
      const length = readUint32BE(this.#take(APP_LENGTH_PREFIX_SIZE, false));
      if (length > MAX_APP_MESSAGE_LENGTH) {
        throw new NoiseTransportError('application message exceeds the 1 MiB cap');
      }
      if (this.#queued < APP_LENGTH_PREFIX_SIZE + length) break;
      this.#take(APP_LENGTH_PREFIX_SIZE, true);
      messages.push(this.#take(length, true));
    }
    return messages;
  }

  /**
   * The next `count` queued bytes, copied out. `consume` also removes them —
   * the caller peeks a length prefix before it knows whether the message it
   * announces has arrived.
   */
  #take(count: number, consume: boolean): Uint8Array {
    const out = new Uint8Array(count);
    let filled = 0;
    let index = this.#head;
    while (filled < count) {
      const chunk = this.#queue[index]!;
      const size = Math.min(chunk.length, count - filled);
      out.set(chunk.subarray(0, size), filled);
      filled += size;
      if (!consume) {
        index++;
        continue;
      }
      if (size < chunk.length) {
        this.#queue[index] = chunk.subarray(size);
      } else {
        this.#queue[index] = EMPTY; // release the body's buffer
        index++;
      }
    }
    if (!consume) return out;
    this.#head = index;
    this.#queued -= count;
    if (this.#head === this.#queue.length) {
      this.#queue = [];
      this.#head = 0;
    }
    return out;
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
 * **The first failure is permanent** (server.md -> E2E framing): a decrypt
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
