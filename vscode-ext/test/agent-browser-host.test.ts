import { afterEach, describe, expect, it, vi } from 'vitest';

// Both shared hosts, with cleanup that never finishes: a Playwright launch or
// connect still in flight when VS Code shuts down.
const { never } = vi.hoisted(() => ({ never: () => new Promise<void>(() => {}) }));
vi.mock('../../lib/src/host/agent-browser-host', () => ({
  createAgentBrowserHost: () => ({ closePoppedOut: never }),
}));
vi.mock('../../lib/src/host/playwright-host', () => ({
  createPlaywrightHost: () => ({ request: vi.fn(), close: never }),
}));

import { closePoppedOutSessions } from '../src/agent-browser-host';

afterEach(() => { vi.useRealTimers(); });

describe('closePoppedOutSessions', () => {
  it('gives up on hung browser cleanup so deactivate reaches the session flush', async () => {
    vi.useFakeTimers();
    let settled = false;
    void closePoppedOutSessions().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });
});
