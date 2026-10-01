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

// Extract the 32-bit IPv4 address embedded in an IPv4-mapped or IPv4-compatible
// IPv6 literal (::ffff:169.254.169.254, ::ffff:a9fe:a9fe, ::169.254.169.254),
// or null if this isn't such an address.
function embeddedIPv4(h: string): number | null {
  const m = h.match(/^::(?:ffff:)?(.+)$/);
  if (!m) return null;
  const tail = m[1];
  if (tail.includes('.')) return parseIPv4(tail.slice(tail.lastIndexOf(':') + 1));
  const groups = tail.split(':');
  if (groups.length === 2 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
    return ((parseInt(groups[0], 16) << 16) >>> 0) + parseInt(groups[1], 16);
  }
  return null;
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
