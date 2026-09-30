/**
 * The host's half of the network policy's address math
 * (`docs/specs/remote-network.md` -> "Policy"): canonical CIDRs, whether an
 * address falls inside some of them, and this machine's interfaces as the
 * Allowed networks list offers them. Node-only; the shapes are
 * `lib/src/remote/network-policy.ts`'s.
 */

import { BlockList, isIP } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo as OsAddress } from 'node:os';
import type { NetworkInterfaceInfo } from '../../remote/network-policy';

interface Cidr {
  family: 'ipv4' | 'ipv6';
  /** The network address, masked to `prefix` and spelled canonically. */
  network: string;
  prefix: number;
}

/**
 * IPv6 as `new URL` serializes it (RFC 5952: lower case, the longest zero run
 * compressed, an embedded IPv4 tail in hex), or `null` for text that is not one.
 */
function serializeIpv6(address: string): string | null {
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/** The eight 16-bit groups of an IPv6 address {@link serializeIpv6} spelled. */
function ipv6Groups(serialized: string): number[] {
  const [head, tail] = serialized.split('::') as [string, string | undefined];
  const parse = (part: string | undefined) => (part ? part.split(':').map((group) => parseInt(group, 16)) : []);
  const front = parse(head);
  const back = parse(tail);
  return [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
}

/** Zero every bit past `prefix` in big-endian `units` of `width` bits each. */
function mask(units: number[], width: number, prefix: number): number[] {
  return units.map((unit, index) => {
    const kept = Math.min(width, Math.max(0, prefix - index * width));
    return kept === 0 ? 0 : unit & ~((1 << (width - kept)) - 1);
  });
}

function parseCidr(text: string): Cidr | null {
  const slash = text.indexOf('/');
  const address = text.slice(0, slash);
  const prefixText = text.slice(slash + 1);
  if (slash < 0 || !/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  // `isIP` accepts a zone (`fe80::1%en0`), which names an interface, not a range.
  if (address.includes('%')) return null;
  const family = isIP(address);
  if (family === 4 && prefix <= 32) {
    const octets = mask(address.split('.').map(Number), 8, prefix);
    return { family: 'ipv4', network: octets.join('.'), prefix };
  }
  const serialized = family === 6 && prefix <= 128 ? serializeIpv6(address) : null;
  if (serialized === null) return null;
  const groups = mask(ipv6Groups(serialized), 16, prefix);
  const network = serializeIpv6(groups.map((group) => group.toString(16)).join(':'));
  return network === null ? null : { family: 'ipv6', network, prefix };
}

/**
 * The canonical spelling of a CIDR — its network address masked to the prefix,
 * IPv6 as RFC 5952 writes it — or `null` for anything that is not one. The
 * policy stores only canonical CIDRs, so a CIDR is canonical when this returns
 * it unchanged.
 */
export function canonicalCidr(text: string): string | null {
  const cidr = parseCidr(text);
  return cidr && `${cidr.network}/${cidr.prefix}`;
}

function blockListOf(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const text of cidrs) {
    const cidr = parseCidr(text);
    if (cidr) list.addSubnet(cidr.network, cidr.prefix, cidr.family);
  }
  return list;
}

/**
 * {@link addressAllowed} over one list, which is parsed once: for a caller
 * testing many addresses against the same networks.
 */
export function allowedAddressTest(cidrs: readonly string[]): (address: string) => boolean {
  const list = blockListOf(cidrs);
  return (address) => {
    const family = isIP(address);
    if (family === 0 || address.includes('%')) return false;
    return list.check(address, family === 4 ? 'ipv4' : 'ipv6');
  };
}

/**
 * Whether `address` is an IP literal inside one of `cidrs`. A hostname, an mDNS
 * name, or a zoned address is in none; a CIDR that does not parse matches
 * nothing. An IPv4-mapped IPv6 address matches its IPv4 range: `BlockList`
 * compares it as IPv4, which `network-interfaces.test.ts` pins.
 */
export function addressAllowed(address: string, cidrs: readonly string[]): boolean {
  return allowedAddressTest(cidrs)(address);
}

const VPN_NAME = /^(utun|tun|wg|tailscale)/i;
/** Bridge, container, and VM interfaces; `veth` also covers Windows' `vEthernet`. */
const VIRTUAL_NAME = /^(bridge|docker|vmnet|vboxnet|veth|br-|virbr)/i;
/** Tailscale's two ranges, the ones its host routes widen to. */
const TAILNET_RANGES = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'].map((range) => ({
  range,
  contains: allowedAddressTest([range]),
}));
const tailnetRangeOf = (address: string) => TAILNET_RANGES.find(({ contains }) => contains(address));
/**
 * Tailscale's own IPv6 range, which marks its interface whatever the OS named
 * it. Its IPv4 range is CGNAT's, which a carrier or another VPN draws from too.
 */
