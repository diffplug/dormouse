import { describe, expect, it, vi } from 'vitest';
import { awaitWallEmpty } from './close-all';

/** A Lath-store stand-in: a member list plus the commit callback the Wall
 *  subscribes to. */
function watch(initial: string[]) {
  let members = [...initial];
  const listeners = new Set<() => void>();
  return {
    members: () => members,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listenerCount: () => listeners.size,
    commit(next: string[]) {
      members = next;
      listeners.forEach((listener) => listener());
    },
  };
}

describe('awaitWallEmpty', () => {
  it('resolves clean the moment the last Surface leaves the tree', async () => {
    const store = watch(['pane-a']);
    const settled = awaitWallEmpty({ members: store.members, subscribe: store.subscribe, timeoutMs: 1000 });
    store.commit([]);
    expect(await settled).toBeNull();
    // Nothing is left listening or pending.
    expect(store.listenerCount()).toBe(0);
  });

  it('resolves clean without waiting when the Wall is already empty', async () => {
    const store = watch([]);
    expect(await awaitWallEmpty({ members: store.members, subscribe: store.subscribe, timeoutMs: 1000 })).toBeNull();
    expect(store.listenerCount()).toBe(0);
  });

  it('refuses on the deadline rather than reporting clean over a live Surface', async () => {
    vi.useFakeTimers();
    try {
      const store = watch(['pane-a', 'pane-b']);
      const settled = awaitWallEmpty({ members: store.members, subscribe: store.subscribe, timeoutMs: 50 });
      // A commit that does not empty the Wall keeps the wait going.
      store.commit(['pane-b']);
      await vi.advanceTimersByTimeAsync(50);
      // Unmounting here would leave an Orphaned Session, so the caller is told.
      expect(await settled).toBe('1 surface did not finish closing');
      expect(store.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
