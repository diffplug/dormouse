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
});
