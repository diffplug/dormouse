import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertManager } from './alert-manager';
import { QuiesceDetector } from './quiesce-detector';
import { cfg } from '../cfg';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** One output chunk a second for `ms`, which never lets the pane go quiet. */
function heartbeat(target: AlertManager, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    vi.advanceTimersByTime(1_000);
    target.onData('pane');
  }
}

describe('live alert handoff', () => {
  it('preserves an episode across live handoff, while cold restore remains silent', () => {
    const source = new AlertManager();
    source.notifyFromProtocol('pane', { source: 'OSC 9', title: 'Done', body: null });
    const first = source.getState('pane');
    const snapshot = source.pauseForTransfer('pane')!;
    source.acknowledge('pane', { input: true });
    source.clearTodo('pane');
    expect(source.getState('pane')).toEqual(first);
    const target = new AlertManager();
    target.resumeFromTransfer('pane', JSON.parse(JSON.stringify(snapshot)));
    expect(target.getState('pane')).toEqual(first);
    target.notifyFromProtocol('pane', { source: 'BEL', title: 'More detail', body: null });
    expect(target.getState('pane').episode).toEqual(first.episode);
    target.dismissAlert('pane');
    target.onData('pane');
    target.notifyFromProtocol('pane', { source: 'BEL', title: 'Next', body: null });
    expect(target.getState('pane').episode?.id).toBeTruthy();
    expect(target.getState('pane').episode?.id).not.toBe(first.episode?.id);
    target.seed('pane', snapshot);
    expect(target.getState('pane')).toMatchObject({ todo: true, episode: null });
    source.dispose(); target.dispose();
  });

  it('leaves behind what the source held, and arms the command it saw', () => {
    const source = new AlertManager();
    source.setViewer('source', { present: true, focusId: 'pane' });
    source.applyTerminalSemanticEvents('pane', [
      { type: 'commandLine', commandLine: 'pnpm build' },
      { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
    ]);
    source.notifyFromProtocol('pane', { source: 'OSC 9', title: null, body: 'needs input' });
    const snapshot = source.pauseForTransfer('pane')!;

    const target = new AlertManager();
    target.resumeFromTransfer('pane', JSON.parse(JSON.stringify(snapshot)));
    expect(target.getState('pane').status).toBe('COMMAND_EXIT_ARMED');
    // Leaving the source window disengaged it: nothing it held escalates here.
    target.setViewer('target', { present: true, focusId: 'pane' });
    target.setViewer('target', { present: false, focusId: 'pane' }, 'idle');
    expect(target.getState('pane')).toMatchObject({ todo: false, notification: null });
    source.dispose(); target.dispose();
  });

  it('carries the deferral ceiling across a live transfer', () => {
    const source = new AlertManager();
    source.onData('pane');
    vi.advanceTimersByTime(cfg.alert.busyCandidateGap);
    source.onData('pane'); source.onData('pane');
    // Confirmed busy, so the report waits behind the animation.
    source.notifyFromProtocol('pane', { source: 'OSC 9', title: null, body: 'Done' });
    heartbeat(source, 20_000);
    const snapshot = source.pauseForTransfer('pane')!;
    const target = new AlertManager();
    target.resumeFromTransfer('pane', JSON.parse(JSON.stringify(snapshot)));
    heartbeat(target, cfg.alert.deferCeiling - 21_000);
    expect(target.getState('pane').status).toBe('WATCHING_DISABLED');
    vi.advanceTimersByTime(1_000);
    expect(target.getState('pane').status).toBe('ALERT_RINGING');
    source.dispose(); target.dispose();
  });

  it('preserves the original confirmed-busy quiet deadline across a suspended interval', () => {
    const settled = vi.fn();
    const source = new QuiesceDetector();
    source.onData();
    vi.advanceTimersByTime(cfg.alert.busyCandidateGap);
    source.onData(); source.onData();
    expect(source.isConfirmedBusy()).toBe(true);
    const snapshot = source.snapshot();
    source.dispose();
    vi.advanceTimersByTime(cfg.alert.mightNeedAttention + cfg.alert.needsAttentionConfirm + 100);
    const target = new QuiesceDetector({ onSettled: settled });
    target.restore(JSON.parse(JSON.stringify(snapshot)));
    vi.advanceTimersByTime(1);
    expect(settled).toHaveBeenCalledTimes(1);
    target.dispose();
  });

  it('accepts output right after restoring an expired resize grace', () => {
    const source = new QuiesceDetector();
    source.onResize();
    const snapshot = source.snapshot();
    source.dispose();
    vi.advanceTimersByTime(cfg.alert.resizeDebounce + 1);
    const target = new QuiesceDetector();
    target.restore(JSON.parse(JSON.stringify(snapshot)));
    target.onData();
    expect(target.snapshot()).toMatchObject({ resizeGrace: false, outputCountSinceReset: 1 });
    target.dispose();
  });

  it('cancels parked await callers at the handoff boundary', async () => {
    const source = new AlertManager();
    source.onData('pane');
    const handle = source.awaitCompletion('pane', { until: 'exit', timeoutMs: 60_000 });
    source.pauseForTransfer('pane');
    expect(await handle.promise).toMatchObject({ kind: 'cancelled' });
    source.dispose();
  });
});
