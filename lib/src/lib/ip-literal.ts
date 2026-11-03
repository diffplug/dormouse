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

/** A literal's 16 bytes, in any IPv6 spelling, bracketed or zoned or not, or null. */
export function ipv6Bytes(hostname: string): number[] | null {
  let h = hostname.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  if (!h.includes(':')) return null;
  const tail = h.slice(h.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    h = `${h.slice(0, -tail.length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const sides = h.split('::');
  if (sides.length > 2) return null;
  const [head, rest] = sides.map((side) => (side ? side.split(':') : []));
  const missing = 8 - head.length - (rest?.length ?? 0);
  if (rest ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...(rest ?? [])];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.flatMap((group) => {
    const value = parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

const u32 = (b: readonly number[], at: number): number =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

const allZero = (b: readonly number[], from: number, to: number): boolean =>
  b.slice(from, to).every((byte) => byte === 0);

// The 32-bit IPv4 address an IPv4-mapped or IPv4-compatible IPv6 literal names
// (::ffff:169.254.169.254, ::ffff:a9fe:a9fe, ::169.254.169.254), or null if this
// isn't such an address. `::` and `::1` are themselves, not IPv4 compatible.
function embeddedIPv4(h: string): number | null {
  const b = ipv6Bytes(h);
  if (!b || !allZero(b, 0, 10)) return null;
  const v4 = u32(b, 12);
  if (b[10] === 0xff && b[11] === 0xff) return v4;
  return b[10] === 0 && b[11] === 0 && v4 > 0xffff ? v4 : null;
}

/**
 * Every IPv4 address an IPv6 literal's bytes hand to a router or translator, by
 * the transition forms that carry one. For a guard: a literal may match a form
 * only by its shape, so these name where it could end up, not where it does.
 */
export function ipv4sCarriedByIPv6(b: readonly number[]): number[] {
  const carried: number[] = [];
  const [g0, g1] = [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
  // The low 32 bits under any /96 ending in zeros: IPv4-compatible and every NAT64
  // prefix of that shape (RFC 6052), 64:ff9b::/96 among them; then mapped and
  // translated, which spend those zeros on ffff.
  if (allZero(b, 8, 12)) carried.push(u32(b, 12));
  if (allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) carried.push(u32(b, 12));
  if (allZero(b, 0, 8) && b[8] === 0xff && b[9] === 0xff && allZero(b, 10, 12)) carried.push(u32(b, 12));
  // Local-use NAT64 64:ff9b:1::/48 at RFC 6052's shorter lengths, which skip byte 8.
  if (g0 === 0x64 && g1 === 0xff9b && b[4] === 0 && b[5] === 1) {
    for (const start of [6, 7, 9]) {
      const bytes = b.filter((_, i) => i >= start && i !== 8).slice(0, 4);
      carried.push(u32(bytes, 0));
    }
  }
  // 6to4, 2002::/16.
  if (g0 === 0x2002) carried.push(u32(b, 2));
  // Teredo, 2001::/32: the server's address, then the client's with its bits flipped.
  if (g0 === 0x2001 && g1 === 0) carried.push(u32(b, 4), ~u32(b, 12) >>> 0);
  // ISATAP's interface identifier on any prefix.
  if ((b[8] & ~0x02) === 0 && b[9] === 0 && b[10] === 0x5e && b[11] === 0xfe) carried.push(u32(b, 12));
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
