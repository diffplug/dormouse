/**
 * Web Push endpoint egress policy (docs/specs/server.md -> Web Push).
 *
 * Checking `https:` at registration is not enough: a literal private address,
 * or a public hostname that resolves to one later, would turn push delivery
 * into a blind POST primitive against the Server's network. Registration
 * rejects obvious local/literal targets; the HTTPS agent enforces the same
 * public-address rule on the DNS result used for each actual connection, so
 * DNS rebinding and mixed public/private answers cannot bypass it.
 */

import { lookup } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { Agent } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

// Separate lists matter: Node's BlockList maps an IPv4 address into
// `::ffff:0:0/96` even when `check(..., 'ipv4')` is requested, so combining the
// families would make the mapped-address deny range reject every IPv4 address.
const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();
const publicIpv6Addresses = new BlockList();

// IPv6 global unicast currently comes only from 2000::/3. Treat new allocations
// as denied until they are intentionally admitted rather than silently turning
// an unassigned or special-purpose range into an egress path.
publicIpv6Addresses.addSubnet('2000::', 3, 'ipv6');

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 96],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blockedIpv6Addresses.addSubnet(network, prefix, 'ipv6');
}

function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

/** True only for a routable public IPv4/IPv6 address. */
export function isPublicNetworkAddress(address: string): boolean {
  const normalized = unbracket(address);
  const family = isIP(normalized);
  if (family === 4) return !blockedIpv4Addresses.check(normalized, 'ipv4');
  if (family === 6) {
    return (
      publicIpv6Addresses.check(normalized, 'ipv6') &&
      !blockedIpv6Addresses.check(normalized, 'ipv6')
    );
  }
  return false;
}

/**
 * Cheap admission check. Hostnames are revalidated through DNS at connection
 * time; literals and the special localhost namespace can be rejected now.
 */
export function isPublicHttpsPushEndpoint(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  const hostname = unbracket(parsed.hostname).toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
  return isIP(hostname) === 0 || isPublicNetworkAddress(hostname);
}

type ResolveAll = (
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const systemResolveAll: ResolveAll = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, callback);
};

function blockedEndpointError(hostname: string, address?: string): NodeJS.ErrnoException {
  const detail = address ? ` (${address})` : '';
  const error = new Error(
    `push endpoint ${hostname}${detail} did not resolve exclusively to public addresses`,
  ) as NodeJS.ErrnoException;
  error.code = 'EPERM';
  return error;
}

/**
 * DNS lookup used by the actual TLS connection. Rejecting a hostname if *any*
 * answer is private prevents address-family selection from becoming a bypass.
 */
export function createPublicLookup(resolveAll: ResolveAll = systemResolveAll): LookupFunction {
  return (hostname, options, callback) => {
    resolveAll(hostname, options, (error, addresses) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      if (addresses.length === 0) {
        callback(blockedEndpointError(hostname), '', 0);
        return;
      }
      const blocked = addresses.find(({ address }) => !isPublicNetworkAddress(address));
      if (blocked) {
        callback(blockedEndpointError(hostname, blocked.address), '', 0);
        return;
      }
      if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0]!.address, addresses[0]!.family);
      }
    });
  };
}

/** HTTPS agent whose one connection-time DNS result is public-only and pinned. */
export function createPublicPushAgent(): Agent {
  return new Agent({ lookup: createPublicLookup() });
}
