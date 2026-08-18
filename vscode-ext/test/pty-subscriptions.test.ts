import { describe, expect, it } from 'vitest';
import { PtySubscriptions } from '../src/pty-subscriptions';

describe('PtySubscriptions', () => {
  it('keeps the stream until the final viewer unsubscribes', () => {
    const subscriptions = new PtySubscriptions();

    expect(subscriptions.subscribe('pty-1')).toBe(true);
    expect(subscriptions.subscribe('pty-1')).toBe(false);
    expect(subscriptions.has('pty-1')).toBe(true);

    expect(subscriptions.unsubscribe('pty-1')).toBe(false);
    expect(subscriptions.has('pty-1')).toBe(true);

    expect(subscriptions.unsubscribe('pty-1')).toBe(true);
    expect(subscriptions.has('pty-1')).toBe(false);
  });

  it('ignores an unmatched unsubscribe', () => {
    const subscriptions = new PtySubscriptions();
    expect(subscriptions.unsubscribe('pty-missing')).toBe(false);
  });

  it('releases each unique stream once on router disposal', () => {
    const subscriptions = new PtySubscriptions();
    subscriptions.subscribe('pty-1');
    subscriptions.subscribe('pty-1');
    subscriptions.subscribe('pty-2');
    const released: string[] = [];

    subscriptions.releaseAll((ptyId) => released.push(ptyId));

    expect(released.sort()).toEqual(['pty-1', 'pty-2']);
    expect(subscriptions.has('pty-1')).toBe(false);
    expect(subscriptions.has('pty-2')).toBe(false);
  });
});
