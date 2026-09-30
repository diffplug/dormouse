/**
 * The network policy's address math (`docs/specs/remote-network.md` ->
 * "Policy"): canonical CIDRs, the containment check the Local networks path
 * check runs, and the interfaces the Allowed networks list offers.
 */

import type { NetworkInterfaceInfo as OsAddress } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const osProbe = vi.hoisted(() => ({ fail: false }));
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>();
  return {
    ...real,
    networkInterfaces: () => {
      if (osProbe.fail) throw Object.assign(new Error('uv_interface_addresses'), { code: 'ERR_SYSTEM_ERROR' });
      return real.networkInterfaces();
    },
  };
});

import {
  addressAllowed,
  canonicalCidr,
  classifyNetworkInterfaces,
  listNetworkInterfaces,
} from './network-interfaces';

afterEach(() => {
  osProbe.fail = false;
  vi.restoreAllMocks();
});

describe('canonicalCidr', () => {
  it('masks the address to its prefix', () => {
    expect(canonicalCidr('192.168.1.7/24')).toBe('192.168.1.0/24');
    expect(canonicalCidr('10.200.3.4/9')).toBe('10.128.0.0/9');
    expect(canonicalCidr('10.1.2.3/0')).toBe('0.0.0.0/0');
    expect(canonicalCidr('100.101.102.103/32')).toBe('100.101.102.103/32');
    expect(canonicalCidr('fd65:c3d1:3e82:67d9:18f0:7985:d3e0:19c0/64')).toBe('fd65:c3d1:3e82:67d9::/64');
    expect(canonicalCidr('2001:db8:abcd:1234::1/36')).toBe('2001:db8:a000::/36');
    expect(canonicalCidr('::1/0')).toBe('::/0');
  });

  it('spells IPv6 the one way RFC 5952 does', () => {
    expect(canonicalCidr('2001:0DB8:0000:0000:0000:0000:0000:0000/32')).toBe('2001:db8::/32');
    expect(canonicalCidr('::ffff:192.168.1.5/128')).toBe('::ffff:c0a8:105/128');
    // A canonical spelling is its own canonical spelling: what the service checks.
    for (const cidr of ['192.168.1.0/24', '2001:db8::/32', 'fd7a:115c:a1e0::1/128', '0.0.0.0/0']) {
      expect(canonicalCidr(cidr)).toBe(cidr);
    }
  });

  it('refuses anything that is not a CIDR', () => {
    for (const text of [
      '192.168.1.0',
      '192.168.1.0/33',
      '192.168.1.0/',
      '192.168.1.0/-1',
      '192.168.1.0/2x',
      '192.168.01.0/24',
      '192.168.1/24',
      ' 192.168.1.0/24',
      '2001:db8::/129',
      'fe80::1%en0/64',
      'router.local/24',
      '/24',
      '',
    ]) {
      expect(canonicalCidr(text), text).toBeNull();
    }
  });
});

describe('addressAllowed', () => {
  const allowed = ['192.168.1.0/24', '2001:db8::/32'];

  it('answers whether an IP literal falls in a range, in either family', () => {
    expect(addressAllowed('192.168.1.5', allowed)).toBe(true);
    expect(addressAllowed('192.168.2.5', allowed)).toBe(false);
    expect(addressAllowed('2001:db8::5', allowed)).toBe(true);
    expect(addressAllowed('2001:db9::5', allowed)).toBe(false);
    expect(addressAllowed('192.168.1.5', ['2001:db8::/32'])).toBe(false);
  });

  it('matches an IPv4-mapped IPv6 address against its IPv4 range', () => {
    // `BlockList` compares it as IPv4 (Node 24, 2026-09), so no unwrap is needed.
    expect(addressAllowed('::ffff:192.168.1.5', allowed)).toBe(true);
    expect(addressAllowed('::ffff:c0a8:105', allowed)).toBe(true);
    expect(addressAllowed('::ffff:192.168.2.5', allowed)).toBe(false);
  });

  it('allows no hostname, mDNS name, zoned address, or empty list', () => {
    for (const address of ['router.local', '4f1d2c3e-aaaa-bbbb-cccc-000000000000.local', 'fe80::1%en0', '', 'localhost']) {
      expect(addressAllowed(address, [...allowed, 'fe80::/10']), address).toBe(false);
    }
    expect(addressAllowed('192.168.1.5', [])).toBe(false);
    // A range that does not parse matches nothing, rather than everything.
    expect(addressAllowed('192.168.1.5', ['192.168.1.0/99', 'nonsense'])).toBe(false);
  });
});

/** One `os.networkInterfaces()` address, with the fields the classifier reads. */
function address(cidr: string, internal = false): OsAddress {
  const [ip] = cidr.split('/') as [string];
  return {
    address: ip,
    netmask: '',
    family: ip.includes(':') ? 'IPv6' : 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr,
    ...(ip.includes(':') ? { scopeid: 0 } : {}),
  } as OsAddress;
}

