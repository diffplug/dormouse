import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPendingKillsForTesting, addPendingKill, finalizePendingKills, getPendingKills, holdPendingKill,
  newestPendingKill, PENDING_KILL_MS, pendingKillKey, pendingKillProgress, restorePendingKill,
} from './pending-kills';

function pend(id: string) {
  const actions = { restore: vi.fn(), finalize: vi.fn() };
  addPendingKill({ kind: 'surface', id, workspaceId: 'ws', title: id, label: 'Terminal' }, actions);
  return actions;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  _resetPendingKillsForTesting();
  vi.useRealTimers();
});

describe('pending kills', () => {
  it('finalize once the countdown runs out, and not before', () => {
    const a = pend('a');
    vi.advanceTimersByTime(PENDING_KILL_MS - 1);
    expect(a.finalize).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(a.finalize).toHaveBeenCalledTimes(1);
    expect(getPendingKills()).toEqual([]);
  });

  it('hold their countdown while the pointer is over them', () => {
    const a = pend('a');
    vi.advanceTimersByTime(4_000);
    holdPendingKill(pendingKillKey('surface', 'a'), true);
    vi.advanceTimersByTime(60_000);
    expect(a.finalize).not.toHaveBeenCalled();
    expect(pendingKillProgress(getPendingKills()[0])).toBeCloseTo(0.4);
    holdPendingKill(pendingKillKey('surface', 'a'), false);
    vi.advanceTimersByTime(PENDING_KILL_MS - 4_000);
    expect(a.finalize).toHaveBeenCalledTimes(1);
  });

  it('restore instead of finalizing, newest first', () => {
    const a = pend('a');
    vi.advanceTimersByTime(10);
    const b = pend('b');
    expect(getPendingKills().map(kill => kill.id)).toEqual(['b', 'a']);
    expect(newestPendingKill()?.id).toBe('b');
    restorePendingKill(pendingKillKey('surface', 'b'), false);
    expect(b.restore).toHaveBeenCalledWith(false);
    vi.advanceTimersByTime(PENDING_KILL_MS);
    expect(b.finalize).not.toHaveBeenCalled();
    expect(a.finalize).toHaveBeenCalledTimes(1);
  });

  it('finalize every one at once for a quit', () => {
    const a = pend('a');
    const b = pend('b');
    finalizePendingKills();
    expect([a.finalize, b.finalize].map(fn => fn.mock.calls.length)).toEqual([1, 1]);
    expect(getPendingKills()).toEqual([]);
  });
});
