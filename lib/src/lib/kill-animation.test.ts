/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import { orchestrateKill } from './kill-animation';
import { prefersReducedMotion } from './ui-geometry';

// kill-animation only touches disposeSession from the registry; replace the
// whole module so its heavy xterm deps never load in the test env.
vi.mock('./terminal-registry', () => ({ disposeSession: vi.fn() }));

// prefersReducedMotion decides animated vs. sync finalize. Default it false so
// the animated (animationend) path arms; case 4 flips it true.
vi.mock('./ui-geometry', () => ({ prefersReducedMotion: vi.fn(() => false) }));

interface FakePanel {
  id: string;
  api: { group: { element: HTMLElement } };
}

/**
 * Minimal DockviewApi that orchestrateKill exercises: getPanel, removePanel,
 * panels, onDidRemovePanel, plus panel.api.group.element as a real DOM node so
 * the animated path arms. removePanel throws on an already-removed panel, the
 * way dockview's DockviewGroupPanelModel.removePanel does ('invalid operation').
 */
function makeApi(ids: string[]) {
  const map = new Map<string, FakePanel>();
  const order = ids.slice();
  for (const id of ids) {
    const element = document.createElement('div');
    document.body.appendChild(element);
    map.set(id, { id, api: { group: { element } } });
  }
  const removePanel = vi.fn((panel: FakePanel) => {
    if (!map.has(panel.id)) throw new Error('invalid operation');
    map.delete(panel.id);
    const i = order.indexOf(panel.id);
    if (i >= 0) order.splice(i, 1);
  });
  // Drop a panel without going through the removePanel mock — models a CLI kill
  // or replaceSurface swap that races the animated finalize.
  const evict = (id: string) => {
    map.delete(id);
    const i = order.indexOf(id);
    if (i >= 0) order.splice(i, 1);
  };
  const api = {
    getPanel: (id: string) => map.get(id),
    removePanel,
    onDidRemovePanel: () => ({ dispose: () => {} }),
    get panels() { return order.map((id) => map.get(id)!); },
    get totalPanels() { return order.length; },
  } as unknown as DockviewApi;
  return {
    api,
    removePanel,
    evict,
    elementOf: (id: string) => map.get(id)!.api.group.element,
    panelOf: (id: string) => map.get(id)!,
  };
}

/** jsdom supports constructing AnimationEvent; fall back to a tagged Event. */
function dispatchAnimationEnd(el: HTMLElement, animationName: string): void {
  let ev: Event;
  try {
    ev = new AnimationEvent('animationend', { animationName });
  } catch {
    ev = new Event('animationend');
    Object.defineProperty(ev, 'animationName', { value: animationName });
  }
  el.dispatchEvent(ev);
}

// Non-last-pane fade animation name; matched by the animationend handler.
const FADE = 'pane-fade-out';

describe('orchestrateKill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    vi.mocked(prefersReducedMotion).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('double orchestrateKill + one animationend removes the panel exactly once', () => {
    const { api, removePanel, elementOf } = makeApi(['a', 'b']);
    const killedEl = elementOf('a');
    const selectPane = vi.fn();
    const setSelectedId = vi.fn();
    const killInProgressRef = { current: false };

    // Two confirm keydowns processed before a re-render: both invocations arm a
    // listener on the same killed group element.
    orchestrateKill(api, 'a', selectPane, setSelectedId, killInProgressRef, { current: null });
    orchestrateKill(api, 'a', selectPane, setSelectedId, killInProgressRef, { current: null });

    // One real animationend fires BOTH listeners → two finalizes race.
    dispatchAnimationEnd(killedEl, FADE);

    // Identity re-check means the second finalize skips the stale removePanel
    // (which would throw 'invalid operation'); called exactly once, no throw.
    expect(removePanel).toHaveBeenCalledTimes(1);
    expect(killInProgressRef.current).toBe(false);
  });

  it('competing removal before finalize: no removePanel, no throw, selection tail still runs', () => {
    const { api, removePanel, evict, elementOf, panelOf } = makeApi(['a', 'b']);
    const killedEl = elementOf('a');
    const killedPanel = panelOf('a');
    const selectPane = vi.fn();
    const setSelectedId = vi.fn();
    const killInProgressRef = { current: false };

    orchestrateKill(api, 'a', selectPane, setSelectedId, killInProgressRef, { current: null });

    // A CLI kill / replaceSurface removes the panel before the animation ends.
    evict('a');
    expect(api.getPanel('a')).toBeUndefined();

    dispatchAnimationEnd(killedEl, FADE);

    // getPanel('a') no longer === the captured panel, so removePanel is skipped.
    expect(removePanel).not.toHaveBeenCalled();
    expect(removePanel).not.toHaveBeenCalledWith(killedPanel);
    expect(killInProgressRef.current).toBe(false);
    // Selection tail still runs: one survivor remains.
    expect(selectPane).toHaveBeenCalledWith('b');
  });

  it('normal single kill removes the panel once and runs the selection tail', () => {
    const { api, removePanel, elementOf, panelOf } = makeApi(['a', 'b']);
    const killedEl = elementOf('a');
    const killedPanel = panelOf('a');
    const selectPane = vi.fn();
    const setSelectedId = vi.fn();
    const killInProgressRef = { current: false };

    orchestrateKill(api, 'a', selectPane, setSelectedId, killInProgressRef, { current: null });
    dispatchAnimationEnd(killedEl, FADE);

    expect(removePanel).toHaveBeenCalledTimes(1);
    expect(removePanel).toHaveBeenCalledWith(killedPanel);
    expect(killInProgressRef.current).toBe(false);
    expect(selectPane).toHaveBeenCalledWith('b');
  });

  it('reduced-motion sync path removes the panel synchronously', () => {
    vi.mocked(prefersReducedMotion).mockReturnValue(true);
    const { api, removePanel, panelOf } = makeApi(['a', 'b']);
    const killedPanel = panelOf('a');
    const selectPane = vi.fn();
    const setSelectedId = vi.fn();
    const killInProgressRef = { current: false };

    // No animationend needed: reduced motion finalizes inline.
    orchestrateKill(api, 'a', selectPane, setSelectedId, killInProgressRef, { current: null });

    expect(removePanel).toHaveBeenCalledTimes(1);
    expect(removePanel).toHaveBeenCalledWith(killedPanel);
    expect(killInProgressRef.current).toBe(false);
    expect(selectPane).toHaveBeenCalledWith('b');
  });
});
