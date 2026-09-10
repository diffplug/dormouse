// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { BrowserStreamGrants } from './browser-stream-guard';
test('stream grants are port-bound, single-use, expiring and bounded', () => {
  vi.useFakeTimers();
  try {
    const grants = new BrowserStreamGrants();
    const token = grants.issue(1234);
    expect(grants.consume(token, 1234)).toBe(true);
    expect(grants.consume(token, 1234)).toBe(false);
    expect(grants.consume(grants.issue(1234), 5678)).toBe(false);
    const expired = grants.issue(1234);
    vi.advanceTimersByTime(60000);
    expect(grants.consume(expired, 1234)).toBe(false);
    const evicted = grants.issue(1234);
    for (let i = 0; i < 1024; i++) grants.issue(1234);
    expect(grants.consume(evicted, 1234)).toBe(false);
  } finally { vi.useRealTimers(); }
});
