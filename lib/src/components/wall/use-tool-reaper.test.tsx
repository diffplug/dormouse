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
import { markToolReaped, resetToolReaps } from '../../lib/tool-reap-store';
import { createLathWallEngine, toolLeafMeta, type LathWallEngine } from './lath-wall-engine';
import { useToolReaper } from './use-tool-reaper';
import type { DooredItem } from './wall-types';

const reaper = vi.hoisted(() => ({
  stopTool: vi.fn(async () => true),
  rehydrateTool: vi.fn(() => true),
  toolReapBlocker: vi.fn((): string | null => null),
  toolReapIdleMs: () => 10_000,
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

  it('stops nothing the blocker refuses, or while the Workspace closes or moves', () => {
    reaper.toolReapBlocker.mockReturnValue('it never declared itself safe to stop');
    render([door]);
    act(() => { vi.advanceTimersByTime(IDLE_MS * 2); });
    expect(reaper.stopTool).not.toHaveBeenCalled();
    reaper.toolReapBlocker.mockReturnValue(null);
    paused = true;
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
