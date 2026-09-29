import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSizeHold,
  getSizeHolds,
  holdSize,
  releaseSizeHold,
  subscribeToSizeHolds,
} from './size-hold-store';

const PHONE = { holder: 'session-a', label: 'iPhone', lease: '1' };
const TABLET = { holder: 'session-b', label: 'iPad', lease: '1' };

afterEach(() => {
  clearSizeHold('pane-1');
  clearSizeHold('pane-2');
});

describe('size holds', () => {
  it('keeps one hold per holder, the newest size writer last', () => {
    holdSize('pane-1', PHONE);
    holdSize('pane-1', TABLET);
    expect(getSizeHolds('pane-1')).toEqual([PHONE, TABLET]);

    // A resize from the earlier session makes it the newest; its new
    // attachment replaces its old one rather than joining it.
    const reattached = { ...PHONE, lease: '2' };
    holdSize('pane-1', reattached);
    expect(getSizeHolds('pane-1')).toEqual([TABLET, reattached]);
    expect(getSizeHolds('pane-2')).toEqual([]);
  });

  it('releases only the named holder’s hold, and only its current attachment', () => {
    holdSize('pane-1', PHONE);
    holdSize('pane-1', TABLET);

    expect(releaseSizeHold('pane-1', { ...PHONE, lease: '0' })).toBe(false);
    expect(releaseSizeHold('pane-1', TABLET)).toBe(true);
    expect(getSizeHolds('pane-1')).toEqual([PHONE]);
    expect(releaseSizeHold('pane-1', TABLET)).toBe(false);

    expect(releaseSizeHold('pane-1', PHONE)).toBe(true);
    expect(getSizeHolds('pane-1')).toEqual([]);
  });

  it('answers the same array until something changes, and says when it does', () => {
    const changed = vi.fn();
    const unsubscribe = subscribeToSizeHolds(changed);
    holdSize('pane-1', PHONE);
    const held = getSizeHolds('pane-1');
    expect(getSizeHolds('pane-1')).toBe(held);
    expect(getSizeHolds('pane-2')).toBe(getSizeHolds('pane-2'));

    // The same hold again is no change.
    holdSize('pane-1', PHONE);
    releaseSizeHold('pane-1', TABLET);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(getSizeHolds('pane-1')).toBe(held);

    clearSizeHold('pane-1');
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
