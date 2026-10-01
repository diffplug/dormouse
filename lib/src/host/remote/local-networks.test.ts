/**
 * The Local networks hold on a direct path (`docs/specs/remote-network.md` ->
 * "Local networks"): which address an attempt binds, what the Burrow's answer
 * and the phone's offer keep, and which selected pairs may carry a session. The same policy on the
 * real addon is `native-direct-peer.test.ts`'s.
 */

import type { NetworkInterfaceInfo as OsAddress } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

/** What `os.networkInterfaces()` answers next, or `'throw'` for a platform that will not list them. */
const os = vi.hoisted(() => ({ interfaces: {} as NodeJS.Dict<OsAddress[]> | 'throw' }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  networkInterfaces: () => {
    if (os.interfaces === 'throw') throw new Error('uv_interface_addresses');
    return os.interfaces;
  },
}));

import { bindAddressFor, localNetworksPath } from './local-networks';

/** One `os.networkInterfaces()` address, with the fields the bind choice reads. */
function address(ip: string, internal = false): OsAddress {
  return {
    address: ip,
    netmask: '',
    family: ip.includes(':') ? 'IPv6' : 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: null,
    ...(ip.includes(':') ? { scopeid: 0 } : {}),
  } as OsAddress;
}

const LAN = ['192.168.86.0/24', 'fd65:c3d1:3e82:67d9::/64'];
const TAILNET = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'];

/** A laptop on Wi-Fi and a tailnet, with loopback and link-local beside them. */
const LAPTOP = {
  lo0: [address('127.0.0.1', true), address('::1', true)],
  en0: [
    address('fe80::4fc:4257:75e3:5e56'),
    address('192.168.86.160'),
    address('fd65:c3d1:3e82:67d9:18f0:7985:d3e0:19c0'),
  ],
  utun4: [address('100.97.229.25'), address('fd7a:115c:a1e0::4339:e51a')],
  bridge100: [address('192.168.64.1')],
};

describe('bindAddressFor', () => {
  it('binds the one allowed address', () => {
    expect(bindAddressFor(['192.168.86.0/24'], LAPTOP)).toBe('192.168.86.160');
    expect(bindAddressFor(['fd7a:115c:a1e0::/48'], LAPTOP)).toBe('fd7a:115c:a1e0::4339:e51a');
  });

  it('prefers the IPv4 address of the one interface allowed in both families', () => {
    expect(bindAddressFor(LAN, LAPTOP)).toBe('192.168.86.160');
    expect(bindAddressFor(TAILNET, LAPTOP)).toBe('100.97.229.25');
  });

  it('binds nothing where allowed addresses sit on more than one interface', () => {
    expect(bindAddressFor([...LAN, ...TAILNET], LAPTOP)).toBeNull();
    // One family each is still two interfaces, never the IPv4 one by preference.
    expect(bindAddressFor(['192.168.86.0/24', 'fd7a:115c:a1e0::/48'], LAPTOP)).toBeNull();
    // Overlapping ranges are two interfaces too, whichever the user meant.
    expect(bindAddressFor(['192.168.0.0/16'], LAPTOP)).toBeNull();
  });

  it('binds nothing where the preferred family has no single address', () => {
    const aliased = { en0: [address('192.168.86.160'), address('192.168.86.161')] };
    expect(bindAddressFor(['192.168.86.0/24'], aliased)).toBeNull();
    const temporary = {
      en0: [address('fd65:c3d1:3e82:67d9::a'), address('fd65:c3d1:3e82:67d9::b')],
    };
    expect(bindAddressFor(['fd65:c3d1:3e82:67d9::/64'], temporary)).toBeNull();
  });

  it('binds nothing where no address is allowed, loopback and link-local never counting', () => {
    expect(bindAddressFor([], LAPTOP)).toBeNull();
    expect(bindAddressFor(['10.0.0.0/8'], LAPTOP)).toBeNull();
    expect(bindAddressFor(['127.0.0.0/8', '::1/128'], LAPTOP)).toBeNull();
    // An allowed link-local range still leaves en0's other addresses the choice.
    expect(bindAddressFor(['fe80::/10', '192.168.86.0/24'], LAPTOP)).toBe('192.168.86.160');
    const selfAssigned = { ...LAPTOP, en11: [address('169.254.235.129')] };
    expect(bindAddressFor(['169.254.0.0/16', '192.168.86.0/24'], selfAssigned)).toBe('192.168.86.160');
  });
});

describe('localNetworksPath: the bind', () => {
  it('reads this machine’s interfaces at each attempt, binding nothing where it cannot list them', () => {
    const path = localNetworksPath(['192.168.86.0/24']);
    os.interfaces = LAPTOP;
    expect(path.bindAddress()).toBe('192.168.86.160');
    // The laptop moved: the next attempt binds what is there now.
    os.interfaces = { en0: [address('192.168.86.23')] };
    expect(path.bindAddress()).toBe('192.168.86.23');
    os.interfaces = 'throw';
    expect(path.bindAddress()).toBeNull();
  });
});

