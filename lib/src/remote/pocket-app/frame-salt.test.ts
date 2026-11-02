/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { frameSalt } from './frame-salt';

describe('frameSalt', () => {
  beforeEach(() => sessionStorage.clear());

  it('keeps one salt in this tab, and leaves nothing for another', () => {
    const first = frameSalt();
    expect(first).toHaveLength(32);
    expect(frameSalt()).toEqual(first);
    expect(localStorage.length).toBe(0);
  });

  it('replaces what it cannot read', () => {
    const first = frameSalt();
    sessionStorage.setItem('dormouse.pocket.frame-salt', 'short');
    const second = frameSalt();
    expect(second).toHaveLength(32);
    expect(second).not.toEqual(first);
  });
});
