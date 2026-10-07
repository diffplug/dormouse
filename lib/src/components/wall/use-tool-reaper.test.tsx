// @vitest-environment jsdom
/**
 * When a Tool is reaped and rehydrated (`docs/specs/dor-tool.md` -> Reaping):
 * out of sight and silent for the threshold, never on the minimize itself, and
 * started again as soon as it is seen.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import { isToolReaped, markToolReaped, resetToolReaps } from '../../lib/tool-reap-store';
import { createLathWallEngine, toolLeafMeta, type LathWallEngine } from './lath-wall-engine';
import { useToolReaper } from './use-tool-reaper';
import type { DooredItem } from './wall-types';

const reaper = vi.hoisted(() => ({
  stopTool: vi.fn(async () => true),
  rehydrateTool: vi.fn(() => null),
  toolReapIdleMs: () => 10_000,
  toolReapBlocker: vi.fn((id: string): string | null => (isToolReaped(id) ? 'already reaped' : null)),
}));
vi.mock('./tool-reaper', () => reaper);

const ID = 'tool';
const IDLE_MS = 10_000;

let container: HTMLDivElement;
let root: Root;
let fake: FakePtyAdapter & { reapsTools?: boolean };
let lath: LathWallEngine;
let paused: boolean;

function Harness({ doors, active }: { doors: DooredItem[]; active: boolean }) {
  const doorsRef = { current: doors };
  useToolReaper({ lath, doors, doorsRef, active, paused: () => paused });
  return null;
}

const door: DooredItem = { id: ID } as DooredItem;

function render(doors: DooredItem[], active = true): void {
  act(() => root.render(<Harness doors={doors} active={active} />));
}

beforeEach(() => {
  vi.useFakeTimers();
  fake = new FakePtyAdapter();
  fake.reapsTools = true;
  setPlatform(fake);
  lath = createLathWallEngine();
  lath.store.addLeaf(ID, toolLeafMeta('Viewer', { surfaceType: 'tool', command: 'viewer' }), null);
  paused = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetToolReaps();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('useToolReaper', () => {
  it('never reaps a Tool in sight, however idle', () => {
    render([]);
    act(() => { vi.advanceTimersByTime(IDLE_MS * 3); });
    expect(reaper.stopTool).not.toHaveBeenCalled();
  });

  it('reaps a Doored Tool once the threshold passes, never on the minimize itself', () => {
    render([door]);
    expect(reaper.stopTool).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(IDLE_MS - 3_000); });
    expect(reaper.stopTool).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(reaper.stopTool).toHaveBeenCalledWith(lath, ID);
  });

  it('reaps the Tools of an inactive Workspace', () => {
    render([], false);
    act(() => { vi.advanceTimersByTime(IDLE_MS); });
    expect(reaper.stopTool).toHaveBeenCalledWith(lath, ID);
  });

  it('restarts the clock on output: a Tool still printing is in use', () => {
    render([door]);
    fake.spawnPty(ID);
    act(() => { vi.advanceTimersByTime(IDLE_MS - 3_000); });
    fake.sendOutput(ID, 'rebuilt\r\n');
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(reaper.stopTool).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(IDLE_MS); });
    expect(reaper.stopTool).toHaveBeenCalled();
  });

  it('stops nothing while the Workspace closes or moves', () => {
    paused = true;
    render([door]);
    act(() => { vi.advanceTimersByTime(IDLE_MS * 2); });
    expect(reaper.stopTool).not.toHaveBeenCalled();
  });

  it('rehydrates a reaped Tool the moment it is reattached or its Workspace shown', () => {
    markToolReaped(ID, { payload: null, cwd: null, alert: null });
    render([door], false);
    expect(reaper.rehydrateTool).not.toHaveBeenCalled();
    render([door], true);
    expect(reaper.rehydrateTool).not.toHaveBeenCalled();
    render([], true);
    expect(reaper.rehydrateTool).toHaveBeenCalledWith(lath, ID);
  });

  it('starts a Tool shown while it was stopping as soon as the stop ends', async () => {
    let finish!: () => void;
    reaper.stopTool.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finish = () => { markToolReaped(ID, { payload: null, cwd: null, alert: null }); resolve(true); };
    }));
    render([door]);
    act(() => { vi.advanceTimersByTime(IDLE_MS); });
    render([]);
    // Shown mid-stop: not reaped yet, so nothing to start until the stop ends.
    reaper.rehydrateTool.mockClear();
    await act(async () => { finish(); });
    expect(reaper.rehydrateTool).toHaveBeenCalledWith(lath, ID);
  });

  it('never starts a stop for a Tool that may not be stopped', () => {
    reaper.toolReapBlocker.mockReturnValueOnce('a preview slot');
    render([], false);
    act(() => { vi.advanceTimersByTime(IDLE_MS); });
    expect(reaper.stopTool).not.toHaveBeenCalled();
  });

  it('asks a Tool whose stop fell through again next tick, not at once', async () => {
    // Past a bound the stop never settles, so a regression fails here rather
    // than spinning the microtask queue forever.
    reaper.stopTool.mockImplementation(() =>
      reaper.stopTool.mock.calls.length > 5 ? new Promise<boolean>(() => {}) : Promise.resolve(false));
    render([], false);
    act(() => { vi.advanceTimersByTime(IDLE_MS); });
    await act(async () => {});
    expect(reaper.stopTool).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(IDLE_MS / 4); });
    await act(async () => {});
    expect(reaper.stopTool).toHaveBeenCalledTimes(2);
  });

  it('never rehydrates into a closing or transferring Workspace', () => {
    markToolReaped(ID, { payload: null, cwd: null, alert: null });
    paused = true;
    render([]);
    expect(reaper.rehydrateTool).not.toHaveBeenCalled();
  });

  it('does nothing on a host that runs no processes', () => {
    fake.reapsTools = false;
    render([door]);
    act(() => { vi.advanceTimersByTime(IDLE_MS * 2); });
    expect(reaper.stopTool).not.toHaveBeenCalled();
  });
});
