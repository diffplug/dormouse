// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registry, pendingShellOpts, type TerminalEntry } from './terminal-store';
import { applyTerminalSemanticEvents, getTerminalPaneState, resetTerminalPaneState, removeTerminalPaneState } from './terminal-state-store';
import { beginPromotion, cancelPromotion, closeHelperParent, disposeHelper, finishPromotion, getHelper, helperHasWork, openHelper, restoreHelper, setHelperVisible, subscribeHelpers } from './helper-terminal';

const host = vi.hoisted(() => ({ writePty: vi.fn(), terminalContext: vi.fn() }));
vi.mock('./platform', () => ({ getPlatform: () => host }));
vi.mock('./terminal-lifecycle', () => ({
  parkElement: vi.fn(),
  setPendingShellOpts: (id: string, options: unknown) => pendingShellOpts.set(id, options as never),
  getOrCreateTerminal: (id: string) => { const entry = { untouched: true, helper: pendingShellOpts.get(id)?.helper } as TerminalEntry; registry.set(id, entry); resetTerminalPaneState(id); return entry; },
  disposeSession: (id: string) => { registry.delete(id); removeTerminalPaneState(id); },
}));
beforeEach(() => {
  vi.useFakeTimers(); host.writePty.mockReset(); host.terminalContext.mockReset();
  host.terminalContext.mockResolvedValue({ home: '/home/user', command: 'git status', busy: false });
  registry.set('parent', { untouched: true } as TerminalEntry); resetTerminalPaneState('parent');
  setHelperVisible('parent', true);
});
afterEach(() => { setHelperVisible('parent', false); disposeHelper('parent'); registry.clear(); pendingShellOpts.clear(); removeTerminalPaneState('parent'); vi.useRealTimers(); });
const prompt = (id: string) => applyTerminalSemanticEvents(id, [{ type: 'promptStart' }, { type: 'promptEnd' }]);

