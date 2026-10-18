// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { shieldFrames } from './frame-shield';

const shielded = () => document.documentElement.hasAttribute('data-frame-shield');

describe('shieldFrames', () => {
  it('holds the shield until every overlapping gesture releases, once each', () => {
    const first = shieldFrames();
    const second = shieldFrames();
    expect(shielded()).toBe(true);
    first();
    first(); // a second release must not drop the other gesture's hold
    expect(shielded()).toBe(true);
    second();
    expect(shielded()).toBe(false);
  });
});
