/**
 * The network policy's shape (`docs/specs/remote-network.md` -> "Policy"),
 * as both untrusted edges read it: a store's record, and the service's answer
 * in a webview.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_ALLOWED_NETWORKS,
  isNetworkPolicy,
  isNetworkPolicyResult,
  levelsFor,
  storedNetworkPolicy,
  type NetworkPolicy,
} from './network-policy';

const LOCAL: NetworkPolicy = { level: 'local', allowed: ['192.168.1.0/24'], autoUpdate: true };
const NOTHING: NetworkPolicy = { level: 'nothing', allowed: [], autoUpdate: false };

describe('levelsFor', () => {
  it('offers a Hosted build Local networks, and a self-host build My Relay only', () => {
    expect(levelsFor('hosted')).toEqual(['nothing', 'local']);
    expect(levelsFor('self-host')).toEqual(['nothing', 'relay']);
  });
});

describe('isNetworkPolicy', () => {
  it('takes a policy exactly: three keys, a known level, bounded strings, a boolean', () => {
    expect(isNetworkPolicy(LOCAL)).toBe(true);
    expect(isNetworkPolicy({ ...LOCAL, level: 'anywhere' })).toBe(true);
    expect(isNetworkPolicy({ ...LOCAL, allowed: Array.from({ length: MAX_ALLOWED_NETWORKS }, () => 'x') })).toBe(
      true,
    );
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
      expect(isNetworkPolicy(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('storedNetworkPolicy', () => {
  it('reads none as none, a policy as a copy, and anything else as Nothing', () => {
    expect(storedNetworkPolicy(undefined)).toBeNull();
    expect(storedNetworkPolicy(null)).toBeNull();

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
    for (const value of [
      null,
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
