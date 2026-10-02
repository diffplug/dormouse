/**
 * The one-time rendezvous wire contract
 * (`docs/specs/one-time.md` → "Wire contract"): the two socket routes Hosted
 * serves, the frames a room forwards, and the bounds, timings, and close codes
 * both ends and the room share.
 *
 * **A separate frame family, never an `E2eKind`.** Every frame here is
 * `t: 'one-time'` or `t: 'one-time-room'`, which no relay guard in `wire.ts`
 * admits, so neither the Relay nor `BurrowRuntime` can be driven into a
 * one-time ceremony; `scripts/e2e-lint.mjs` holds that textually.
 */

import { DEFAULT_PAIRING_TTL_MS } from '../security/pairing.js';
import {
  isE2eCiphertext,
  isE2eId,
  MAX_E2E_CIPHERTEXT_LENGTH,
  type E2eBurrowStep,
  type E2eClientStep,
} from './wire.js';

// ---------------------------------------------------------------------------
// Routes

/**
 * The two WebSocket routes on the one-time origin: the Burrow's mints a room,
 * the phone's joins one named by {@link ONE_TIME_ROOM_PARAM}.
 */
export const ONE_TIME_WS_ROUTES = {
  burrow: '/api/one-time/burrow',
  client: '/api/one-time/client',
} as const;

/** The query parameter the phone's socket names its room in. */
export const ONE_TIME_ROOM_PARAM = 'room';

// The page the phone opens is the link grammar's: `ONE_TIME_PAGE_PATH` in
// `security/one-time-link.ts`.

// ---------------------------------------------------------------------------
// Frames. One JSON frame per WS message, forwarded by the room verbatim.

/** Room → Burrow, exactly once and first: the room this socket owns. */
export interface OneTimeRoomFrame {
  t: 'one-time-room';
  /** Base64url of 16 bytes; the link's `roomId`. */
  roomId: string;
  /** Epoch ms after which no phone may join. */
  expiresAt: number;
}

/** Phone → Burrow, through the room: Noise message 1 (`init`), then transport. */
export interface OneTimeClientFrame {
  t: 'one-time';
  step: E2eClientStep;
  /** One base64url Noise message. The room never decodes it. */
  ct: string;
}

/** Burrow → phone, through the room: Noise message 2 (`response`), then transport. */
export interface OneTimeBurrowFrame {
  t: 'one-time';
  step: E2eBurrowStep;
  ct: string;
}

/** The largest epoch-seconds value a link's uint32 expiry may carry. */
const MAX_UINT32 = 0xffff_ffff;

/**
 * An `expiresAt` a link can be minted from: finite, positive epoch ms whose
 * whole seconds fit the link's uint32 expiry field.
 */
function isOneTimeExpiresAt(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    Math.floor(value / 1000) <= MAX_UINT32
  );
}

/** A plain object carrying exactly `count` own keys — the precondition of every guard here. */
function hasKeyCount(value: unknown, count: number): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === count
  );
}

/**
 * The shape guard a Burrow runs on the room's first frame. Exact keys: the
 * frame is the only thing the room says for itself, so nothing may ride along.
 */
export function isOneTimeRoomFrame(value: unknown): value is OneTimeRoomFrame {
  return (
    hasKeyCount(value, 3) &&
    value.t === 'one-time-room' &&
    isE2eId(value.roomId) &&
    isOneTimeExpiresAt(value.expiresAt)
  );
}

/**
 * The shape guard a Burrow runs on a phone-originated frame. Exact keys, and the
 * ciphertext scan last, since it is the only check that costs more than a
 * compare.
 */
export function isOneTimeClientFrame(value: unknown): value is OneTimeClientFrame {
  return (
    hasKeyCount(value, 3) &&
    value.t === 'one-time' &&
    (value.step === 'init' || value.step === 'transport') &&
    isE2eCiphertext(value.ct)
  );
}

/** The mirror guard a phone runs on a Burrow-originated frame. */
export function isOneTimeBurrowFrame(value: unknown): value is OneTimeBurrowFrame {
  return (
    hasKeyCount(value, 3) &&
    value.t === 'one-time' &&
    (value.step === 'response' || value.step === 'transport') &&
    isE2eCiphertext(value.ct)
  );
}

// ---------------------------------------------------------------------------
// Bounds and timings

/**
 * The longest raw frame text any party will parse or the room will forward:
 * one maximal ciphertext plus the fixed keys and punctuation. Measured on the
 * string before `JSON.parse`, for the reason `MAX_RELAY_TO_BURROW_FRAME_LENGTH`
 * is; every legal field is ASCII, so it bounds bytes and code units alike.
 */
export const MAX_ONE_TIME_FRAME_LENGTH = MAX_E2E_CIPHERTEXT_LENGTH + 512;

/**
 * The most frames one room forwards, both directions together. A room carries a
 * handshake, a confirmation, and the direct path's signals — never a session —
 * so this is far above a real handshake and far below any use as a pipe.
 */
export const MAX_ONE_TIME_FORWARDED = 32;

/** How long an unused link lives: the pairing invitation's window. */
export const ONE_TIME_LINK_TTL_MS = DEFAULT_PAIRING_TTL_MS;

/**
 * How long past the link's expiry a joined room may run. The room's hard
 * deadline is `expiresAt + ONE_TIME_EXPIRY_GRACE_MS`: the join and the
 * confirmation finish by the expiry, and the grace holds the direct deadline
 * (`DIRECT_ONLY_DEADLINE_MS`) of a confirmation made at the link's last second.
 */
export const ONE_TIME_EXPIRY_GRACE_MS = 45_000;

// ---------------------------------------------------------------------------
// Close codes, in the 4000-4999 application-private range beside
// `WS_CLOSE_BURROW_REPLACED` / `WS_CLOSE_BURROW_REVOKED`. Shared because each end
// keys fixed copy on them, and the room is the only party that knows which
// happened.

/** The link expired with no phone joined. */
export const WS_CLOSE_ONE_TIME_EXPIRED = 4010;
export const WS_CLOSE_ONE_TIME_EXPIRED_REASON = 'this link expired unused';

/** A phone already joined this room; a link admits one. */
export const WS_CLOSE_ONE_TIME_TAKEN = 4011;
export const WS_CLOSE_ONE_TIME_TAKEN_REASON = 'this link was already used';

/** No such room, or the room can no longer be joined. */
export const WS_CLOSE_ONE_TIME_UNAVAILABLE = 4012;
export const WS_CLOSE_ONE_TIME_UNAVAILABLE_REASON = 'this link is not available';

/** The other end's socket closed. */
export const WS_CLOSE_ONE_TIME_PEER_GONE = 4013;
export const WS_CLOSE_ONE_TIME_PEER_GONE_REASON = 'the other end left';

/** A phone joined, and the room's hard deadline passed before both ends left. */
export const WS_CLOSE_ONE_TIME_DEADLINE = 4014;
export const WS_CLOSE_ONE_TIME_DEADLINE_REASON = 'the handshake did not finish in time';

/** A binary frame, a frame over {@link MAX_ONE_TIME_FRAME_LENGTH}, or one past {@link MAX_ONE_TIME_FORWARDED}. */
export const WS_CLOSE_ONE_TIME_VIOLATION = 4015;
export const WS_CLOSE_ONE_TIME_VIOLATION_REASON = 'frame refused';
