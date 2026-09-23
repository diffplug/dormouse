import { afterEach, describe, expect, it } from 'vitest';
import { cfg } from '../cfg';
import { randomKillChar } from './KillConfirm';

describe('randomKillChar', () => {
  afterEach(() => { cfg.killConfirm.char = null; });

  it('answers the pinned letter when one is set', () => {
    cfg.killConfirm.char = 'q';
    expect(Array.from({ length: 20 }, randomKillChar)).toEqual(Array(20).fill('q'));
  });

  it('draws a lowercase letter other than x or k when unpinned', () => {
    for (let i = 0; i < 200; i++) expect(randomKillChar()).toMatch(/^[a-jl-wyz]$/);
  });
});
