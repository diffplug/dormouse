/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceMotion, collapseWorkspace, restoreWorkspaceMotion, workspaceIsCollapsed } from './workspace-motion';
import { LATH_EASING, LATH_MOTION_MS } from '../lib/lath/animator';
import { cfg } from '../cfg';

let wall: HTMLDivElement;
let tab: HTMLDivElement;
let motion: ReturnType<typeof createWorkspaceMotion>;
let now: number;
let callbacks: Map<number, FrameRequestCallback>;
let nextId: number;
const animated = cfg.layout.animate;

function frame(ms: number) {
  now += ms;
  const pending = [...callbacks.values()];
  callbacks.clear();
  pending.forEach(callback => callback(now));
}

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  nextId = 0;
  callbacks = new Map();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  cfg.layout.animate = true;
  wall = document.createElement('div');
  wall.dataset.workspaceActive = 'true';
  wall.getBoundingClientRect = () => ({ left: 0, top: 40, width: 1000, height: 600 }) as DOMRect;
  tab = document.createElement('div');
  tab.dataset.workspaceTab = 'ws-a';
  tab.getBoundingClientRect = () => ({ left: 100, top: 8, width: 100, height: 24 }) as DOMRect;
  document.body.append(wall, tab);
  motion = createWorkspaceMotion(wall, 'ws-a');
});

afterEach(() => {
  motion.dispose();
  wall.remove();
  tab.remove();
  cfg.layout.animate = animated;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('workspace motion', () => {
  it('expands from its tab with pane timing/easing, without changing layout dimensions', () => {
    motion.expand();
    expect(wall.style.transform).toBe('translate(100px, -32px) scale(0.1, 0.04)');
    expect(wall.style.opacity).toBe('0');
    frame(LATH_MOTION_MS / 2);
    expect(Number(wall.style.opacity)).toBeCloseTo(LATH_EASING(0.5));
    expect(wall.style.width).toBe('');
    expect(wall.style.height).toBe('');
    frame(LATH_MOTION_MS / 2);
    expect(wall.style.transform).toBe('');
    expect(wall.style.opacity).toBe('');
  });

  it('holds the collapsed workspace until removal and can expand after a refusal', async () => {
    const finished = vi.fn();
    const pending = collapseWorkspace('ws-a').then(finished);
    frame(LATH_MOTION_MS / 2);
    expect(finished).not.toHaveBeenCalled();
    expect(workspaceIsCollapsed('ws-a')).toBe(false);
    frame(LATH_MOTION_MS / 2);
    await pending;
    expect(workspaceIsCollapsed('ws-a')).toBe(true);
    expect(wall.style.transform).toBe('translate(100px, -32px) scale(0.1, 0.04)');
    expect(wall.style.opacity).toBe('0');
    restoreWorkspaceMotion('ws-a');
    frame(LATH_MOTION_MS);
    expect(workspaceIsCollapsed('ws-a')).toBe(false);
    expect(wall.style.transform).toBe('');
  });

  it('reverses an expansion from the frame on screen', async () => {
    motion.expand();
    frame(100);
    const visible = wall.style.transform;
    const pending = motion.collapse();
    expect(wall.style.transform).toBe(visible);
    frame(LATH_MOTION_MS);
    await pending;
    expect(workspaceIsCollapsed('ws-a')).toBe(true);
  });

  it('finishes a departure when a background window stops painting frames', async () => {
    const pending = motion.collapse();
    await vi.advanceTimersByTimeAsync(LATH_MOTION_MS);
    await pending;
    expect(workspaceIsCollapsed('ws-a')).toBe(true);
    expect(callbacks.size).toBe(0);
  });

  it('does not reopen a departing workspace when it is selected again', async () => {
    const pending = motion.collapse();
    frame(100);
    motion.hide();
    await pending;
    motion.expand();
    expect(workspaceIsCollapsed('ws-a')).toBe(true);
    expect(wall.style.opacity).toBe('0');
  });

  it('snaps with disabled motion and removes pending callbacks on disposal', async () => {
    cfg.layout.animate = false;
    motion.expand();
    expect(wall.style.transform).toBe('');
    await motion.collapse();
    expect(workspaceIsCollapsed('ws-a')).toBe(true);
    cfg.layout.animate = true;
    restoreWorkspaceMotion('ws-a');
    motion.dispose();
    expect(callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(workspaceIsCollapsed('ws-a')).toBe(false);
  });
});
