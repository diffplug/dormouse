/**
 * The Local networks level's hold on a direct path (`docs/specs/remote-network.md`
 * -> "Local networks"): the one address an attempt's socket binds, where there
 * is one, and the {@link DirectPathPolicy} that strips the Burrow's answer and
 * checks the selected pair. Node-only, like the address math it runs on.
 */

import { isIP } from 'node:net';
import type { NetworkInterfaceInfo as OsAddress } from 'node:os';
import type { DirectPathPolicy } from '../../remote/direct/direct-peer';
import { allowedAddressTest } from './network-interfaces';

const isLinkLocal = allowedAddressTest(['fe80::/10']);

/**
 * The one address an attempt's socket binds under Local networks, or `null` to
 * bind every interface. **Exactly one interface must carry allowed addresses**,
 * loopback and IPv6 link-local aside; its IPv4 address is preferred where it
 * has both families, and a family with more than one address binds nothing,
 * since there is no single address to choose.
 */
export function bindAddressFor(
  allowed: readonly string[],
  raw: NodeJS.Dict<OsAddress[]>,
): string | null {
  const inAllowed = allowedAddressTest(allowed);
  let only: { id: string; v4: string[]; v6: string[] } | null = null;
  for (const [id, addresses] of Object.entries(raw)) {
    for (const entry of addresses ?? []) {
      if (entry.internal || isLinkLocal(entry.address) || !inAllowed(entry.address)) continue;
      if (only && only.id !== id) return null;
      only ??= { id, v4: [], v6: [] };
      (isIP(entry.address) === 4 ? only.v4 : only.v6).push(entry.address);
    }
  }
  if (!only) return null;
  const family = only.v4.length > 0 ? only.v4 : only.v6;
  return family.length === 1 ? family[0]! : null;
}

/** `c=` and `a=candidate` lines, with the address each names. */
const CONNECTION_LINE = /^c=IN IP[46] (\S+)$/;
const CANDIDATE_LINE = /^a=candidate:\S+ \S+ \S+ \S+ (\S+) /;

/**
 * The Burrow's hold on one attempt under Local networks. **Both ends of the
 * selected pair must be IP literals inside `allowed`**: a hostname, an mDNS
 * name, or a pair the stack cannot report refuses, since only the Burrow's own
 * ICE agent is evidence. The answer loses every candidate outside `allowed`,
 * and a default connection address outside it becomes `0.0.0.0`.
 */
export function localNetworksPath(allowed: readonly string[]): DirectPathPolicy {
  const inAllowed = allowedAddressTest(allowed);
  return {
    describe(sdp) {
      const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
      let candidates = 0;
      const lines: string[] = [];
      for (const line of sdp.split(eol)) {
        const candidate = CANDIDATE_LINE.exec(line);
        if (candidate) {
          if (!inAllowed(candidate[1]!)) continue;
          candidates += 1;
        }
        const connection = CONNECTION_LINE.exec(line);
        lines.push(connection && !inAllowed(connection[1]!) ? 'c=IN IP4 0.0.0.0' : line);
      }
      return candidates === 0 ? null : lines.join(eol);
    },
    refusal(pair) {
      if (!pair) return 'the connection reports no selected candidate pair';
      if (pair.local === null || !inAllowed(pair.local)) {
        return 'the selected pair’s local end is not on an allowed network';
      }
      if (pair.remote === null || !inAllowed(pair.remote)) {
        return 'the selected pair’s remote end is not on an allowed network';
      }
      return null;
    },
  };
}
