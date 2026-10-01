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
  /**
   * Fire the one armed for `delayMs` most recently, where two share it: a
   * session's keepalive and its relay socket's heartbeat run on one interval.
   */
  fireLatestAt(delayMs: number): void;
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
    fireLatestAt(delayMs: number): void {
      let index = live.length - 1;
      while (index >= 0 && live[index]!.delayMs !== delayMs) index -= 1;
      if (index < 0) throw new Error(`no timer armed for ${delayMs}ms`);
      take(index)();
    },
  };
}

/**
 * A clock and its one timer, both injected. `advance` fires every timer that
 * comes due, in order, so a Burrow's reaper runs exactly where it would in
 * real time — and the suite does not spend five minutes proving a TTL.
 */
export function createTestClock(start: number) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimer(run: () => void, delayMs: number): () => void {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, run });
      return () => timers.delete(id);
    },
    /** How many timers are armed — what `stop()` has to leave at zero. */
    get armed(): number {
      return timers.size;
    },
    /** Move the clock backwards, as an NTP correction or a sleeping laptop does. */
    rewind(ms: number): void {
      now -= ms;
    },
    /**
     * Move the clock forwards and fire nothing, as a laptop waking from sleep
     * reads its new time before any overdue timer has run.
     */
    jump(ms: number): void {
      now += ms;
    },
    advance(ms: number): void {
      const target = now + ms;
      // Bounded: a reaper that armed for an instant it does not clear would
      // otherwise spin here rather than fail.
      for (let guard = 0; guard < 10_000; guard += 1) {
        let dueId: number | null = null;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueAt = timer.at;
            dueId = id;
          }
        }
        if (dueId === null) break;
        const timer = timers.get(dueId)!;
        timers.delete(dueId);
        now = timer.at;
        timer.run();
      }
      now = target;
    },
  };
}

export type TestClock = ReturnType<typeof createTestClock>;
