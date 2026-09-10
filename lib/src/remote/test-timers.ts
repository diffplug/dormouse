/**
 * The {@link RemoteTimer} the remote stack's suites arm their deadlines on.
 *
 * Test-only, and shared for the reason `./test-fake-socket.ts` is: a keepalive
 * interval, a gathering deadline, and a channel setup deadline are all the same
 * seam, and no case can afford to wait one out. Two private copies were two
 * names for the same firing rule.
 */

import type { RemoteTimer } from './ws';

export interface FakeTimers {
  /** Pass as `setTimer`; every armed deadline lands in {@link live}. */
  setTimer: RemoteTimer;
  /** Every deadline armed and not yet cancelled or fired. */
  readonly live: Array<{ run: () => void; delayMs: number; cancelled: boolean }>;
  /** Fire the most recently armed deadline, as its elapsing would. */
  fire(): void;
  /** Fire the one armed for `delayMs`, where more than one deadline is live. */
  fireAt(delayMs: number): void;
}

export function fakeTimers(): FakeTimers {
  const armed: Array<{ run: () => void; delayMs: number; cancelled: boolean }> = [];
  return {
    setTimer(run: () => void, delayMs: number): () => void {
      const timer = { run, delayMs, cancelled: false };
      armed.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    get live() {
      return armed.filter((timer) => !timer.cancelled);
    },
    fire(): void {
      const live = this.live;
      const timer = live[live.length - 1];
      if (!timer) throw new Error('no timer is armed');
      timer.cancelled = true;
      timer.run();
    },
    fireAt(delayMs: number): void {
      const timer = this.live.find((entry) => entry.delayMs === delayMs);
      if (!timer) throw new Error(`no timer armed for ${delayMs}ms`);
      timer.cancelled = true;
      timer.run();
    },
  };
}
