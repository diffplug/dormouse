import { registerWallHandle, stubWallHandle } from '../components/wall/wall-handles';
import { setWorkspaceTransferPending } from './window-session-aggregator';
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markSessionTouched, registry, pendingShellOpts, type TerminalEntry } from './terminal-store';
import { installSurfaceIdPool, resetSurfaceIdPool } from './surface-ids';
import { applyTerminalSemanticEvents, countRunningSessions, getTerminalPaneState, resetTerminalPaneState, removeTerminalPaneState } from './terminal-state-store';
import { beginPromotion, cancelPromotion, closeAuxParent, detachAux, disposeAux, resetAux, finishPromotion, getAux, auxHasWork, openAux, reattachAux, restoreAux, setAuxVisible, subscribeAuxTerminals } from './aux-terminal';

const host = vi.hoisted(() => ({ writePty: vi.fn(), terminalContext: vi.fn(), getCwd: vi.fn() }));
vi.mock('./platform', () => ({ getPlatform: () => host }));
vi.mock('./terminal-lifecycle', () => ({
  parkElement: vi.fn(),
  setPendingShellOpts: (id: string, options: unknown) => pendingShellOpts.set(id, options as never),
  getOrCreateTerminal: (id: string) => { const entry = { untouched: true, aux: pendingShellOpts.get(id)?.aux } as TerminalEntry; registry.set(id, entry); resetTerminalPaneState(id); return entry; },
  disposeSession: (id: string) => { registry.delete(id); removeTerminalPaneState(id); },
}));
beforeEach(() => {
  vi.useFakeTimers(); host.writePty.mockReset(); host.terminalContext.mockReset(); host.getCwd.mockReset();
  host.getCwd.mockResolvedValue(null);
  host.terminalContext.mockResolvedValue({ home: '/home/user', busy: false });
  registry.set('parent', { untouched: true } as TerminalEntry); resetTerminalPaneState('parent');
  setAuxVisible('parent', true);
});
afterEach(() => { setAuxVisible('parent', false); disposeAux('parent'); registry.clear(); pendingShellOpts.clear(); removeTerminalPaneState('parent'); vi.useRealTimers(); });
const prompt = (id: string) => applyTerminalSemanticEvents(id, [{ type: 'promptStart' }, { type: 'promptEnd' }]);

