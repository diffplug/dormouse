import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPendingKillsForTesting, addPendingKill, finalizePendingKills, getPendingKills, holdPendingKill,
  PENDING_KILL_MS, pendingKillKey, pendingKillProgress, restorePendingKill,
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
    restorePendingKill(pendingKillKey('surface', 'b'), false);
    expect(b.restore).toHaveBeenCalledWith(false);
    vi.advanceTimersByTime(PENDING_KILL_MS);
    expect(b.finalize).not.toHaveBeenCalled();
    expect(a.finalize).toHaveBeenCalledTimes(1);
  });

  it('stay pending, their countdown untouched, when a restore refuses', () => {
    const actions = { restore: vi.fn(() => false), finalize: vi.fn() };
    addPendingKill({ kind: 'helper', id: 'h', workspaceId: 'ws', title: 'h', label: 'Helper' }, actions);
    const [before] = getPendingKills();
    vi.advanceTimersByTime(4_000);
    expect(restorePendingKill(pendingKillKey('helper', 'h'))).toBe(false);
    expect(getPendingKills()).toEqual([before]);
    vi.advanceTimersByTime(PENDING_KILL_MS - 4_000);
    expect(actions.finalize).toHaveBeenCalledTimes(1);
  });

  it('finalize every one at once for a quit', () => {
    const a = pend('a');
    const b = pend('b');
    finalizePendingKills();
    expect([a.finalize, b.finalize].map(fn => fn.mock.calls.length)).toEqual([1, 1]);
    expect(getPendingKills()).toEqual([]);
  });
  it('waits for a countdown finalizer already running when quit starts', async () => {
    let finish!: () => void;
    const finalize = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    addPendingKill({ kind: 'workspace', id: 'ws', workspaceId: 'ws', title: 'ws', label: 'Workspace' }, {
      restore: () => {}, finalize,
    });
    vi.advanceTimersByTime(PENDING_KILL_MS);
    expect(finalize).toHaveBeenCalledOnce();
    expect(getPendingKills()).toEqual([]);

    let drained = false;
    const draining = finalizePendingKills(undefined, { teardown: true }).then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    finish();
    await draining;
    expect(drained).toBe(true);
    expect(finalize).toHaveBeenCalledOnce();
  });

  it('a scoped drain does not wait for or escalate another Workspace finalizing', async () => {
    let finish!: () => void;
    const context = { teardown: false };
    addPendingKill({ kind: 'workspace', id: 'other', workspaceId: 'other', title: 'other', label: 'Workspace' }, {
      restore: () => {},
      finalize: async (current) => {
        await new Promise<void>(resolve => { finish = resolve; });
        context.teardown = current.teardown;
      },
    });
    vi.advanceTimersByTime(PENDING_KILL_MS);
    await finalizePendingKills(kill => kill.workspaceId === 'mine', { teardown: true });
    finish();
    await finalizePendingKills();
    expect(context.teardown).toBe(false);
  });

  it('drains a rejected finalizer without running it twice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let reject!: (error: Error) => void;
    const finalize = vi.fn(() => new Promise<void>((_, no) => { reject = no; }));
    addPendingKill({ kind: 'workspace', id: 'ws', workspaceId: 'ws', title: 'ws', label: 'Workspace' }, {
      restore: () => {}, finalize,
    });
    vi.advanceTimersByTime(PENDING_KILL_MS);
    const draining = finalizePendingKills(undefined, { teardown: true });
    reject(new Error('close failed'));
    await draining;
    await finalizePendingKills(undefined, { teardown: true });
    expect(finalize).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

});
