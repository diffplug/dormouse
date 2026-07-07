import { describe, it, expect } from 'vitest';
import { createSessionDirtyTracker } from './session-dirty';

describe('createSessionDirtyTracker', () => {
  it('starts dirty so the first heartbeat after boot always persists', () => {
    const tracker = createSessionDirtyTracker();
    // gen=1, savedGen=0 — the post-restore blob legitimately changes even with
    // no user activity, so the first save should land.
    expect(tracker.isDirty()).toBe(true);
  });

  it('markDirty makes a clean tracker dirty again', () => {
    const tracker = createSessionDirtyTracker();
    tracker.completeSave(tracker.beginSave());
    expect(tracker.isDirty()).toBe(false);
    tracker.markDirty();
    expect(tracker.isDirty()).toBe(true);
  });

  it('a markDirty during a save leaves the tracker dirty after it completes', () => {
    const tracker = createSessionDirtyTracker();
    tracker.completeSave(tracker.beginSave());
    expect(tracker.isDirty()).toBe(false);

    const token = tracker.beginSave(); // captures the current generation
    tracker.markDirty(); // change arrives mid-save
    tracker.completeSave(token); // only advances savedGen to the captured token
    expect(tracker.isDirty()).toBe(true); // one redundant save later, never lost
  });

  it('a stale completeSave token never regresses savedGen', () => {
    const tracker = createSessionDirtyTracker();
    const staleToken = tracker.beginSave(); // 1
    tracker.markDirty(); // gen=2
    const freshToken = tracker.beginSave(); // 2
    tracker.completeSave(freshToken); // savedGen=2, clean
    expect(tracker.isDirty()).toBe(false);

    tracker.completeSave(staleToken); // 1 < 2 → ignored
    expect(tracker.isDirty()).toBe(false);
  });
});
