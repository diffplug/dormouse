/**
 * Monotonic dirty tracker for session persistence. A generation counter
 * (`gen`) advances on every {@link SessionDirtyTracker.markDirty}; `savedGen`
 * records the generation captured by the most recent successful save. The
 * persisted state is dirty whenever `gen > savedGen`.
 *
 * The invariant is deliberately conservative under races. A save captures its
 * target generation with {@link SessionDirtyTracker.beginSave} *before* it
 * serializes, and advances `savedGen` to that captured token only on
 * {@link SessionDirtyTracker.completeSave}. If `markDirty()` fires while a save
 * is in flight — e.g. PTY output arrives mid-serialize — `gen` outruns the
 * captured token, so the tracker stays dirty after the save completes and the
 * next heartbeat writes again. The cost is at most one redundant save; a change
 * is never silently lost.
 *
 * A fresh tracker starts DIRTY (`gen = 1`, `savedGen = 0`) so the first
 * heartbeat after boot always persists: post-restore the blob legitimately
 * changes (panes respawn, scrollback is replaced) even with no user activity,
 * and the first save should land.
 */
export interface SessionDirtyTracker {
  /** Mark the persisted state as changed since the last completed save. */
  markDirty(): void;
  /** True when there are changes not yet captured by a completed save. */
  isDirty(): boolean;
  /** Capture this save's token before serializing; pass it to completeSave. */
  beginSave(): number;
  /** Record a successful save of `token`'s generation (stale tokens ignored). */
  completeSave(token: number): void;
}

export function createSessionDirtyTracker(): SessionDirtyTracker {
  let gen = 1;
  let savedGen = 0;
  return {
    markDirty() {
      gen += 1;
    },
    isDirty() {
      return gen > savedGen;
    },
    beginSave() {
      return gen;
    },
    completeSave(token) {
      if (token > savedGen) savedGen = token;
    },
  };
}
