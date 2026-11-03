/**
 * Hostname classification shared by the webview and the Node host modules
 * (the iframe proxy's SSRF guard and error pages, the browser URL helpers).
 * Pure string parsing: nothing here resolves a name.
 */

// Parse one dotted-quad component with inet_aton semantics: hex (0x…), octal
// (leading 0), or decimal. Returns null for anything else.
function parseIPv4Part(part: string): number | null {
  if (/^0x[0-9a-f]+$/.test(part)) return parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return parseInt(part, 8);
  if (/^(0|[1-9][0-9]*)$/.test(part)) return parseInt(part, 10);
  return null;
}

// Parse a hostname as an IPv4 literal the way the OS resolver (getaddrinfo /
// inet_aton) would — including short forms and non-decimal encodings — so that
// 2852039166, 0xA9FEA9FE, 0251.0376.0251.0376 and 169.254.169.254 all collapse
// to the same 32-bit value. Returns null when the string isn't a numeric IPv4.
function parseIPv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    const n = parseIPv4Part(part);
    if (n === null) return null;
    nums.push(n);
  }
  // Every part but the last is a single byte; the last fills the remainder.
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i] > 0xff) return null;
  }
  const last = nums[nums.length - 1];
  if (last > Math.pow(256, 5 - nums.length) - 1) return null;
  let value = last;
  for (let i = 0; i < nums.length - 1; i++) {
    value += nums[i] * Math.pow(256, 3 - i);
  }
  return value >>> 0 === value ? value : null;
}

/** An address without brackets or a zone, lowercased. */
export const bareAddress = (address: string): string => address.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();

/**
 * IPv6 as `new URL` serializes it (RFC 5952: lower case, the longest zero run
 * compressed, an embedded IPv4 tail in hex), or `null` for text that is not one.
 */
export function serializeIpv6(address: string): string | null {
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/** The eight 16-bit groups of an IPv6 address {@link serializeIpv6} spelled. */
export function ipv6Groups(serialized: string): number[] {
  const [head, tail] = serialized.split('::') as [string, string | undefined];
  const parse = (part: string | undefined) => (part ? part.split(':').map((group) => parseInt(group, 16)) : []);
  const front = parse(head);
  const back = parse(tail);
  return [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
}

/**
 * A literal's 16 bytes, in any IPv6 spelling, bracketed or zoned or not, or null.
 * An IPv4 tail reads as `inet_aton` would, which the URL parser alone refuses.
 */
export function ipv6Bytes(hostname: string): number[] | null {
  let h = bareAddress(hostname);
  if (!h.includes(':')) return null;
  const tail = h.slice(h.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    h = `${h.slice(0, -tail.length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const serialized = serializeIpv6(h);
  return serialized === null ? null : ipv6Groups(serialized).flatMap((group) => [group >> 8, group & 0xff]);
}

const u32 = (b: readonly number[], at: number): number =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

const high64Zero = (b: readonly number[]): boolean => u32(b, 0) === 0 && u32(b, 4) === 0;

// The 32-bit IPv4 address an IPv4-mapped or IPv4-compatible IPv6 literal names
// (::ffff:169.254.169.254, ::ffff:a9fe:a9fe, ::169.254.169.254), or null if this
// isn't such an address. `::` and `::1` are themselves, not IPv4 compatible.
function embeddedIPv4(h: string): number | null {
  const b = ipv6Bytes(h);
  if (!b || !high64Zero(b)) return null;
  const [iid, v4] = [u32(b, 8), u32(b, 12)];
  return iid === 0xffff || (iid === 0 && v4 > 0xffff) ? v4 : null;
}

/**
 * Every IPv4 address an IPv6 literal's bytes hand to a router or translator, by
 * the transition forms that carry one. For a guard: a literal may match a form
 * only by its shape, so these name where it could end up, not where it does.
 */
export function ipv4sCarriedByIPv6(b: readonly number[]): number[] {
  const carried: number[] = [];
  const [prefix, iid, low] = [u32(b, 0), u32(b, 8), u32(b, 12)];
  // The low 32 bits: under any /96 ending in zeros (IPv4-compatible and every
  // NAT64 prefix of that shape, RFC 6052, 64:ff9b::/96 among them), mapped,
  // translated, and ISATAP's interface identifier on any prefix.
  const mappedOrTranslated = high64Zero(b) && (iid === 0xffff || iid === 0xffff0000);
  if (iid === 0 || mappedOrTranslated || (iid & ~0x02000000) === 0x5efe) carried.push(low);
  // Local-use NAT64 64:ff9b:1::/48 at RFC 6052's shorter lengths, which skip byte 8.
  if (prefix === 0x0064ff9b && b[4] === 0 && b[5] === 1) {
    const v4s = [...b.slice(6, 8), ...b.slice(9)];
    carried.push(u32(v4s, 0), u32(v4s, 1), u32(v4s, 2));
  }
  // 6to4, 2002::/16.
  if (prefix >>> 16 === 0x2002) carried.push(u32(b, 2));
  // Teredo, 2001::/32: the server's address, then the client's with its bits flipped.
  if (prefix === 0x20010000) carried.push(u32(b, 4), ~low >>> 0);
  return carried;
}

/** The 32-bit IPv4 address a hostname spells — in any inet_aton encoding, or
 *  embedded in an IPv4-mapped/compatible IPv6 literal, bracketed or not — or
 *  null. The WHATWG URL parser rewrites `::ffff:127.0.0.1` to a hex-group
 *  spelling, so a literal match would miss it. */
export function ipv4Value(hostname: string): number | null {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h.includes(':') ? embeddedIPv4(h) : parseIPv4(h);
}

/** Whether a hostname names this machine: `localhost`, `*.localhost` (browsers
 *  route it to loopback), `::1`, or 127.0.0.0/8 in any spelling. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const v4 = ipv4Value(h);
  return v4 !== null && v4 >>> 24 === 127;
}
