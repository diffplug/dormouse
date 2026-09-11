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
  // Dropped on cancel and on fire rather than flagged, so this *is* `live`: a
  // case that re-arms a keepalive a hundred times neither grows it without
  // bound nor pays a filtered copy per read.
  const live: Array<{ run: () => void; delayMs: number; cancelled: boolean }> = [];
  const take = (index: number): (() => void) => {
    const timer = live.splice(index, 1)[0]!;
    timer.cancelled = true;
    return timer.run;
  };
  return {
    setTimer(run: () => void, delayMs: number): () => void {
      const timer = { run, delayMs, cancelled: false };
      live.push(timer);
      return () => {
        const index = live.indexOf(timer);
        if (index >= 0) take(index);
      };
    },
    live,
    fire(): void {
      if (live.length === 0) throw new Error('no timer is armed');
      take(live.length - 1)();
    },
    fireAt(delayMs: number): void {
      const index = live.findIndex((entry) => entry.delayMs === delayMs);
      if (index < 0) throw new Error(`no timer armed for ${delayMs}ms`);
      take(index)();
    },
  };
}
