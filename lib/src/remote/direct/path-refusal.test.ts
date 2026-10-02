/**
 * The refusal record both runtimes report and the goodbye that carries it to
 * the phone (`docs/specs/remote-network.md` -> "Local networks").
 */

import { describe, expect, it } from 'vitest';
import { SESSION_END_V1, isSessionEndV1 } from 'remote-lib-common';

import { goodbyeFor, isPathRefusal, pathRefusal } from './path-refusal';

const OBSERVED = { end: 'remote', address: { address: '172.58.12.9', source: 'observed' } } as const;

describe('the path refusal', () => {
  it('names the end refused, the phone’s address with its source or this machine’s own, or neither', () => {
    expect(pathRefusal(5, 'path-refused', OBSERVED)).toEqual({
      at: 5,
      kind: 'path-refused',
      end: 'remote',
      address: '172.58.12.9',
      addressSource: 'observed',
    });
    expect(pathRefusal(5, 'path-refused', { end: 'remote', address: null })).toEqual({
      at: 5,
      kind: 'path-refused',
      end: 'remote',
    });
    expect(pathRefusal(5, 'path-refused', { end: 'local', address: '10.0.0.2' })).toEqual({
      at: 5,
      kind: 'path-refused',
      end: 'local',
      localAddress: '10.0.0.2',
    });
    expect(pathRefusal(5, 'path-refused', { end: 'local', address: null })).toEqual({
      at: 5,
      kind: 'path-refused',
      end: 'local',
    });
    expect(pathRefusal(5, 'deadline', null)).toEqual({ at: 5, kind: 'deadline' });
  });

  it('becomes a goodbye the phone’s guard takes, naming only the phone’s address', () => {
    const observed = pathRefusal(5, 'path-refused', OBSERVED);
    expect(goodbyeFor(observed)).toEqual({
      ...SESSION_END_V1,
      reason: 'network-not-allowed',
      address: '172.58.12.9',
      addressSource: 'observed',
    });
    // This machine's own end refused: nothing of its address crosses, and the
    // phone reads the generic copy.
    const local = pathRefusal(5, 'path-refused', { end: 'local', address: '10.0.0.2' });
    expect(goodbyeFor(local)).toEqual({ ...SESSION_END_V1, reason: 'network-not-allowed' });
    expect(goodbyeFor(pathRefusal(5, 'given-up', null))).toEqual({ ...SESSION_END_V1, reason: 'network-not-allowed' });
    expect(goodbyeFor(null)).toBe(SESSION_END_V1);
    for (const refusal of [observed, local, pathRefusal(5, 'given-up', null), null]) {
      expect(isSessionEndV1(goodbyeFor(refusal))).toBe(true);
    }
  });

  it('guards what crosses to a panel', () => {
    for (const value of [
      { at: 1, kind: 'given-up' },
      { at: 1, kind: 'given-up', end: 'remote' },
      { at: 1, kind: 'given-up', end: 'remote', address: '2607:fb90::9', addressSource: 'reported' },
      { at: 1, kind: 'path-refused', end: 'local' },
      { at: 1, kind: 'path-refused', end: 'local', localAddress: '10.0.0.2' },
    ]) {
      expect(isPathRefusal(value), JSON.stringify(value)).toBe(true);
    }
    for (const value of [
      null,
      [],
      { kind: 'given-up' },
      { at: Number.NaN, kind: 'given-up' },
      { at: 1, kind: 'relayed-app' },
      { at: 1, kind: 'given-up', end: 'phone' },
      { at: 1, kind: 'given-up', end: 'remote', address: '172.58.12.9' },
      { at: 1, kind: 'given-up', end: 'remote', addressSource: 'observed' },
      { at: 1, kind: 'given-up', end: 'remote', address: 'phone.local', addressSource: 'observed' },
      { at: 1, kind: 'given-up', end: 'remote', address: '172.58.12.9', addressSource: 'guessed' },
      // The phone's address belongs to its end alone, this machine's to its own.
      { at: 1, kind: 'given-up', address: '172.58.12.9', addressSource: 'observed' },
      { at: 1, kind: 'path-refused', end: 'local', address: '172.58.12.9', addressSource: 'observed' },
      { at: 1, kind: 'path-refused', end: 'remote', localAddress: '10.0.0.2' },
      { at: 1, kind: 'path-refused', end: 'local', localAddress: 'laptop.local' },
    ]) {
      expect(isPathRefusal(value), JSON.stringify(value)).toBe(false);
    }
  });
});
