/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { frameSalt } from './frame-salt';

describe('frameSalt', () => {
  beforeEach(() => localStorage.clear());

  it('keeps one salt on this device', () => {
    const first = frameSalt();
    expect(first).toHaveLength(32);
    expect(frameSalt()).toEqual(first);
  });

  it('replaces what it cannot read', () => {
    localStorage.setItem('dormouse.pocket.frame-salt', JSON.stringify('short'));
    expect(frameSalt()).toHaveLength(32);
    localStorage.setItem('dormouse.pocket.frame-salt', 'not json');
    expect(frameSalt()).toHaveLength(32);
  });
});
