// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { BrowserStreamGrants } from './browser-stream-guard';
test('stream grants are single-use, expiring and bounded, and answer only what they were issued for', () => {
  vi.useFakeTimers();
  try {
    const grants = new BrowserStreamGrants<string>();
    const token = grants.issue('view-a');
    expect(grants.consume(token)).toBe('view-a');
    expect(grants.consume(token)).toBeUndefined();
    expect(grants.consume('0'.repeat(64))).toBeUndefined();
    const expired = grants.issue('view-a');
    vi.advanceTimersByTime(60000);
    expect(grants.consume(expired)).toBeUndefined();
    const evicted = grants.issue('view-a');
    for (let i = 0; i < 1024; i++) grants.issue('view-b');
    expect(grants.consume(evicted)).toBeUndefined();
  } finally { vi.useRealTimers(); }
});
