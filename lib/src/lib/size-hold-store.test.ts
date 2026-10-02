import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSizeHold,
  dropSizeHoldsFromOtherServices,
  getSizeHolds,
  holdSize,
  releaseSizeHold,
  subscribeToSizeHolds,
} from './size-hold-store';

const PHONE = { holder: 'session-a', label: 'iPhone', lease: '1', serviceId: 'current', cols: 51, rows: 14 };
const TABLET = { holder: 'session-b', label: 'iPad', lease: '1', serviceId: 'current', cols: 40, rows: 20 };

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

  it('records the size each holder last set, a resize from the same attachment included', () => {
    // What the pane goes back to when a newer holder lets go first.
    holdSize('pane-1', PHONE);
    const resized = { ...PHONE, cols: 60, rows: 30 };
    holdSize('pane-1', resized);
    expect(getSizeHolds('pane-1')).toEqual([resized]);
    holdSize('pane-1', TABLET);
    expect(getSizeHolds('pane-1')).toEqual([resized, TABLET]);
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

  it('drops only the holds another service instance took, saying so once', () => {
    const changed = vi.fn();
    const unsubscribe = subscribeToSizeHolds(changed);
    holdSize('pane-1', { ...PHONE, serviceId: 'gone' });
    holdSize('pane-1', TABLET);
    holdSize('pane-2', { ...PHONE, serviceId: 'gone' });
    changed.mockClear();

    dropSizeHoldsFromOtherServices('current');
    expect(getSizeHolds('pane-1')).toEqual([TABLET]);
    expect(getSizeHolds('pane-2')).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);

    dropSizeHoldsFromOtherServices('current');
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe();
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
