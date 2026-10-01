/**
 * The frame layer both Relays route through (`docs/specs/relay.md` ->
 * "Routing"): the self-host `RelayHub` (`relay/src/relay.ts`) and Hosted's
 * `RelayRoom` (`hosted/server/relay-room.ts`). It reads the routing envelope
 * through the shared guards and rebuilds it field by field, copying the
 * ciphertext across unread. One copy, so the two Relays cannot answer a frame
 * differently.
 */

import { utf8Encode } from '../security/bytes.js';
import { randomBase64Url } from '../security/webcrypto.js';
import { MAX_RELAY_FRAME_BYTES } from './relay-common.js';
import {
  E2E_ID_BYTE_LENGTH,
  isE2eBurrowFrame,
  isE2eClientFrame,
  type E2eBurrowFrame,
  type E2eClientFrame,
  type RelayToBurrowFrame,
  type RelayToClientFrame,
} from './wire.js';

/**
 * A Client socket's `clientId`: a Relay-assigned secret of 16 random bytes,
 * stamped on every frame toward the Burrow and never sent to the Client.
 */
export const newClientId = (): string => randomBase64Url(E2E_ID_BYTE_LENGTH);

/** The `error` a Client frame that is not a JSON object with a string `t` gets. */
export const MALFORMED_FRAME_ERROR = 'malformed frame';
/** The `error` a Client frame whose `t` is not `e2e` gets. */
export const UNKNOWN_FRAME_TYPE_ERROR = 'unknown frame type';
/** The `error` an `e2e` Client frame failing `isE2eClientFrame` gets. */
export const MALFORMED_E2E_FRAME_ERROR = 'malformed e2e frame';

/** The `error` a Client frame naming a Burrow that holds no socket gets. */
export const offlineError = (burrowId: string): RelayToClientFrame => ({
  t: 'error',
  error: `burrow ${burrowId} is offline`,
});

/**
 * Whether a received text frame is over {@link MAX_RELAY_FRAME_BYTES} in UTF-8
 * bytes, the unit `ws`'s `maxPayload` counts on the self-host Relay. A frame
 * of at most a third of the bound in UTF-16 units is under it without encoding.
 */
export function exceedsRelayFrameBytes(raw: string): boolean {
  if (raw.length * 3 <= MAX_RELAY_FRAME_BYTES) return false;
  return raw.length > MAX_RELAY_FRAME_BYTES || utf8Encode(raw).byteLength > MAX_RELAY_FRAME_BYTES;
}

/** A Client frame's routing envelope, or the `error` frame it is answered with. */
export function readClientFrame(
  raw: string,
): { frame: E2eClientFrame } | { error: RelayToClientFrame } {
  const parsed = parseObject(raw);
  if (!parsed || typeof parsed.t !== 'string') return { error: relayError(MALFORMED_FRAME_ERROR) };
  if (parsed.t !== 'e2e') return { error: relayError(UNKNOWN_FRAME_TYPE_ERROR) };
  if (!isE2eClientFrame(parsed)) return { error: relayError(MALFORMED_E2E_FRAME_ERROR) };
  return { frame: parsed };
}

/** A Burrow frame's routing envelope, or `null`: a malformed one is dropped unanswered. */
export function readBurrowFrame(raw: string): E2eBurrowFrame | null {
  const parsed = parseObject(raw);
  return parsed && isE2eBurrowFrame(parsed) ? parsed : null;
}

/** A Client's frame toward its Burrow, rebuilt field by field with the Relay's `clientId`. */
export function toBurrowEnvelope(clientId: string, frame: E2eClientFrame): RelayToBurrowFrame {
  return {
    t: 'e2e',
    clientId,
    burrowId: frame.burrowId,
    kind: frame.kind,
    id: frame.id,
    step: frame.step,
    ct: frame.ct,
  };
}

/** A Burrow's frame toward a Client, rebuilt field by field: `clientId` dropped, `burrowId` stamped. */
export function toClientEnvelope(burrowId: string, frame: E2eBurrowFrame): RelayToClientFrame {
  return {
    t: 'e2e',
    burrowId,
    kind: frame.kind,
    id: frame.id,
    step: frame.step,
    ct: frame.ct,
  };
}

const relayError = (error: string): RelayToClientFrame => ({ t: 'error', error });

/** A raw text frame as a JSON object, or `null`. */
function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