describe('helper lifecycle', () => {
  it('rejects late helper startup while its closing parent remains registered for the fade', async () => {
    let resolve!: (value: unknown) => void;
    host.terminalContext.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const opening = openHelper('parent');
    closeHelperParent('parent');
    expect(registry.has('parent')).toBe(true);
    resolve({ command: 'git status' });
    await expect(opening).rejects.toThrow('The parent terminal has closed');
    expect(getHelper('parent')).toBeUndefined();
    expect([...registry.keys()]).toEqual(['parent']);
    expect(pendingShellOpts.size).toBe(0);
  });

  it('rejects parent retirement during promotion and allows reopening after rollback', async () => {
    const helper = await openHelper('parent');
    await beginPromotion('parent');
    expect(() => closeHelperParent('parent')).toThrow(/promotion/i);
    await cancelPromotion('parent');
    expect(await openHelper('parent')).toBe(helper);
  });

  it.each(['exited', 'preserved', 'completed'] as const)('publishes %s on reopening before another polling tick', async status => {
    const helper = await openHelper('parent');
    helper.status = 'running';
    setHelperVisible('parent', false);
    const entry = registry.get(helper.id)!;
    entry.exited = status === 'exited';
    entry.untouched = status !== 'preserved';
    prompt(helper.id);
    // Preserve even an untouched completion so this asserts publication on
    // reuse, rather than observing a replacement helper's creation event.
    host.terminalContext.mockResolvedValue({ busy: true });
    const notified = vi.fn();
    const unsubscribe = subscribeHelpers(notified);
    try {
      setHelperVisible('parent', true);
      expect(await openHelper('parent')).toBe(helper);
      expect(helper.status).toBe(status);
      expect(notified).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
  });
  it('stops hidden polling, invalidates idle, and still checks running work on demand', async () => {
    const helper = await openHelper('parent');
    registry.get(helper.id)!.untouched = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(registry.get(helper.id)?.helperBusy).toBe(false);
    setHelperVisible('parent', false);
    host.terminalContext.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.terminalContext).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(registry.get(helper.id)?.helperBusy).toBeUndefined();
    host.terminalContext.mockResolvedValue({ busy: true });
    expect(await helperHasWork(helper)).toBe(true);
    setHelperVisible('parent', true);
    expect(await openHelper('parent')).toBe(helper);
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.terminalContext.mock.calls.length).toBeGreaterThan(1);
  });
  it('does not start a polling loop when creation completes after the menu closes', async () => {
    let resolve!: (value: unknown) => void;
    host.terminalContext.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const opening = openHelper('parent');
    setHelperVisible('parent', false);
    resolve({ command: 'git status' });
    const helper = await opening;
    prompt(helper.id);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(host.writePty).not.toHaveBeenCalled();
    setHelperVisible('parent', true);
    await openHelper('parent');
    await vi.advanceTimersByTimeAsync(100);
    expect(host.writePty).toHaveBeenCalledExactlyOnceWith(helper.id, 'git status\r');
  });
  it('keeps ownership stable when a reopened menu resets or promotes during promotion', async () => {
    const helper = await openHelper('parent');
    const entry = registry.get(helper.id);
    let resolve!: (value: unknown) => void;
    host.terminalContext.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const promotion = beginPromotion('parent');
    try {
      expect(await openHelper('parent')).toBe(helper);
      expect(() => disposeHelper('parent')).toThrow(/promotion/i);
      await expect(beginPromotion('parent')).rejects.toThrow(/promotion/i);
      expect(await helperHasWork(helper)).toBe(true);
    } finally {
      resolve({});
      await promotion;
      finishPromotion('parent');
    }
    expect(registry.get(helper.id)).toBe(entry);
    expect(entry?.helper).toBeUndefined();
    expect(getHelper('parent')).toBeUndefined();
  });
  it('allows a retry and resumes inspection after a failed promotion rollback', async () => {
    const helper = await openHelper('parent');
    await beginPromotion('parent');
    host.terminalContext.mockRejectedValueOnce(new Error('Host unavailable'));
    await expect(cancelPromotion('parent')).rejects.toThrow('Host unavailable');
    expect(helper.promoting).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(registry.get(helper.id)?.helperBusy).toBe(false);
    await beginPromotion('parent');
    finishPromotion('parent');
  });
  it('deduplicates opening and runs once only after a real prompt', async () => {
    const [first, second] = await Promise.all([openHelper('parent'), openHelper('parent')]);
    expect(first).toBe(second);
    await vi.advanceTimersByTimeAsync(1000); expect(host.writePty).not.toHaveBeenCalled();
    prompt(first.id); await vi.advanceTimersByTimeAsync(100);
    expect(host.writePty).toHaveBeenCalledExactlyOnceWith(first.id, 'git status\r');
    prompt(first.id); await vi.advanceTimersByTimeAsync(500);
    expect(first.status).toBe('completed'); expect(host.writePty).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['a local parent cwd', false, '/work'],
    ['no cwd from a remote parent', true, undefined],
  ])('spawns and records %s', async (_label, isRemote, expected) => {
    resetTerminalPaneState('parent', { cwd: { path: '/work', pathKind: 'posix', isRemote, source: 'osc7', updatedAt: 0 } });
    const helper = await openHelper('parent');
    expect(pendingShellOpts.get(helper.id)?.cwd).toBe(expected);
    prompt(helper.id); await vi.advanceTimersByTimeAsync(100);
    expect(getTerminalPaneState(helper.id).cwd?.path).toBe(expected);
  });
  it('user input during startup cancels autorun and remains preserved at idle', async () => {
    const helper = await openHelper('parent'); registry.get(helper.id)!.untouched = false;
    prompt(helper.id); await vi.advanceTimersByTimeAsync(100);
    expect(host.writePty).not.toHaveBeenCalled(); expect(helper.status).toBe('preserved');
    expect(await openHelper('parent')).toBe(helper);
  });
  it('never assumes a prompt means background jobs have ended', async () => {
    const helper = await openHelper('parent'); prompt(helper.id); await vi.advanceTimersByTimeAsync(100);
    prompt(helper.id); await vi.advanceTimersByTimeAsync(100);
    host.terminalContext.mockResolvedValue({ command: 'git status', busy: true });
    expect(await helperHasWork(helper)).toBe(true); expect(await openHelper('parent')).toBe(helper);
    host.terminalContext.mockResolvedValue({ command: 'git status', busy: false });
    expect((await openHelper('parent')).id).not.toBe(helper.id);
  });
  it('does not drop input received during an asynchronous idle check', async () => {
    const helper = await openHelper('parent'); helper.status = 'completed'; prompt(helper.id);
    let resolve!: (value: unknown) => void;
    host.terminalContext.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const reopened = openHelper('parent'); registry.get(helper.id)!.untouched = false;
    resolve({ busy: false }); expect(await reopened).toBe(helper);
  });
  it('reset cancels stale autorun callbacks and uses the latest global command', async () => {
    const old = await openHelper('parent'); disposeHelper('parent');
    host.terminalContext.mockResolvedValue({ command: 'echo next', busy: false });
    const next = await openHelper('parent'); prompt(old.id); prompt(next.id);
    await vi.advanceTimersByTimeAsync(100);
    expect(host.writePty).toHaveBeenCalledExactlyOnceWith(next.id, 'echo next\r');
    removeTerminalPaneState(old.id);
  });
  it('missing integration never receives a timeout write and is not safe to close', async () => {
    const helper = await openHelper('parent'); await vi.advanceTimersByTimeAsync(9000);
    expect(helper.status).toBe('unsupported'); expect(host.writePty).not.toHaveBeenCalled();
    host.terminalContext.mockResolvedValue({ busy: null });
    expect(await helperHasWork(helper)).toBe(true);
  });
  it('recovered helpers preserve work even when replay looks idle', async () => {
    const helper = await openHelper('parent'); disposeHelper('parent');
    registry.set(helper.id, { untouched: false } as TerminalEntry);
    restoreHelper(helper.id, { parentId: 'parent', command: 'git status' }); prompt(helper.id);
    expect((await openHelper('parent')).id).toBe(helper.id); expect(getHelper('parent')?.status).toBe('preserved');
    await vi.advanceTimersByTimeAsync(2000); expect(host.writePty).not.toHaveBeenCalled();
    expect(registry.get(helper.id)?.helperBusy).toBe(false);
    host.terminalContext.mockResolvedValue({ busy: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(registry.get(helper.id)?.helperBusy).toBe(true);
  });
});
