/**
 * The refusal record both runtimes report and the goodbye that carries it to
 * the phone (`docs/specs/remote-network.md` -> "Local networks").
 */

import { describe, expect, it } from 'vitest';
import { SESSION_END_V1, isSessionEndV1 } from 'remote-lib-common';

import { goodbyeFor, isPathRefusal, pathRefusal } from './path-refusal';

describe('the path refusal', () => {
  it('carries an address with its source, or neither', () => {
    expect(pathRefusal(5, 'path-refused', { address: '172.58.12.9', source: 'observed' })).toEqual({
      at: 5,
      kind: 'path-refused',
      address: '172.58.12.9',
      addressSource: 'observed',
    });
    expect(pathRefusal(5, 'deadline', null)).toEqual({ at: 5, kind: 'deadline' });
  });

  it('becomes a goodbye the phone’s guard takes, a bare one with none', () => {
    const observed = pathRefusal(5, 'path-refused', { address: '172.58.12.9', source: 'observed' });
    expect(goodbyeFor(observed)).toEqual({
      ...SESSION_END_V1,
      reason: 'network-not-allowed',
      address: '172.58.12.9',
      addressSource: 'observed',
    });
    expect(goodbyeFor(pathRefusal(5, 'given-up', null))).toEqual({ ...SESSION_END_V1, reason: 'network-not-allowed' });
    expect(goodbyeFor(null)).toBe(SESSION_END_V1);
    for (const refusal of [observed, pathRefusal(5, 'given-up', null), null]) {
      expect(isSessionEndV1(goodbyeFor(refusal))).toBe(true);
    }
  });

  it('guards what crosses to a panel', () => {
    expect(isPathRefusal({ at: 1, kind: 'given-up' })).toBe(true);
    expect(isPathRefusal({ at: 1, kind: 'given-up', address: '2607:fb90::9', addressSource: 'reported' })).toBe(true);
    for (const value of [
      null,
      [],
      { kind: 'given-up' },
      { at: Number.NaN, kind: 'given-up' },
      { at: 1, kind: 'relayed-app' },
      { at: 1, kind: 'given-up', address: '172.58.12.9' },
      { at: 1, kind: 'given-up', addressSource: 'observed' },
      { at: 1, kind: 'given-up', address: 'phone.local', addressSource: 'observed' },
      { at: 1, kind: 'given-up', address: '172.58.12.9', addressSource: 'guessed' },
    ]) {
      expect(isPathRefusal(value), JSON.stringify(value)).toBe(false);
    }
  });
});
