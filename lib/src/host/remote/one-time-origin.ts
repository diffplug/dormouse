/**
 * Whether this build may open a one-time connection's rendezvous
 * (`docs/specs/one-time.md` -> "Service and hosts"): only a Hosted build,
 * whose baked relay origin is where links are made (`bakedRelayOrigin` in
 * `lib/src/host/relay-origin.ts`).
 */

import type { OneTimeUnavailableReason } from '../../remote/burrow/one-time-runtime';
import { isAcceptedRelayOrigin, type RelayMode } from '../relay-origin';

/**
 * Why this build offers no one-time connection, or `null` when it does.
 *
 * - **`self-host`**: a self-host build, whose one origin is the user's own
 *   Relay, which serves no rendezvous — and which reaches nothing of
 *   Dormouse's in the background (`docs/specs/relay.md` → "Relay origin").
 * - **`origin-invalid`**: not a bare HTTPS or loopback-HTTP origin of at most
 *   `MAX_RELAY_ORIGIN_LENGTH` characters, the rule a phone parses a link under
 *   and the longest a link fits. The build already refuses one; this is the
 *   runtime's own check before any socket.
 *
 * Decided before any socket exists: the service builds no runtime for an
 * origin this answers non-null for.
 */
export function oneTimeAvailability(origin: string, mode: RelayMode): OneTimeUnavailableReason | null {
  if (mode !== 'hosted') return 'self-host';
  return isAcceptedRelayOrigin(origin) ? null : 'origin-invalid';
}
