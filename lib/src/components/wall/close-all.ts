/**
 * The tail of a Workspace `closeAll`: the wait between the last closure and the
 * Wall being safe to unmount (`docs/specs/layout.md` → "Workspaces").
 *
 * Split out of `Wall.tsx` because the deadline is the part that has to be
 * exercised on its own — a Wall that never empties is not something a mounted
 * composition can be talked into.
 */
export interface WallEmptyWatch {
  /** The Wall's remaining member Surfaces. */
  members: () => string[];
  /** Called back on every Lath commit; returns its unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** How long a stuck exit animation may hold the wait. */
  timeoutMs: number;
}

/**
 * Resolve null once the Wall holds no Surfaces, or a refusal naming what is
 * still open if the deadline passes first. **The deadline never reports clean**:
 * unmounting a Wall over a live Surface would leave Orphaned Sessions
 * (`docs/specs/glossary.md` → "Invariants" I4), so the caller keeps the
 * Workspace instead.
 */
export function awaitWallEmpty({ members, subscribe, timeoutMs }: WallEmptyWatch): Promise<string | null> {
  if (members().length === 0) return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    let done = false;
    const settle = () => {
      if (done) return;
      const remaining = members().length;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(remaining === 0
        ? null
        : `${remaining} surface${remaining === 1 ? '' : 's'} did not finish closing`);
    };
    const timer = setTimeout(settle, timeoutMs);
    const unsubscribe = subscribe(() => { if (members().length === 0) settle(); });
    if (members().length === 0) settle();
  });
}
