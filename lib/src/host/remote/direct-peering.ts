/**
 * The direct path a Burrow runtime takes under the network policy
 * (`docs/specs/remote-network.md` -> "Anywhere"), and when a policy change
 * alters it. Host-side, beside the Local networks hold it builds.
 */

import type { DirectPeering } from '../../remote/direct/direct-peer';
import { burrowUsesStun, holdsToAllowedNetworks, type NetworkLevel, type NetworkPolicy } from '../../remote/network-policy';
import { localNetworksPath } from './local-networks';
import type { BurrowDirectPeerFactory } from './native-direct-peer';

/**
 * The direct path a runtime opened or started under `level` holds for its
 * life: `createDirectPeer` bound to gather through Cloudflare STUN only where
 * {@link burrowUsesStun}, and where {@link holdsToAllowedNetworks} the hold on
 * each attempt, reading `allowed` — the policy's networks as they stand — at
 * each use. **No runtime chooses either**: a change {@link narrowsPaths} sees
 * ends the runtime instead (`BurrowService.#setNetworkPolicy`).
 */
export function directPeeringFor(
  level: NetworkLevel,
  allowed: () => readonly string[],
  createDirectPeer: BurrowDirectPeerFactory | undefined,
): DirectPeering {
  const stun = burrowUsesStun(level);
  return {
    createPeer: createDirectPeer ? (pathPolicy) => createDirectPeer(pathPolicy, stun) : null,
    pathPolicy: holdsToAllowedNetworks(level) ? localNetworksPath(allowed) : undefined,
  };
}

/**
 * Whether `next` takes away a path `previous` allowed: a change of level, or
 * where it {@link holdsToAllowedNetworks}, a network no longer allowed. Adding
 * one takes nothing away, and a live hold reads it.
 */
export function narrowsPaths(previous: NetworkPolicy, next: NetworkPolicy): boolean {
  if (previous.level !== next.level) return true;
  if (!holdsToAllowedNetworks(previous.level)) return false;
  return previous.allowed.some((cidr) => !next.allowed.includes(cidr));
}
