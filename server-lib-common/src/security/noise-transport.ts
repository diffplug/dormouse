/**
 * What rides inside a Noise transport message once `Split` has run
 * (`docs/specs/server.md` -> Relay -> "E2E framing"): the kind byte, the
 * application byte stream and its 1 MiB reassembly cap, the fixed-size control
 * message, and the session wrapper that poisons itself on the first failure.
 *
 * Runtime-agnostic and shared: the Client, the Host, and the harness all frame
 * with this module, so none of them can disagree about what a transport
 * plaintext is. It knows nothing about the relay envelope that carries the
 * ciphertext — routing metadata is never authenticated application content.
 */

import { concatBytes, utf8Decode, utf8Encode, lengthPrefixedConcat } from './bytes.js';
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

/**
 * Every control message is padded to exactly this many bytes, so the ciphertext
 * length of a pairing outcome, a denial, and a presence proof are the same
 * number and the relay learns nothing from watching one go by.
 */
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

/**
 * The most a reassembler may hold: one maximal message and its length prefix.
 * Reached only transiently — complete messages are drained on every push.
 */
export const MAX_REASSEMBLY_BUFFER = APP_LENGTH_PREFIX_SIZE + MAX_APP_MESSAGE_LENGTH;

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
 * Reserved: the invitation grammar itself (invitation id, expiry, setup token,
 * invitation public key) lands with the pairing ceremony in
 * `docs/specs/remote-security-model.md` -> `## Future` -> **Scope:
 * e2e-client-host** stage 4, which replaces this positional array with the
 * parsed invitation. The binding rule — every field, length-prefixed, in
 * declared order — is already fixed here so stage 4 changes only the caller.
 */
export function e2ePairingPrologue(
  hostId: string,
  invitationFields: readonly string[],
): Uint8Array {
  return e2ePrologue('pairing', hostId, invitationFields);
}

function e2ePrologue(kind: string, hostId: string, extra: readonly string[]): Uint8Array {
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
      // Copied: Node hands a WebSocket frame over as a `Buffer`, whose
      // `subarray` is a live view into a buffer the caller may reuse.
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
export class StreamChunker {
  chunk(message: Uint8Array): Uint8Array[] {
    if (message.length > MAX_APP_MESSAGE_LENGTH) {
      throw new NoiseTransportError('application message exceeds the 1 MiB cap');
    }
    const framed = concatBytes(encodeUint32(message.length), message);
    const bodies: Uint8Array[] = [];
    for (let offset = 0; offset < framed.length; offset += MAX_STREAM_BODY_LENGTH) {
      bodies.push(framed.subarray(offset, offset + MAX_STREAM_BODY_LENGTH));
    }
    return bodies;
  }
}

/**
 * Reassemble stream bodies, in order, into complete application messages.
 *
 * Every failure is terminal for the session that owns it: a declared length
 * over the cap, or a buffer that would grow past one maximal message, means the
 * peer is not speaking this framing, and there is no resynchronization point in
 * a byte stream to recover to.
 */
export class StreamReassembler {
  #buffer: Uint8Array = EMPTY;

  /** Accept one stream body; returns the messages it completed, in order. */
  push(body: Uint8Array): Uint8Array[] {
    if (body.length > MAX_STREAM_BODY_LENGTH) {
      throw new NoiseTransportError('stream body exceeds one Noise message');
    }
    this.#buffer =
      this.#buffer.length === 0 ? new Uint8Array(body) : concatBytes(this.#buffer, body);
    const messages: Uint8Array[] = [];
    for (;;) {
      if (this.#buffer.length < APP_LENGTH_PREFIX_SIZE) break;
      const length = decodeUint32(this.#buffer);
      if (length > MAX_APP_MESSAGE_LENGTH) {
        throw new NoiseTransportError('application message exceeds the 1 MiB cap');
      }
      const end = APP_LENGTH_PREFIX_SIZE + length;
      if (this.#buffer.length < end) break;
      messages.push(new Uint8Array(this.#buffer.subarray(APP_LENGTH_PREFIX_SIZE, end)));
      this.#buffer = new Uint8Array(this.#buffer.subarray(end));
    }
    if (this.#buffer.length > MAX_REASSEMBLY_BUFFER) {
      throw new NoiseTransportError('reassembly buffer exceeds the 1 MiB cap');
    }
    return messages;
  }
}

function encodeUint32(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function decodeUint32(bytes: Uint8Array): number {
  return ((bytes[0]! << 24) >>> 0) + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!;
}

// ---------------------------------------------------------------------------
// The session

/** What one received transport message turned out to be. */
export type TransportReceipt =
  | { readonly kind: 'keepalive' }
  | { readonly kind: 'control'; readonly value: Record<string, unknown> }
  /** Zero or more complete application messages; a mid-message chunk yields none. */
  | { readonly kind: 'app'; readonly messages: readonly Uint8Array[] };

/**
 * One established E2E session: the two directional `CipherState`s from `Split`,
 * the handshake hash the application authenticates against, and the framing
 * above.
 *
 * **The first failure is permanent.** A decrypt failure, a nonce gap or reorder
 * (which Noise's counter turns into a decrypt failure), or a framing violation
 * poisons the session, and every later call throws. There is no resynchronizing
 * a stream cipher, and a session that kept going after one rejected frame would
 * be one an attacker can steer by dropping frames.
 */
export class NoiseTransportSession {
  readonly #send: NoiseCipherState;
  readonly #receive: NoiseCipherState;
  readonly #handshakeHash: Uint8Array;
  readonly #chunker = new StreamChunker();
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

  /** The next counter each direction will use; the reorder evidence a test reads. */
  get sendNonce(): bigint {
    return this.#send.nonce;
  }
  get receiveNonce(): bigint {
    return this.#receive.nonce;
  }

  sendKeepalive(): Uint8Array {
    return this.#guarded(() => this.#encrypt({ kind: 'keepalive' }));
  }

  sendControl(value: Record<string, unknown>): Uint8Array {
    return this.#guarded(() => this.#encrypt({ kind: 'control', value }));
  }

  /** One application message as one or more transport ciphertexts, in order. */
  sendApp(message: Uint8Array): Uint8Array[] {
    return this.#guarded(() =>
      this.#chunker.chunk(message).map((body) => this.#encrypt({ kind: 'stream', body })),
    );
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

  #guarded<T>(run: () => T): T {
    if (this.#poison !== undefined) {
      throw new NoiseTransportError(`session is destroyed: ${this.#poison}`);
    }
    try {
      return run();
    } catch (error) {
      this.#poison = error instanceof Error ? error.message : 'transport failure';
      throw error instanceof NoiseError ? error : new NoiseTransportError('transport failure');
    }
  }
}
