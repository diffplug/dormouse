/**
 * Which of this webview's panes a remote session holds the size of
 * (`docs/specs/remote-api.md` → "Size authority"). Set and released by the
 * surface responder on the Burrow's behalf (`lib/src/remote/burrow/peer-surfaces.ts`);
 * read by the pane, which neither re-fits a held pane nor lets its strip go
 * unexplained.
 *
 * Keyed by Session id, which is the surface id the Burrow names.
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

const holds = new Map<string, SizeHold>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** The hold on `id`, or `null` when the pane's own box sizes it. Stable until it changes. */
export function getSizeHold(id: string): SizeHold | null {
  return holds.get(id) ?? null;
}

/** Record `hold` as the one on `id`, replacing whichever was there: the newest writer holds. */
export function holdSize(id: string, hold: SizeHold): void {
  const current = holds.get(id);
  if (
    current?.holder === hold.holder &&
    current.lease === hold.lease &&
    current.label === hold.label
  ) {
    return;
  }
  holds.set(id, { holder: hold.holder, label: hold.label, lease: hold.lease });
  notify();
}

/**
 * Clear `id`'s hold if it is still the one `hold` names — the same session
 * **and** the same attachment. A later holder, or the same session attached
 * again, keeps it. Answers whether it cleared anything.
 */
export function releaseSizeHold(id: string, hold: Pick<SizeHold, 'holder' | 'lease'>): boolean {
  const current = holds.get(id);
  if (!current || current.holder !== hold.holder || current.lease !== hold.lease) return false;
  holds.delete(id);
  notify();
  return true;
}

/** Forget `id`'s hold, whoever holds it: the Session is gone from this webview. */
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
