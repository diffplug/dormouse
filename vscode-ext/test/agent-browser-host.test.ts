import { afterEach, describe, expect, it, vi } from 'vitest';

// The shared host, with cleanup that never finishes: a Playwright launch or
// connect still in flight when VS Code shuts down.
const { never } = vi.hoisted(() => ({ never: () => new Promise<void>(() => {}) }));
vi.mock('../../lib/src/host/browser-host', () => ({
  createBrowserHost: () => ({ request: vi.fn(), close: never }),
}));

import { closeBrowserSessions } from '../src/agent-browser-host';

afterEach(() => { vi.useRealTimers(); });

describe('closeBrowserSessions', () => {
  it('gives up on hung browser cleanup so deactivate reaches the session flush', async () => {
    vi.useFakeTimers();
    let settled = false;
    void closeBrowserSessions().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });
});
