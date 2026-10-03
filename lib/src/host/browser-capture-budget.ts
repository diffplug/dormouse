/**
 * The host-wide crisp-capture budget (docs/specs/dor-browser.md → "Resource
 * Policy"): every viewer socket's captures share a few slots and a rate, so k
 * panes cost what one does rather than k times it. A claim the user is
 * interacting with goes first; the rest wait their turn in arrival order —
 * each socket has at most one claim, so that is round-robin.
 *
 * A capture that outlives `timeoutMs` frees its slot and answers undefined:
 * a provider whose capture never settles (a CDP call into a wedged page) must
 * not hold the budget for every other pane. It may still be running, which
 * `./browser-capture.ts` bounds; the next claim for that browser joins it
 * rather than starting another.
 */

import { settleAllWithin } from '../lib/settle-within';

export interface CaptureClaim {
  /** The user is interacting with this pane: it goes ahead of the queue. */
  urgent: boolean;
  /** False once nobody wants the capture — its socket closed. */
  wanted(): boolean;
}

export interface CaptureBudget {
  run<T>(capture: () => Promise<T>, claim: CaptureClaim): Promise<T | undefined>;
}

export const CAPTURES_PER_SECOND = 6;
export const CONCURRENT_CAPTURES = 2;
export const CAPTURE_SLOT_TIMEOUT_MS = 10_000;

type Waiting = { claim: CaptureClaim; start(): void; drop(): void };

export function createCaptureBudget(opts: { perSecond?: number; concurrent?: number; timeoutMs?: number } = {}): CaptureBudget {
  const perSecond = opts.perSecond ?? CAPTURES_PER_SECOND;
  const concurrent = opts.concurrent ?? CONCURRENT_CAPTURES;
  const timeoutMs = opts.timeoutMs ?? CAPTURE_SLOT_TIMEOUT_MS;
  const queue: Waiting[] = [];
  // When each capture of the last second started.
  const starts: number[] = [];
  let running = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function pump(): void {
    while (running < concurrent && queue.length > 0) {
      const now = performance.now();
      while (starts.length > 0 && now - starts[0] >= 1000) starts.shift();
      if (starts.length >= perSecond) {
        timer ??= setTimeout(() => { timer = undefined; pump(); }, starts[0] + 1000 - now);
        return;
      }
      const urgent = queue.findIndex((waiting) => waiting.claim.urgent);
      const [next] = queue.splice(urgent === -1 ? 0 : urgent, 1);
      if (!next.claim.wanted()) {
        next.drop();
        continue;
      }
      starts.push(now);
      running += 1;
      next.start();
    }
  }

  return {
    run<T>(capture: () => Promise<T>, claim: CaptureClaim): Promise<T | undefined> {
      return new Promise<T | undefined>((resolve) => {
        queue.push({
          claim,
          drop: () => resolve(undefined),
          start: () => {
            void settleAllWithin<T | undefined>([capture()], timeoutMs, undefined).then(([value]) => {
              running -= 1;
              resolve(value);
              pump();
            });
          },
        });
        pump();
      });
    },
  };
}