/** An answer as the addon writes one: every interface a candidate at one port. */
const ANSWER = [
  'v=0',
  'o=rtc 1781803978 0 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=application 64178 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 192.168.86.160',
  'a=mid:0',
  'a=ice-ufrag:9Y67',
  'a=candidate:2 1 UDP 2116026111 fd65:c3d1:3e82:67d9:18f0:7985:d3e0:19c0 64178 typ host',
  'a=candidate:4 1 UDP 2116025599 fd7a:115c:a1e0::4339:e51a 64178 typ host',
  'a=candidate:1 1 UDP 2114977791 192.168.86.160 64178 typ host',
  'a=candidate:3 1 UDP 2114977279 100.97.229.25 64178 typ host',
  'a=candidate:5 1 UDP 2114977279 0f1e2d3c-aaaa-bbbb-cccc-000000000000.local 64178 typ host',
  'a=end-of-candidates',
  '',
].join('\r\n');

const candidatesIn = (sdp: string) => sdp.split('\r\n').filter((line) => line.startsWith('a=candidate'));

describe('localNetworksPath', () => {
  it('keeps only the answer’s candidates on an allowed network', () => {
    const described = localNetworksPath(TAILNET).describe(ANSWER)!;

    expect(candidatesIn(described)).toEqual([
      'a=candidate:4 1 UDP 2116025599 fd7a:115c:a1e0::4339:e51a 64178 typ host',
      'a=candidate:3 1 UDP 2114977279 100.97.229.25 64178 typ host',
    ]);
    // The default address named a network it may not: the placeholder instead.
    expect(described).toContain('\r\nc=IN IP4 0.0.0.0\r\n');
    expect(described).not.toContain('192.168.86.160');
    // Every other line as it was, in order, line endings included.
    expect(described.split('\r\n').filter((line) => !/^(a=candidate|c=)/.test(line))).toEqual(
      ANSWER.split('\r\n').filter((line) => !/^(a=candidate|c=)/.test(line)),
    );
  });

  it('leaves an allowed default address alone', () => {
    const described = localNetworksPath(['192.168.86.0/24']).describe(ANSWER)!;
    expect(described).toContain('\r\nc=IN IP4 192.168.86.160\r\n');
    expect(candidatesIn(described)).toEqual([
      'a=candidate:1 1 UDP 2114977791 192.168.86.160 64178 typ host',
    ]);
  });

  it('refuses to describe an end with no candidate on an allowed network', () => {
    expect(localNetworksPath(['10.0.0.0/8']).describe(ANSWER)).toBeNull();
    expect(localNetworksPath([]).describe(ANSWER)).toBeNull();
  });

  it('accepts only the offer’s candidates that are IP addresses on an allowed network', () => {
    // A phone's offer: its Wi-Fi, its tailnet, a carrier address, and a browser's mDNS name.
    const offer = [
      'v=0',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 203.0.113.7',
      'a=candidate:1 1 udp 2113937151 192.168.86.23 51234 typ host',
      'a=candidate:2 1 udp 2113937151 100.101.7.8 51235 typ host',
      'a=candidate:3 1 udp 2113937151 203.0.113.7 51236 typ host',
      'a=candidate:4 1 udp 2113937151 0f1e2d3c-aaaa-bbbb-cccc-000000000000.local 51237 typ host',
      'a=end-of-candidates',
      '',
    ].join('\r\n');

    const accepted = localNetworksPath(LAN).acceptRemote(offer);
    expect(candidatesIn(accepted)).toEqual(['a=candidate:1 1 udp 2113937151 192.168.86.23 51234 typ host']);
    expect(accepted).toContain('\r\nc=IN IP4 0.0.0.0\r\n');
    expect(accepted).toContain('\r\na=end-of-candidates\r\n');

    // None left is still an offer to answer: the phone's own checks form the pair.
    expect(candidatesIn(localNetworksPath(['10.0.0.0/8']).acceptRemote(offer))).toEqual([]);
  });

  it('strips an offer’s off-network candidate however its whitespace and line endings are written', () => {
    // Each of these is a candidate toward 203.0.113.7 that the native stack still parses.
    const offer = [
      'v=0',
      'c=IN  IP4\t203.0.113.7',
      'a=candidate:1 1 udp 2113937151 192.168.86.23 51234 typ host',
      'a=candidate:2 1 udp 2113937151  203.0.113.7 51236 typ host',
      'a=candidate:3 1 udp 2113937151\t203.0.113.7 51237 typ host',
      'a=candidate:4 1 udp 2113937151 192.168.86.23 51238 typ host\na=candidate:5 1 udp 2113937151 203.0.113.7 51239 typ host',
      'a=candidate:6 1 udp 2113937151 192.168.86.23 51240 typ host\ra=candidate:7 1 udp 2113937151 203.0.113.7 51241 typ host',
      'a=candidate:8 1 udp',
      // U+00A0 is not whitespace to the native parser, which reads 203.0.113.7 as this address.
      'a=candidate:9\u00a0x\u00a0y\u00a0z\u00a0192.168.86.23 1 udp 2113937151 203.0.113.7 51242 typ host',
      '',
    ].join('\r\n');

    const accepted = localNetworksPath(LAN).acceptRemote(offer);
    expect(accepted).not.toContain('203.0.113.7');
    expect(accepted).not.toContain('candidate:8');
    expect(candidatesIn(accepted)).toEqual([
      'a=candidate:1 1 udp 2113937151 192.168.86.23 51234 typ host',
      'a=candidate:4 1 udp 2113937151 192.168.86.23 51238 typ host',
      'a=candidate:6 1 udp 2113937151 192.168.86.23 51240 typ host',
    ]);
    expect(accepted).toContain('\r\nc=IN IP4 0.0.0.0\r\n');
  });

  it('reports the offer’s first public candidate, whatever the allowed networks, as a diagnostic', () => {
    // A phone on cellular: its carrier's CGNAT host, a link-local, a ULA, an
    // mDNS name, then the srflx Cloudflare STUN gave it — and another after.
    const offer = [
      'v=0',
      'c=IN IP4 198.51.100.1',
      'a=candidate:1 1 udp 2113937151 100.70.1.2 51234 typ host',
      'a=candidate:2 1 udp 2113937151 169.254.3.4 51235 typ host',
      'a=candidate:3 1 udp 2113937151 fd12:3456::1 51236 typ host',
      'a=candidate:4 1 udp 2113937151 fe80::1%en0 51239 typ host',
      'a=candidate:5 1 udp 2113937151 0f1e2d3c-aaaa-bbbb-cccc-000000000000.local 51237 typ host',
      'a=candidate:6 1 udp 1677729535 172.58.12.9 40000 typ srflx raddr 0.0.0.0 rport 0',
      'a=candidate:7 1 udp 1677729535 2607:fb90:1:2::9 40001 typ srflx raddr :: rport 0',
      '',
    ].join('\r\n');
    expect(localNetworksPath(LAN).reportedAddress(offer)).toBe('172.58.12.9');
    // One inside the allowed networks is no reason the phone was refused.
    expect(localNetworksPath(['172.58.0.0/16']).reportedAddress(offer)).toBe('2607:fb90:1:2::9');
    expect(localNetworksPath(LAN).reportedAddress(offer.replace(/^a=candidate:6 .*$/m, ''))).toBe('2607:fb90:1:2::9');
    // Private addresses only, or none at all: nothing to report.
    expect(localNetworksPath(LAN).reportedAddress(LAN_OFFER_PRIVATE)).toBeNull();
    expect(localNetworksPath(LAN).reportedAddress('v=0\r\n')).toBeNull();
  });

  it('allows a pair whose two ends are both on allowed networks', () => {
    const path = localNetworksPath([...LAN, ...TAILNET]);
    expect(path.refusal({ local: '192.168.86.160', remote: '192.168.86.23' })).toBeNull();
    expect(path.refusal({ local: '100.97.229.25', remote: '100.101.7.8' })).toBeNull();
    // Across two allowed networks is still on allowed networks at both ends.
    expect(path.refusal({ local: '192.168.86.160', remote: '100.101.7.8' })).toBeNull();
    // IPv4-mapped IPv6 is its IPv4 address.
    expect(path.refusal({ local: '::ffff:192.168.86.160', remote: '::ffff:c0a8:5617' })).toBeNull();
  });

  it('refuses a pair with either end off the allowed networks, naming that end, this one first', () => {
    const path = localNetworksPath(LAN);
    expect(path.refusal({ local: '100.97.229.25', remote: '192.168.86.23' })).toEqual({
      reason: 'the selected pair’s local end is not on an allowed network',
      end: 'local',
    });
    expect(path.refusal({ local: '192.168.86.160', remote: '100.101.7.8' })).toEqual({
      reason: 'the selected pair’s remote end is not on an allowed network',
      end: 'remote',
    });
    expect(path.refusal({ local: '100.97.229.25', remote: '100.101.7.8' })?.end).toBe('local');
  });

  it('refuses a name, an mDNS name, a missing end, or no pair at all', () => {
    const path = localNetworksPath(LAN);
    for (const remote of ['phone.local', '0f1e2d3c-aaaa-bbbb-cccc-000000000000.local', null]) {
      expect(path.refusal({ local: '192.168.86.160', remote })?.end, String(remote)).toBe('remote');
    }
    expect(path.refusal({ local: null, remote: '192.168.86.23' })?.end).toBe('local');
    expect(path.refusal(null)).toEqual({ reason: 'the connection reports no selected candidate pair', end: null });
  });
});

/** An offer from a phone on a private network, behind no STUN. */
const LAN_OFFER_PRIVATE = [
  'v=0',
  'a=candidate:1 1 udp 2113937151 192.168.86.23 51234 typ host',
  'a=candidate:2 1 udp 2113937151 10.1.2.3 51235 typ host',
  'a=candidate:3 1 udp 2113937151 172.16.4.5 51236 typ host',
  '',
].join('\r\n');
