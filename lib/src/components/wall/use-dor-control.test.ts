/**
 * A preview slot switch's terminal ready signal (`docs/specs/dor-tool.md` ->
 * Switching the slot); the rendered switch is pinned by `preview-slot.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatform } from '../../lib/platform';
import { FakePtyAdapter } from '../../lib/platform/fake-adapter';
import { applyTerminalSemanticEvents, removeTerminalPaneState } from '../../lib/terminal-state-store';
import { PREVIEW_OUTPUT_QUIET_MS, watchTerminalReady } from './use-dor-control';

let fake: FakePtyAdapter;

beforeEach(() => {
  fake = new FakePtyAdapter();
  setPlatform(fake);
  vi.useFakeTimers();
});

afterEach(() => {
  removeTerminalPaneState('slot');
  vi.useRealTimers();
});

describe('watchTerminalReady', () => {
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

  it('stops listening once stopped', () => {
    const { onReady, stop } = watch();
    fake.sendOutput('slot', '# b\r\n');
    stop();
    vi.advanceTimersByTime(PREVIEW_OUTPUT_QUIET_MS);
    applyTerminalSemanticEvents('slot', [{ type: 'commandFinish', exitCode: 1 }]);
    expect(onReady).not.toHaveBeenCalled();
  });
});
