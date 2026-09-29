/**
 * The preview slot switch's lifecycle (`docs/specs/dor-tool.md` -> Preview
 * slot): ownership, commit, readiness, and the fallback. The rendered switch
 * is pinned by `lib/src/components/wall/preview-slot.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter } from './platform/fake-adapter';
import { setPlatform } from './platform';
import {
  beginPreviewTransition,
  clearPreviewTransition,
  commitPreviewTransition,
  endPreviewTransition,
  getPreviewSlotView,
  PREVIEW_OUTPUT_QUIET_MS,
  PREVIEW_READY_FALLBACK_MS,
  PREVIEW_REVEAL_MS,
  previewLayerReady,
  resetPreviewTransitions,
  watchTerminalReady,
  type PreviewGhost,
} from './preview-transition-store';
import { applyTerminalSemanticEvents, removeTerminalPaneState } from './terminal-state-store';

const ghost: PreviewGhost = { kind: 'layer', generation: 0, params: { url: 'http://localhost:6006/' } };
const commit = { label: 'b.md', command: 'view b.md', terminalFace: () => false };

let fake: FakePtyAdapter;

beforeEach(() => {
  fake = new FakePtyAdapter();
  setPlatform(fake);
  vi.useFakeTimers();
});

afterEach(() => {
  resetPreviewTransitions();
  removeTerminalPaneState('slot');
  vi.useRealTimers();
});

const begin = (instant = false) => beginPreviewTransition('slot', () => ({ ghost, header: 'held' }), instant)!;
const transition = () => getPreviewSlotView('slot').transition;

describe('ownership', () => {
  it('lets a newer preview take over, keeping the ghost, so only it can end or commit', () => {
    const first = begin();
    const capture = vi.fn(() => ({ ghost: { kind: 'terminal' } as const, header: 'half-switched' }));
    const second = beginPreviewTransition('slot', capture, false)!;
    expect(second).not.toBe(first);
    expect(capture).not.toHaveBeenCalled();
    expect(transition()).toMatchObject({ token: second, ghost, header: 'held', phase: 'holding' });
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

  it('returns a takeover to holding, cancelling the committed switch\'s signals', () => {
    const first = begin();
    commitPreviewTransition('slot', first, commit);
    const stopWatching = vi.spyOn(fake, 'offPtyData');
    const second = begin();
    expect(stopWatching).toHaveBeenCalledOnce();
    expect(transition()).toMatchObject({ token: second, phase: 'holding', label: 'b.md' });
    previewLayerReady('slot', 1);
    vi.advanceTimersByTime(PREVIEW_READY_FALLBACK_MS);
    expect(transition()?.phase).toBe('holding');
    expect(commitPreviewTransition('slot', second, { ...commit, label: 'c.md' })).toBe(true);
    expect(getPreviewSlotView('slot')).toMatchObject({ generation: 2, transition: { phase: 'committed', label: 'c.md' } });
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

describe('a terminal-only Tool', () => {
  function watch(terminalFace = true) {
    fake.spawnPty('slot');
    applyTerminalSemanticEvents('slot', [{ type: 'commandFinish', exitCode: 130 }]);
    const onReady = vi.fn();
    const stop = watchTerminalReady('slot', 'less /repo/b.md', () => terminalFace, onReady);
    applyTerminalSemanticEvents('slot', [
      { type: 'commandLine', commandLine: 'less /repo/b.md' }, { type: 'commandStart', source: 'osc633_boundaries' },
    ]);
    return { onReady, stop };
  }

  it('is ready once visible output goes quiet, but not on its echo or OSC alone', () => {
    const { onReady, stop } = watch();
    fake.sendOutput('slot', 'less /repo/b.md\r\n\x1b]2;b.md\x07\x1b[?1049h');
    vi.advanceTimersByTime(PREVIEW_OUTPUT_QUIET_MS);
    expect(onReady).not.toHaveBeenCalled();
    fake.sendOutput('slot', '# b\r\n');
    vi.advanceTimersByTime(PREVIEW_OUTPUT_QUIET_MS - 1);
    fake.sendOutput('slot', 'more\r\n');
    vi.advanceTimersByTime(PREVIEW_OUTPUT_QUIET_MS - 1);
    expect(onReady).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReady).toHaveBeenCalledOnce();
    stop();
  });

  it('waits on a browser face, however quiet the terminal', () => {
    const { onReady, stop } = watch(false);
    fake.sendOutput('slot', 'Serving on :7007\r\n');
    vi.advanceTimersByTime(PREVIEW_OUTPUT_QUIET_MS);
    expect(onReady).not.toHaveBeenCalled();
    stop();
  });

  it('is ready when its command finishes', () => {
    const { onReady, stop } = watch();
    applyTerminalSemanticEvents('slot', [{ type: 'commandFinish', exitCode: 1 }]);
    expect(onReady).toHaveBeenCalledOnce();
    stop();
  });
});