describe('aux terminal lifecycle', () => {
  it.each(['open', 'reset', 'promote'] as const)('refuses aux terminal %s while its Workspace is transferring', async action => {
    const unregister = registerWallHandle(stubWallHandle('ws', { ownsSurface: id => id === 'parent' }));
    const aux = action === 'open' ? undefined : await openAux('parent');
    setWorkspaceTransferPending('ws', true);
    try {
      const operation = action === 'open' ? openAux('parent') : action === 'reset'
        ? resetAux('parent', { workspaceId: 'ws', title: 'shell' }) : beginPromotion('parent');
      await expect(operation).rejects.toThrow('Workspace is transferring');
      expect(getAux('parent')).toBe(aux);
      expect(aux?.promoting).toBeFalsy();
    } finally { setWorkspaceTransferPending('ws', false); if (getAux('parent')?.promoting) await cancelPromotion('parent'); unregister(); }
  });

  it('does not spawn an aux terminal when its directory answer arrives during a transfer', async () => {
    const unregister = registerWallHandle(stubWallHandle('ws', { ownsSurface: id => id === 'parent' }));
    let answer!: (cwd: string | null) => void;
    host.getCwd.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const opening = openAux('parent');
    setWorkspaceTransferPending('ws', true);
    try {
      answer(null);
      await expect(opening).rejects.toThrow('Workspace is transferring');
      expect(getAux('parent')).toBeUndefined();
      expect([...registry.keys()]).toEqual(['parent']);
    } finally { setWorkspaceTransferPending('ws', false); unregister(); }
  });

  it('takes a Surface id from the host pool at birth, past one already live', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await installSurfaceIdPool(async (count) => Array.from({ length: count }, (_, i) => `surface:${5 + i}`), 0);
    try {
      registry.set('surface:5', { untouched: true } as TerminalEntry);
      expect((await openAux('parent')).id).toBe('surface:6');
    } finally {
      resetSurfaceIdPool();
      error.mockRestore();
    }
  });

  it('detaches an aux terminal with its Session alive and puts it back in place of its replacement', async () => {
    const old = await openAux('parent');
    expect(detachAux('parent')).toBe(old);
    expect(getAux('parent')).toBeUndefined();
    expect(registry.has(old.id)).toBe(true);
    const fresh = await openAux('parent');
    expect(reattachAux(old)).toBe(true);
    expect(getAux('parent')).toBe(old);
    // Killed once the host has the old aux terminal back (its claim order: Labs below).
    await vi.waitFor(() => expect(registry.has(fresh.id)).toBe(false));
  });

  it('keeps an aux terminal restored while a fresh one waits on its directory', async () => {
    const old = await openAux('parent');
    detachAux('parent');
    let answer!: (cwd: string | null) => void;
    host.getCwd.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const opening = openAux('parent');
    expect(reattachAux(old)).toBe(true);
    answer(null);
    expect(await opening).toBe(old);
    expect(getAux('parent')).toBe(old);
    expect([...registry.keys()]).toEqual(['parent', old.id]);
  });

  it('resets into a pending kill under Labs, which restores the old aux terminal in place of the fresh one', async () => {
    const labs = await import('./labs-settings');
    const pending = await import('./pending-kills');
    vi.spyOn(labs, 'isDelayedKillEnabled').mockReturnValue(true);
    try {
      const old = await openAux('parent');
      await resetAux('parent', { workspaceId: 'ws', title: 'shell' });
      expect(registry.has(old.id)).toBe(true);
      expect(pending.getPendingKills().map(kill => [kill.kind, kill.id])).toEqual([['aux', old.id]]);
      // The host owns one aux terminal per parent: the old one's claim goes before the fresh one spawns.
      const promotes = () => host.terminalContext.mock.calls.map(([request]) => request).filter(request => request.op === 'promote');
      expect(promotes()).toEqual([{ op: 'promote', id: old.id }]);
      const fresh = await openAux('parent');
      pending.restorePendingKill(pending.pendingKillKey('aux', old.id));
      expect(getAux('parent')).toBe(old);
      // Released, re-owned, then killed: never two owners at the host.
      await vi.waitFor(() => expect(registry.has(fresh.id)).toBe(false));
      expect(promotes()).toEqual([
        { op: 'promote', id: old.id },
        { op: 'promote', id: fresh.id },
        { op: 'promote', id: old.id, restore: { parentId: 'parent' } },
      ]);
    } finally {
      pending._resetPendingKillsForTesting();
      vi.restoreAllMocks();
    }
  });

  it('keeps a Labs Reset\'s old aux terminal pending even when the host release fails, so it still finalizes', async () => {
    const labs = await import('./labs-settings');
    const pending = await import('./pending-kills');
    vi.spyOn(labs, 'isDelayedKillEnabled').mockReturnValue(true);
    try {
      const old = await openAux('parent');
      // VS Code's request timeout: the release never answers in time.
      host.terminalContext.mockImplementation(async (request: { op: string }) => {
        if (request.op === 'promote') throw new Error('timed out');
        return { home: '/home/user', busy: false };
      });
      await expect(resetAux('parent', { workspaceId: 'ws', title: 'shell' })).rejects.toThrow('timed out');
      expect(pending.getPendingKills().map(kill => [kill.kind, kill.id])).toEqual([['aux', old.id]]);
      await pending.finalizePendingKills();
      expect(registry.has(old.id)).toBe(false);
    } finally {
      pending._resetPendingKillsForTesting();
      vi.restoreAllMocks();
    }
  });

  it('keeps the old aux terminal pending rather than discard a replacement holding user input', async () => {
    const labs = await import('./labs-settings');
    const pending = await import('./pending-kills');
    vi.spyOn(labs, 'isDelayedKillEnabled').mockReturnValue(true);
    try {
      const old = await openAux('parent');
      await resetAux('parent', { workspaceId: 'ws', title: 'shell' });
      const fresh = await openAux('parent');
      registry.get(fresh.id)!.untouched = false;
      const [before] = pending.getPendingKills();
      // Refused, not re-pended: nothing came back, and its countdown runs on.
      expect(pending.restorePendingKill(pending.pendingKillKey('aux', old.id))).toBe(false);
      expect(getAux('parent')).toBe(fresh);
      expect(registry.has(old.id)).toBe(true);
      expect(pending.getPendingKills()).toEqual([before]);
    } finally {
      pending._resetPendingKillsForTesting();
      vi.restoreAllMocks();
    }
  });

  it('refuses to put an aux terminal back on a parent that has closed', async () => {
    const old = await openAux('parent');
    detachAux('parent');
    closeAuxParent('parent');
    expect(reattachAux(old)).toBe(false);
    expect(getAux('parent')).toBeUndefined();
  });


  it('rejects late aux terminal startup while its closing parent remains registered for the fade', async () => {
    let resolve!: (cwd: string | null) => void;
    host.getCwd.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const opening = openAux('parent');
    closeAuxParent('parent');
    expect(registry.has('parent')).toBe(true);
    resolve(null);
    await expect(opening).rejects.toThrow('The parent terminal has closed');
    expect(getAux('parent')).toBeUndefined();
    expect([...registry.keys()]).toEqual(['parent']);
    expect(pendingShellOpts.size).toBe(0);
  });

  it('rejects parent retirement during promotion and allows reopening after rollback', async () => {
    const aux = await openAux('parent');
    await beginPromotion('parent');
    expect(() => closeAuxParent('parent')).toThrow(/promotion/i);
    await cancelPromotion('parent');
    expect(await openAux('parent')).toBe(aux);
  });

  it('publishes the exit of an aux terminal it is watching, once', async () => {
    const aux = await openAux('parent');
    setAuxVisible('parent', true);
    const notified = vi.fn();
    const unsubscribe = subscribeAuxTerminals(notified);
    try {
      registry.get(aux.id)!.exited = true;
      await vi.advanceTimersByTimeAsync(2000);
      expect(notified).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(notified).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
  });

  it('retains an exited aux terminal on reopening, publishing the exit and never restarting it', async () => {
    const aux = await openAux('parent');
    setAuxVisible('parent', false);
    registry.get(aux.id)!.exited = true;
    const notified = vi.fn();
    const unsubscribe = subscribeAuxTerminals(notified);
    try {
      setAuxVisible('parent', true);
      expect(await openAux('parent')).toBe(aux);
      expect(notified).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await openAux('parent')).toBe(aux);
      expect(notified).toHaveBeenCalledOnce();
      expect(host.writePty).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });
  it('stops hidden polling, keeps idle until input, and still checks running work on demand', async () => {
    const aux = await openAux('parent');
    registry.get(aux.id)!.untouched = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(registry.get(aux.id)?.auxBusy).toBe(false);
    setAuxVisible('parent', false);
    host.terminalContext.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.terminalContext).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    // No input since the idle answer: a quit counts no running work for it.
    expect(registry.get(aux.id)?.auxBusy).toBe(false);
    expect(countRunningSessions()).toBe(0);
    markSessionTouched(aux.id);
    expect(registry.get(aux.id)?.auxBusy).toBeUndefined();
    expect(countRunningSessions()).toBe(1);
    host.terminalContext.mockResolvedValue({ busy: true });
    expect(await auxHasWork(aux)).toBe(true);
    setAuxVisible('parent', true);
    expect(await openAux('parent')).toBe(aux);
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.terminalContext.mock.calls.length).toBeGreaterThan(1);
  });
  it('does not start a polling loop when creation completes after the menu closes', async () => {
    let resolve!: (cwd: string | null) => void;
    host.getCwd.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const opening = openAux('parent');
    setAuxVisible('parent', false);
    resolve(null);
    await opening;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps ownership stable when a reopened menu resets or promotes during promotion', async () => {
    const aux = await openAux('parent');
    const entry = registry.get(aux.id);
    let resolve!: (value: unknown) => void;
    host.terminalContext.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const promotion = beginPromotion('parent');
    try {
      expect(await openAux('parent')).toBe(aux);
      expect(() => disposeAux('parent')).toThrow(/promotion/i);
      await expect(beginPromotion('parent')).rejects.toThrow(/promotion/i);
      expect(await auxHasWork(aux)).toBe(true);
    } finally {
      resolve({});
      await promotion;
      finishPromotion('parent');
    }
    expect(registry.get(aux.id)).toBe(entry);
    expect(entry?.aux).toBeUndefined();
    expect(getAux('parent')).toBeUndefined();
  });
  it('allows a retry and resumes inspection after a failed promotion rollback', async () => {
    const aux = await openAux('parent');
    await beginPromotion('parent');
    host.terminalContext.mockRejectedValueOnce(new Error('Host unavailable'));
    await expect(cancelPromotion('parent')).rejects.toThrow('Host unavailable');
    expect(aux.promoting).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(registry.get(aux.id)?.auxBusy).toBe(false);
    await beginPromotion('parent');
    finishPromotion('parent');
  });
  it('deduplicates opening and writes nothing to the aux terminal, at any prompt', async () => {
    const [first, second] = await Promise.all([openAux('parent'), openAux('parent')]);
    expect(first).toBe(second);
    expect(pendingShellOpts.get(first.id)?.aux).toEqual({ parentId: 'parent' });
    await vi.advanceTimersByTimeAsync(1000);
    prompt(first.id); await vi.advanceTimersByTimeAsync(100);
    prompt(first.id); await vi.advanceTimersByTimeAsync(10_000);
    expect(host.writePty).not.toHaveBeenCalled();
  });
  const reporting = (path: string, isRemote = false) => resetTerminalPaneState('parent', { cwd: { path, pathKind: 'posix', isRemote, source: 'osc7', updatedAt: 0 } });
  it('starts in the source PTY\'s process directory, whatever the source reports', async () => {
    reporting('/reported');
    host.getCwd.mockResolvedValue('/process');
    const aux = await openAux('parent');
    expect(host.getCwd).toHaveBeenCalledWith('parent');
    expect(pendingShellOpts.get(aux.id)?.cwd).toBe('/process');
    expect(getTerminalPaneState(aux.id).cwd?.path).toBe('/process');
  });
  it.each([
    ['answers nothing', () => host.getCwd.mockResolvedValue(null)],
    ['fails', () => host.getCwd.mockRejectedValue(new Error('no process table'))],
  ])('opens in the reported directory when the process read %s', async (_label, read) => {
    reporting('/reported');
    read();
    const aux = await openAux('parent');
    expect(pendingShellOpts.get(aux.id)?.cwd).toBe('/reported');
  });
  it('takes the host default for a remote source it cannot read', async () => {
    reporting('/remote/path', true);
    const aux = await openAux('parent');
    expect(pendingShellOpts.get(aux.id)?.cwd).toBeUndefined();
    expect(getTerminalPaneState(aux.id).cwd?.path).toBeUndefined();
  });
  it('keeps an untouched aux terminal on reopening, in the directory it opened in', async () => {
    host.getCwd.mockResolvedValue('/first');
    const aux = await openAux('parent');
    prompt(aux.id); await vi.advanceTimersByTimeAsync(2000);
    host.getCwd.mockResolvedValue('/moved');
    expect(await openAux('parent')).toBe(aux);
    expect(registry.has(aux.id)).toBe(true);
    expect(getTerminalPaneState(aux.id).cwd?.path).toBe('/first');
  });
  it('resets into a fresh aux terminal in the source\'s current directory', async () => {
    host.getCwd.mockResolvedValue('/first');
    const old = await openAux('parent');
    host.getCwd.mockResolvedValue('/moved');
    await resetAux('parent', { workspaceId: 'ws', title: 'shell' });
    expect(registry.has(old.id)).toBe(false);
    const next = await openAux('parent');
    expect(next.id).not.toBe(old.id);
    expect(pendingShellOpts.get(next.id)?.cwd).toBe('/moved');
  });
  it('keeps a directory reported during shell startup', async () => {
    host.getCwd.mockResolvedValue('/source');
    const aux = await openAux('parent');
    applyTerminalSemanticEvents(aux.id, [{ type: 'cwd', cwd: { path: '/startup', pathKind: 'posix', isRemote: false, source: 'osc7', updatedAt: 1 } }]);
    prompt(aux.id);
    await vi.advanceTimersByTimeAsync(100);
    expect(getTerminalPaneState(aux.id).cwd).toMatchObject({ path: '/startup', source: 'osc7' });
  });
  it('never assumes a prompt means background jobs have ended', async () => {
    const aux = await openAux('parent'); prompt(aux.id); await vi.advanceTimersByTimeAsync(100);
    host.terminalContext.mockResolvedValue({ busy: true });
    expect(await auxHasWork(aux)).toBe(true);
  });
  it('an aux terminal is not safe to close on a failed inspection', async () => {
    const aux = await openAux('parent');
    host.terminalContext.mockResolvedValue({ busy: null });
    expect(await auxHasWork(aux)).toBe(true);
  });
  it('recovered aux terminals preserve work even when replay looks idle', async () => {
    const aux = await openAux('parent'); disposeAux('parent');
    registry.set(aux.id, { untouched: false } as TerminalEntry);
    restoreAux(aux.id, { parentId: 'parent' }); prompt(aux.id);
    expect((await openAux('parent')).id).toBe(aux.id);
    await vi.advanceTimersByTimeAsync(2000); expect(host.writePty).not.toHaveBeenCalled();
    expect(registry.get(aux.id)?.auxBusy).toBe(false);
    host.terminalContext.mockResolvedValue({ busy: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(registry.get(aux.id)?.auxBusy).toBe(true);
  });
});