describe('classifyNetworkInterfaces', () => {
  it('offers each interface’s own prefixes, both families, leaving out loopback and link-local', () => {
    expect(
      classifyNetworkInterfaces({
        lo0: [address('127.0.0.1/8', true), address('::1/128', true)],
        en0: [
          address('fe80::4fc:4257:75e3:5e56/64'),
          address('192.168.86.160/24'),
          address('192.168.86.161/24'),
          address('fd65:c3d1:3e82:67d9:18f0:7985:d3e0:19c0/64'),
        ],
        // Link-local only: nothing to allow, a self-assigned IPv4 address included.
        awdl0: [address('fe80::14f7:e4ff:fe1e:5ccb/64')],
        en11: [address('fe80::469:e290:270e:74e8/64'), address('169.254.235.129/16')],
        en1: [{ ...address('10.0.0.2/24'), cidr: null }],
      }),
    ).toEqual([
      {
        id: 'en0',
        label: 'Local network',
        kind: 'lan',
        prefixes: ['192.168.86.0/24', 'fd65:c3d1:3e82:67d9::/64'],
      },
    ]);
  });

  it('names VPNs by interface or by Tailscale’s range, and virtual networks by interface', () => {
    const classified = classifyNetworkInterfaces({
      utun4: [address('100.101.102.103/32'), address('fd7a:115c:a1e0::1/128')],
      // Tailscale's IPv6 range marks it whatever the OS calls it; its IPv4
      // range is CGNAT's, a carrier's or another VPN's as well.
      en9: [address('fd7a:115c:a1e0::9/128')],
      en7: [address('100.64.5.6/10')],
      utun7: [address('100.96.0.2/32')],
      wg0: [address('10.8.0.2/24')],
      tun0: [address('10.9.0.2/24')],
      bridge100: [address('192.168.64.1/24')],
      docker0: [address('172.17.0.1/16')],
      'br-3f2a': [address('172.18.0.1/16')],
      veth1a2b: [address('172.19.0.1/16')],
      'vEthernet (WSL)': [address('172.20.0.1/20')],
      vmnet8: [address('192.168.100.1/24')],
      vboxnet0: [address('192.168.56.1/24')],
      virbr0: [address('192.168.122.1/24')],
    });
    expect(classified.map(({ id, label, kind }) => [id, label, kind])).toEqual([
      ['utun4', 'Tailscale', 'vpn'],
      ['en9', 'Tailscale', 'vpn'],
      ['en7', 'Local network', 'lan'],
      ['utun7', 'VPN', 'vpn'],
      ['wg0', 'VPN', 'vpn'],
      ['tun0', 'VPN', 'vpn'],
      ['bridge100', 'Virtual network', 'virtual'],
      ['docker0', 'Virtual network', 'virtual'],
      ['br-3f2a', 'Virtual network', 'virtual'],
      ['veth1a2b', 'Virtual network', 'virtual'],
      ['vEthernet (WSL)', 'Virtual network', 'virtual'],
      ['vmnet8', 'Virtual network', 'virtual'],
      ['vboxnet0', 'Virtual network', 'virtual'],
      ['virbr0', 'Virtual network', 'virtual'],
    ]);
    expect(classified.find(({ id }) => id === 'wg0')!.prefixes).toEqual(['10.8.0.0/24']);
  });

  it('offers a Tailscale host route as the tailnet range it is drawn from', () => {
    const classified = classifyNetworkInterfaces({
      // macOS: a /32 and the tailnet's own /48.
      utun4: [address('100.101.102.103/32'), address('fd7a:115c:a1e0::4339:e51a/48')],
      // Linux: host routes in both families.
      tailscale0: [address('100.64.0.9/32'), address('fd7a:115c:a1e0::9/128')],
      // A CGNAT address with a real netmask is a network of its own, kept as it is.
      en7: [address('100.64.5.6/24')],
      // A host route outside Tailscale's ranges admits only this machine, as reported.
      wg0: [address('10.8.0.2/32')],
      // Tailscale by name, as Linux and Windows call it, with no IPv6 address.
      Tailscale: [address('100.100.1.2/32')],
      // A CGNAT host route with no Tailscale IPv6 address beside it — another
      // VPN's, or a carrier's — admits only this machine, as reported.
      utun7: [address('100.96.0.2/32')],
    });
    expect(classified.map(({ id, prefixes }) => [id, prefixes])).toEqual([
      ['utun4', ['100.64.0.0/10', 'fd7a:115c:a1e0::/48']],
      ['tailscale0', ['100.64.0.0/10', 'fd7a:115c:a1e0::/48']],
      ['en7', ['100.64.5.0/24']],
      ['wg0', ['10.8.0.2/32']],
      ['Tailscale', ['100.64.0.0/10']],
      ['utun7', ['100.96.0.2/32']],
    ]);
  });
});

describe('listNetworkInterfaces', () => {
  it('reads this machine’s, and offers none where the platform will not list them', () => {
    expect(Array.isArray(listNetworkInterfaces())).toBe(true);

    osProbe.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(listNetworkInterfaces()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});