const isTailnetV6 = TAILNET_RANGES[1]!.contains;
const TAILSCALE_NAME = /^tailscale/i;
const isIpv6LinkLocal = allowedAddressTest(['fe80::/10']);

/**
 * Whether one `os.networkInterfaces()` address is one this machine offers a
 * phone: neither loopback nor otherwise internal, nor IPv6 link-local.
 */
export function isOfferedAddress(entry: OsAddress): boolean {
  return !entry.internal && !isIpv6LinkLocal(entry.address);
}

/**
 * The network one address offers: its own prefix, or — for an address of a
 * Tailscale interface reported as a host route, which admits no other device —
 * the tailnet range it is drawn from (`docs/specs/remote-network.md` -> "Policy").
 */
function offeredPrefix(entry: OsAddress, tailnet: boolean): string | null {
  const canonical = entry.cidr === null ? null : canonicalCidr(entry.cidr);
  // By the address, never `family`, which Node 18.0–18.3 reported as a number.
  const hostRoute = canonical?.endsWith(isIP(entry.address) === 4 ? '/32' : '/128');
  return (tailnet && hostRoute && tailnetRangeOf(entry.address)?.range) || canonical;
}

const LABELS: Record<NetworkInterfaceInfo['kind'], string> = {
  lan: 'Local network',
  vpn: 'VPN',
  virtual: 'Virtual network',
};

/**
 * `os.networkInterfaces()` as the Allowed networks list offers it: loopback and
 * other internal interfaces left out, each address's own netmask as a canonical
 * prefix ({@link offeredPrefix}), IPv6 link-local left out, and an interface
 * with no prefix left dropped.
 */
export function classifyNetworkInterfaces(
  raw: NodeJS.Dict<OsAddress[]>,
): NetworkInterfaceInfo[] {
  const interfaces: NetworkInterfaceInfo[] = [];
  for (const [id, addresses] of Object.entries(raw)) {
    const offered = (addresses ?? []).filter(isOfferedAddress);
    const tailscale = TAILSCALE_NAME.test(id) || offered.some((entry) => isTailnetV6(entry.address));
    const prefixes = new Set<string>();
    for (const entry of offered) {
      const prefix = offeredPrefix(entry, tailscale);
      if (prefix) prefixes.add(prefix);
    }
    if (prefixes.size === 0) continue;
    const kind = tailscale || VPN_NAME.test(id) ? 'vpn' : VIRTUAL_NAME.test(id) ? 'virtual' : 'lan';
    interfaces.push({ id, label: tailscale ? 'Tailscale' : LABELS[kind], kind, prefixes: [...prefixes] });
  }
  return interfaces;
}

/**
 * This machine's interfaces, now. **Never throws**: a platform that will not
 * list them offers none, and `networkPolicy` still answers.
 */
export function listNetworkInterfaces(): NetworkInterfaceInfo[] {
  try {
    return classifyNetworkInterfaces(networkInterfaces());
  } catch (error) {
    console.warn('[burrow] could not list network interfaces', error);
    return [];
  }
}
