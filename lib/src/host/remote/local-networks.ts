/**
 * The Local networks level's hold on a direct path (`docs/specs/remote-network.md`
 * -> "Local networks"): the {@link DirectPathPolicy} that picks the one address
 * an attempt's socket binds, where there is one, strips the Burrow's answer and
 * the phone's offer, and checks the selected pair. Node-only, like the address math it runs on.
 */

import { isIP } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo as OsAddress } from 'node:os';
import type { DirectPathPolicy } from '../../remote/direct/direct-peer';
import { allowedAddressTest, isOfferedAddress } from './network-interfaces';

/**
 * The one address of `raw` an attempt's socket binds under `allowed`, or `null`
 * to bind every interface: the spec's single-address rule, over the addresses
 * the Allowed networks list offers ({@link isOfferedAddress}).
 */
export function bindAddressFor(
  allowed: readonly string[],
  raw: NodeJS.Dict<OsAddress[]>,
): string | null {
  const inAllowed = allowedAddressTest(allowed);
  let only: { id: string; v4: string[]; v6: string[] } | null = null;
  for (const [id, addresses] of Object.entries(raw)) {
    for (const entry of addresses ?? []) {
      if (!isOfferedAddress(entry) || !inAllowed(entry.address)) continue;
      if (only && only.id !== id) return null;
      only ??= { id, v4: [], v6: [] };
      (isIP(entry.address) === 4 ? only.v4 : only.v6).push(entry.address);
    }
  }
  if (!only) return null;
  const family = only.v4.length > 0 ? only.v4 : only.v6;
  return family.length === 1 ? family[0]! : null;
}

/**
 * `sdp` with every candidate outside `inAllowed`, or with no address to read,
 * removed and a default address outside it written as `0.0.0.0`, and how many
 * candidates are left. Lines end at any of CRLF, LF, or CR and fields at the
 * C-locale whitespace libdatachannel splits on, never JavaScript's wider `\s`,
 * so no line the native parser reads as a candidate escapes this one; lines
 * rejoin with the first ending found.
 */
function keepAllowed(sdp: string, inAllowed: (address: string) => boolean): { sdp: string; candidates: number } {
  const eol = /\r\n|\r|\n/.exec(sdp)?.[0] ?? '\n';
  let candidates = 0;
  const lines: string[] = [];
  for (const line of sdp.split(/\r\n|\r|\n/)) {
    const fields = line.split(/[ \t\v\f]+/).filter((field) => field !== '');
    if (/^a=candidate:/i.test(fields[0] ?? '')) {
      const address = fields[4];
      if (!address || !inAllowed(address)) continue;
      candidates += 1;
    } else if (/^c=/i.test(fields[0] ?? '')) {
      const address = fields[2];
      if (!address || !inAllowed(address)) {
        lines.push('c=IN IP4 0.0.0.0');
        continue;
      }
    }
    lines.push(line);
  }
  return { sdp: lines.join(eol), candidates };
}

/**
 * Every range an address a phone reports could be private to some network:
 * RFC 1918, carrier-grade NAT, loopback, link-local, unspecified, and IPv6
 * unique-local. What is left is an address the internet routes.
 */
const isPrivateAddress = allowedAddressTest([
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
]);

const CANDIDATE_LINE = /^a=candidate:\S+ \S+ \S+ \S+ (\S+) /;

/**
 * The first candidate of `sdp` that is an IP literal outside every private
 * range — a phone's server-reflexive candidate, most often — and outside
 * `skip`, or `null`.
 */
export function firstPublicCandidate(sdp: string, skip: (address: string) => boolean = () => false): string | null {
  for (const line of sdp.split(/\r?\n/)) {
    const address = CANDIDATE_LINE.exec(line)?.[1];
    if (address === undefined || address.includes('%') || isIP(address) === 0) continue;
    if (!isPrivateAddress(address) && !skip(address)) return address;
  }
  return null;
}

/**
 * The Burrow's hold on one attempt under Local networks: the bind is read from
 * this machine's interfaces at the attempt, since a laptop moves between
 * networks, and a platform that will not list them binds nothing and leaves
 * the path check to decide. Both descriptions keep only candidates inside
 * `allowed`, and both ends of the selected pair must be IP literals inside it.
 */
export function localNetworksPath(allowed: readonly string[]): DirectPathPolicy {
  const inAllowed = allowedAddressTest(allowed);
  return {
    bindAddress() {
      try {
        return bindAddressFor(allowed, networkInterfaces());
      } catch {
        return null;
      }
    },
    describe(sdp) {
      const described = keepAllowed(sdp, inAllowed);
      return described.candidates === 0 ? null : described.sdp;
    },
    // A browser that offers only mDNS names is left none: its checks reach the
    // answer's candidates, and the pair forms peer-reflexive (rationale).
    acceptRemote: (sdp) => keepAllowed(sdp, inAllowed).sdp,
    // Never evidence: the phone wrote it, and nothing here decides on it.
    reportedAddress: (sdp) => firstPublicCandidate(sdp, inAllowed),
    // This end first: a phone's address says nothing while this machine is
    // itself off the allowed networks.
    refusal(pair) {
      if (!pair) return { reason: 'the connection reports no selected candidate pair', end: null };
      if (pair.local === null || !inAllowed(pair.local)) {
        return { reason: 'the selected pair’s local end is not on an allowed network', end: 'local' };
      }
      if (pair.remote === null || !inAllowed(pair.remote)) {
        return { reason: 'the selected pair’s remote end is not on an allowed network', end: 'remote' };
      }
      return null;
    },
  };
}
