/**
 * The preview slot switch's lifecycle (`docs/specs/dor-tool.md` -> Preview
 * slot): ownership, commit, readiness, and the fallback. The rendered switch
 * is pinned by `lib/src/components/wall/preview-slot.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginPreviewTransition,
  clearPreviewTransition,
  commitPreviewTransition,
  endPreviewTransition,
  getPreviewSlotView,
  PREVIEW_READY_FALLBACK_MS,
  PREVIEW_REVEAL_MS,
  previewLayerReady,
  resetPreviewTransitions,
  type PreviewGhost,
} from './preview-transition-store';

const ghost: PreviewGhost = { kind: 'layer', generation: 0, params: { url: 'http://localhost:6006/' } };
const commit = { label: 'b.md', arm: () => () => {} };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetPreviewTransitions();
  vi.useRealTimers();
});

const begin = (instant = false) => beginPreviewTransition('slot', () => ghost, instant)!;
const transition = () => getPreviewSlotView('slot').transition;

describe('ownership', () => {
  it('lets a newer preview take over, keeping the ghost, so only it can end or commit', () => {
    const first = begin();
    const capture = vi.fn((): PreviewGhost => ({ kind: 'terminal' }));
    const second = beginPreviewTransition('slot', capture, false)!;
    expect(second).not.toBe(first);
    expect(capture).not.toHaveBeenCalled();
    expect(transition()).toMatchObject({ token: second, ghost, phase: 'holding' });
    // The superseded request's answer.
    endPreviewTransition('slot', first);
    expect(commitPreviewTransition('slot', first, commit)).toBe(false);
    expect(transition()?.token).toBe(second);
    endPreviewTransition('slot', second);
    expect(transition()).toBeNull();
  });

  it('holds nothing when there is nothing to capture', () => {
    expect(beginPreviewTransition('slot', () => null, false)).toBeNull();
    expect(getPreviewSlotView('slot')).toEqual({ generation: 0, transition: null });
  });

  it('ends nothing for its owner once committed', () => {
    const token = begin();
    commitPreviewTransition('slot', token, commit);
    endPreviewTransition('slot', token);
    expect(transition()?.phase).toBe('committed');
  });

  it('returns a takeover to holding, keeping the committed switch\'s signals until the takeover commits', () => {
    const first = begin();
    const stopWatching = vi.fn();
    const arm = vi.fn<(ready: () => void) => () => void>(() => stopWatching);
    commitPreviewTransition('slot', first, { ...commit, arm });
    const second = begin();
    expect(stopWatching).not.toHaveBeenCalled();
    // The header still names the retarget that happened.
    expect(transition()).toMatchObject({ token: second, phase: 'holding', label: 'b.md' });
    // Ready while the takeover holds: nothing shows until it ends.
    previewLayerReady('slot', 1);
    expect(transition()?.phase).toBe('holding');
    expect(commitPreviewTransition('slot', second, { ...commit, label: 'c.md' })).toBe(true);
    expect(getPreviewSlotView('slot')).toMatchObject({ generation: 2, transition: { phase: 'committed', label: 'c.md' } });
    // The replaced view's signal reveals nothing.
    arm.mock.calls[0][0]();
    vi.advanceTimersByTime(PREVIEW_READY_FALLBACK_MS - 1);
    expect(transition()?.phase).toBe('committed');
  });

  it('goes on waiting for a committed view when its takeover ends without committing', () => {
    const first = begin();
    const stopWatching = vi.fn();
    commitPreviewTransition('slot', first, { ...commit, arm: () => stopWatching });
    const second = begin();
    endPreviewTransition('slot', second);
    expect(transition()).toMatchObject({ token: second, phase: 'committed', label: 'b.md' });
    previewLayerReady('slot', 1);
    expect(stopWatching).toHaveBeenCalledOnce();
    expect(transition()?.phase).toBe('revealing');
    vi.advanceTimersByTime(PREVIEW_REVEAL_MS);
    expect(getPreviewSlotView('slot')).toEqual({ generation: 1, transition: null });
  });

  it.each([
    ['its layer', () => previewLayerReady('slot', 1)],
    ['the fallback', () => vi.advanceTimersByTime(PREVIEW_READY_FALLBACK_MS)],
  ])('fades in a committed view ready by %s during its takeover once the takeover ends', (_, ready) => {
    commitPreviewTransition('slot', begin(), commit);
    const second = begin();
    ready();
    expect(transition()?.phase).toBe('holding');
    endPreviewTransition('slot', second);
    expect(transition()?.phase).toBe('revealing');
    vi.advanceTimersByTime(PREVIEW_REVEAL_MS);
    expect(transition()).toBeNull();
  });

  it('holds a view fading in that a preview takes over, and fades it in again when that one ends', () => {
    commitPreviewTransition('slot', begin(), commit);
    previewLayerReady('slot', 1);
    const second = begin();
    vi.advanceTimersByTime(PREVIEW_REVEAL_MS);
    expect(transition()).toMatchObject({ token: second, phase: 'holding' });
    endPreviewTransition('slot', second);
    expect(transition()?.phase).toBe('revealing');
  });

  it('forgets a leaf whose Session is gone', () => {
    commitPreviewTransition('slot', begin(), commit);
    clearPreviewTransition('slot');
    expect(getPreviewSlotView('slot')).toEqual({ generation: 0, transition: null });
  });
});

describe('readiness', () => {
  it('commits a new generation, whose layer alone reveals the new view', () => {
    const token = begin();
    expect(commitPreviewTransition('slot', token, commit)).toBe(true);
    expect(getPreviewSlotView('slot')).toMatchObject({ generation: 1, transition: { phase: 'committed', label: 'b.md' } });
    previewLayerReady('slot', 0);
    expect(transition()?.phase).toBe('committed');
    previewLayerReady('slot', 1);
    expect(transition()?.phase).toBe('revealing');
    vi.advanceTimersByTime(PREVIEW_REVEAL_MS - 1);
    expect(transition()?.phase).toBe('revealing');
    vi.advanceTimersByTime(1);
    expect(getPreviewSlotView('slot')).toEqual({ generation: 1, transition: null });
  });

  it('reveals on the signal its committer armed', () => {
    let ready!: () => void;
    commitPreviewTransition('slot', begin(), { ...commit, arm: signal => { ready = signal; return () => {}; } });
    expect(transition()?.phase).toBe('committed');
    ready();
    expect(transition()?.phase).toBe('revealing');
  });

  it('reveals at once, and stops its signal, when its committer finds the view already ready', () => {
    const stopWatching = vi.fn();
    commitPreviewTransition('slot', begin(), { ...commit, arm: ready => { ready(); return stopWatching; } });
    expect(transition()?.phase).toBe('revealing');
    expect(stopWatching).toHaveBeenCalledOnce();
  });

  it('swaps at once when motion is instant', () => {
    commitPreviewTransition('slot', begin(true), commit);
    previewLayerReady('slot', 1);
    expect(transition()).toBeNull();
  });

  it('reveals regardless once the fallback runs out', () => {
    commitPreviewTransition('slot', begin(), commit);
    vi.advanceTimersByTime(PREVIEW_READY_FALLBACK_MS - 1);
    expect(transition()?.phase).toBe('committed');
    vi.advanceTimersByTime(1);
    expect(transition()?.phase).toBe('revealing');
  });

  it('ignores a layer before its switch commits', () => {
    begin();
    previewLayerReady('slot', 0);
    expect(transition()?.phase).toBe('holding');
  });
});
