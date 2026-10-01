/**
 * The network policy's shape (`docs/specs/remote-network.md` -> "Policy"),
 * as both untrusted edges read it: a store's record, and the service's answer
 * in a webview.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_ALLOWED_NETWORKS,
  NETWORK_LEVELS,
  burrowUsesStun,
  holdsToAllowedNetworks,
  isNetworkPolicyResult,
  levelsFor,
  opensOneTimeLinks,
  parseNetworkPolicy,
  phoneOnAnyNetwork,
  runsBurrow,
  storedNetworkPolicy,
  type NetworkPolicy,
} from './network-policy';

const LOCAL: NetworkPolicy = { level: 'local', allowed: ['192.168.1.0/24'], autoUpdate: true };
const NOTHING: NetworkPolicy = { level: 'nothing', allowed: [], autoUpdate: false };
const ANYWHERE: NetworkPolicy = { level: 'anywhere', allowed: [], autoUpdate: false };

describe('levelsFor', () => {
  it('offers a Hosted build Local networks and Anywhere, and a self-host build My Relay only', () => {
    expect(levelsFor('hosted')).toEqual(['nothing', 'local', 'anywhere']);
    expect(levelsFor('self-host')).toEqual(['nothing', 'relay']);
  });
});

describe('what each level opens', () => {
  it('opens one-time links under Anywhere, and under Local networks with a network allowed', () => {
    expect(opensOneTimeLinks(ANYWHERE)).toBe(true);
    expect(opensOneTimeLinks(LOCAL)).toBe(true);
    expect(opensOneTimeLinks({ ...LOCAL, allowed: [] })).toBe(false);
    expect(opensOneTimeLinks(NOTHING)).toBe(false);
    expect(opensOneTimeLinks({ ...NOTHING, level: 'relay' })).toBe(false);
  });

  it('runs the persistent Burrow under every level but Nothing', () => {
    expect(NETWORK_LEVELS.filter(runsBurrow)).toEqual(['local', 'anywhere', 'relay']);
  });

  it('gathers through STUN on the Burrow under Anywhere alone', () => {
    expect(NETWORK_LEVELS.filter(burrowUsesStun)).toEqual(['anywhere']);
  });

  it('holds a phone’s path to the allowed networks under Local networks alone', () => {
    expect(NETWORK_LEVELS.filter(holdsToAllowedNetworks)).toEqual(['local']);
  });

  it('lets a phone on any network under Anywhere alone, whatever is allowed', () => {
    for (const allowed of [[], LOCAL.allowed]) {
      expect(NETWORK_LEVELS.filter((level) => phoneOnAnyNetwork({ ...NOTHING, level, allowed }))).toEqual([
        'anywhere',
      ]);
    }
  });
});

describe('parseNetworkPolicy', () => {
  it('takes a policy exactly: three keys, a known level, bounded strings, a boolean', () => {
    expect(parseNetworkPolicy(LOCAL)).toEqual(LOCAL);
    expect(parseNetworkPolicy({ ...LOCAL, level: 'anywhere' })).not.toBeNull();
    expect(
      parseNetworkPolicy({ ...LOCAL, allowed: Array.from({ length: MAX_ALLOWED_NETWORKS }, () => 'x') }),
    ).not.toBeNull();
    for (const value of [
      null,
      [],
      'local',
      { ...LOCAL, extra: 1 },
      { level: 'local', allowed: [] },
      { ...LOCAL, level: 'everything' },
      { ...LOCAL, allowed: '192.168.1.0/24' },
      { ...LOCAL, allowed: [24] },
      { ...LOCAL, allowed: Array.from({ length: MAX_ALLOWED_NETWORKS + 1 }, () => 'x') },
      { ...LOCAL, autoUpdate: 1 },
    ]) {
      expect(parseNetworkPolicy(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe('storedNetworkPolicy', () => {
  it('reads none as none, a policy as a copy, and anything else as Nothing', () => {
    expect(storedNetworkPolicy(undefined)).toBeNull();
    expect(storedNetworkPolicy(null)).toEqual(NOTHING);

    const read = storedNetworkPolicy(LOCAL);
    expect(read).toEqual(LOCAL);
    expect(read?.allowed).not.toBe(LOCAL.allowed);

    expect(storedNetworkPolicy({ ...LOCAL, level: 'everything' })).toEqual(NOTHING);
    expect(storedNetworkPolicy('relay')).toEqual(NOTHING);
  });
});

describe('isNetworkPolicyResult', () => {
  const result = {
    policy: LOCAL,
    levels: ['nothing', 'local'],
    interfaces: [{ id: 'en0', label: 'Local network', kind: 'lan', prefixes: ['192.168.1.0/24'] }],
  };

  it('takes what the service answers, and nothing a panel could not render', () => {
    expect(isNetworkPolicyResult(result)).toBe(true);
    const refusal = { at: 1, kind: 'path-refused', end: 'remote', address: '172.58.12.9', addressSource: 'observed' };
    expect(isNetworkPolicyResult({ ...result, refusal })).toBe(true);
    for (const value of [
      null,
      { ...result, refusal: null },
      { ...result, refusal: { ...refusal, address: '<b>hi</b>' } },
      { ...result, policy: { ...LOCAL, extra: 1 } },
      { ...result, levels: ['nothing', 'everything'] },
      { ...result, interfaces: [{ ...result.interfaces[0], kind: 'wifi' }] },
      { ...result, interfaces: [{ ...result.interfaces[0], prefixes: [1] }] },
      { policy: LOCAL, levels: ['nothing'] },
    ]) {
      expect(isNetworkPolicyResult(value), JSON.stringify(value)).toBe(false);
    }
  });
});
