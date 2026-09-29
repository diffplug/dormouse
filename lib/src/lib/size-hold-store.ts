/**
 * Which of this webview's panes remote sessions hold the size of
 * (`docs/specs/remote-api.md` → "Size authority"). Set and released by the
 * surface responder on the Burrow's behalf (`lib/src/remote/burrow/peer-surfaces.ts`);
 * read by the pane, which neither re-fits a held pane nor lets its strip go
 * unexplained.
 *
 * Keyed by Session id, which is the surface id the Burrow names. A pane holds
 * one entry per holder, so two sessions attached to one pane each keep theirs
 * until they let go: the pane is its box's again only once the last has.
 */

/** One hold, exactly as the Burrow named it. */
export interface SizeHold {
  /** The remote session, opaque here: what Take back names to end it. */
  readonly holder: string;
  /** What the strip shows for it, as plain text. */
  readonly label: string;
  /** Which of that session's attachments set it, opaque too. */
  readonly lease: string;
}

const NO_HOLDS: readonly SizeHold[] = Object.freeze([]);

/** Each held pane's holds, oldest size writer first, one per holder. */
const holds = new Map<string, readonly SizeHold[]>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function set(id: string, next: readonly SizeHold[]): void {
  if (next.length === 0) holds.delete(id);
  else holds.set(id, next);
  notify();
}

/**
 * The holds on `id`, oldest size writer first — so the last is the size the
 * pane stands at — or none when the pane's own box sizes it. Stable until it
 * changes.
 */
export function getSizeHolds(id: string): readonly SizeHold[] {
  return holds.get(id) ?? NO_HOLDS;
}

/**
 * Record `hold` as its holder's on `id`: it replaces that holder's earlier one
 * and becomes the newest, since its size is the one the pane now stands at.
 * Every other holder keeps its own.
 */
export function holdSize(id: string, hold: SizeHold): void {
  const current = getSizeHolds(id);
  const newest = current[current.length - 1];
  if (
    newest?.holder === hold.holder &&
    newest.lease === hold.lease &&
    newest.label === hold.label
  ) {
    return;
  }
  set(id, [
    ...current.filter((held) => held.holder !== hold.holder),
    { holder: hold.holder, label: hold.label, lease: hold.lease },
  ]);
}

/**
 * Clear `hold`'s holder's hold on `id` if it is still the one `hold` names —
 * the same session **and** the same attachment. The same session attached
 * again keeps it, and every other holder keeps its own. Answers whether it
 * cleared anything.
 */
export function releaseSizeHold(id: string, hold: Pick<SizeHold, 'holder' | 'lease'>): boolean {
  const current = getSizeHolds(id);
  const next = current.filter((held) => held.holder !== hold.holder || held.lease !== hold.lease);
  if (next.length === current.length) return false;
  set(id, next);
  return true;
}

/** Forget every hold on `id`, whoever holds it: the Session is gone from this webview. */
export function clearSizeHold(id: string): void {
  if (holds.delete(id)) notify();
}

/** Subscribe to every hold change; returns the unsubscribe. */
export function subscribeToSizeHolds(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
