/**
 * Pending resume offers, keyed by Session id.
 *
 * A cold **restore** replays a Session's saved scrollback into a *fresh* shell —
 * the agent process that wrote that scrollback is gone. When the snapshot also
 * carried a `resumeCommand` (`resume-patterns.ts`), the restored pane offers to
 * run it. An offer is short-lived by design: it is seeded only by restore, and
 * the first thing the user does with the pane retires it.
 *
 * Never seeded on **resume** (`docs/specs/glossary.md`): there the process is
 * still Live, so there is nothing to resume.
 *
 * Exposes a `useSyncExternalStore`-compatible subscription API. Pure state, no
 * DOM or platform dependencies — safe to unit-test.
 */

import { normalizeResumeCommand } from './resume-patterns';

const offers = new Map<string, string>();
const listeners = new Set<() => void>();
let cachedSnapshot: ReadonlyMap<string, string> | null = null;

function notify(): void {
  cachedSnapshot = null;
  listeners.forEach((l) => l());
}

export function subscribeToResumeOffers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getResumeOfferSnapshot(): ReadonlyMap<string, string> {
  if (cachedSnapshot) return cachedSnapshot;
  cachedSnapshot = new Map(offers);
  return cachedSnapshot;
}

export function getResumeOffer(id: string): string | null {
  return offers.get(id) ?? null;
}

/** Seed the offer a restored pane makes. An empty command clears instead, so a
 *  snapshot with no detected resume command can be passed through unguarded. */
export function offerResumeCommand(id: string, command: string | null): void {
  const normalized = command ? normalizeResumeCommand(command) : null;
  if (!normalized) {
    clearResumeOffer(id);
    return;
  }
  if (offers.get(id) === normalized) return;
  offers.set(id, normalized);
  notify();
}

/** Retire the offer — taken, dismissed, superseded by user input, or disposed. */
export function clearResumeOffer(id: string): void {
  if (!offers.delete(id)) return;
  notify();
}

/** Test reset. */
export function __resetResumeOffersForTests(): void {
  if (offers.size === 0) return;
  offers.clear();
  notify();
}
