/**
 * The direct path a Burrow runtime takes under the network policy
 * (`docs/specs/remote-network.md` -> "Anywhere"), and when a policy change
 * alters it. Host-side, beside the Local networks hold it builds.
 */

import type { DirectPeering } from '../../remote/direct/direct-peer';
import { burrowUsesStun, holdsToAllowedNetworks, type NetworkPolicy } from '../../remote/network-policy';
import { localNetworksPath } from './local-networks';
import type { BurrowDirectPeerFactory } from './native-direct-peer';

/**
 * The direct path a runtime opened or started under `policy` holds for its
 * life, both halves chosen here from that one policy: `createDirectPeer` bound
 * to gather through Cloudflare STUN only where {@link burrowUsesStun}, and
 * where {@link holdsToAllowedNetworks} the hold on each attempt. **No runtime
 * chooses either**: a change {@link samePaths} sees ends the runtime instead
 * (`BurrowService.#setNetworkPolicy`).
 */
export function directPeeringFor(
  policy: NetworkPolicy,
  createDirectPeer: BurrowDirectPeerFactory | undefined,
): DirectPeering {
  const stun = burrowUsesStun(policy.level);
  return {
    createPeer: createDirectPeer ? (pathPolicy) => createDirectPeer(pathPolicy, stun) : null,
    pathPolicy: holdsToAllowedNetworks(policy.level) ? localNetworksPath(policy.allowed) : undefined,
  };
}

/**
 * Whether two policies allow the same paths: the level, and where it
 * {@link holdsToAllowedNetworks}, the allowed networks as a set.
 */
export function samePaths(a: NetworkPolicy, b: NetworkPolicy): boolean {
  if (a.level !== b.level) return false;
  if (!holdsToAllowedNetworks(a.level)) return true;
  return a.allowed.length === b.allowed.length && a.allowed.every((cidr) => b.allowed.includes(cidr));
}
