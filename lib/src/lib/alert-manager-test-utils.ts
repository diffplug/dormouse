/**
 * Drivers the suites that feed an `AlertManager` directly share
 * (`alert-manager.test.ts`, `alert-engagement.test.ts`,
 * `alert-resumed-output.test.ts`). Each takes the manager it drives and runs
 * under fake timers.
 *
 * Timing from cfg.alert: busyCandidateGap=1500, busyConfirmGap=500,
 * mightNeedAttention=2000, needsAttentionConfirm=3000.
 */
import { vi } from 'vitest';
import type { AlertManager } from './alert-manager';

/** The viewer a suite reports for when one renderer realm is enough. */
export const VIEWER = 'viewer';

/** The user is present, `viewer` pointing at `id` (`docs/specs/alert.md` -> Engagement). */
export function engage(manager: AlertManager, id: string, viewer = VIEWER): void {
  manager.setViewer(viewer, { present: true, focusId: id });
}

/** An explicit disengage: focus moved off, or the window left. */
export function leave(manager: AlertManager, viewer = VIEWER): void {
  manager.setViewer(viewer, { present: false, focusId: null }, 'leave');
}

/** Presence lapses from inactivity while `id` keeps the focus. */
export function goIdle(manager: AlertManager, id: string, viewer = VIEWER): void {
  manager.setViewer(viewer, { present: false, focusId: id }, 'idle');
}

/** Start `commandLine` the way shell integration reports it: the line, then its start. */
export function runCommand(manager: AlertManager, id: string, commandLine = 'pnpm build'): void {
  manager.applyTerminalSemanticEvents(id, [
    { type: 'commandLine', commandLine },
    { type: 'commandStart', source: 'osc633_E', startedAt: Date.now() },
  ]);
}

/** The foreground command finishes; `promptStart` also draws the next prompt. */
export function finishCommand(
  manager: AlertManager,
  id: string,
  exitCode = 0,
  { promptStart = false }: { promptStart?: boolean } = {},
): void {
  manager.applyTerminalSemanticEvents(id, [
    { type: 'commandFinish', exitCode },
    ...(promptStart ? [{ type: 'promptStart' as const }] : []),
  ]);
}

/** Run `commandLine` seen and then left: armed, so its exit rings once it has
 *  outlasted `cfg.alert.commandExitMinRuntime`. */
export function armCommandExit(manager: AlertManager, id: string, commandLine = 'pnpm build'): void {
  engage(manager, id);
  runCommand(manager, id, commandLine);
  leave(manager);
}

/** Two output bursts across the busy-candidate gap: NOTHING_TO_SHOW -> BUSY. */
export function driveToBusy(manager: AlertManager, id: string): void {
  manager.onData(id);
  vi.advanceTimersByTime(1_600);
  manager.onData(id);
  manager.onData(id);
}

/** Silence through both quiet windows: BUSY -> MIGHT_NEED_ATTENTION -> settled. */
export function settle(): void {
  vi.advanceTimersByTime(2_000);
  vi.advanceTimersByTime(3_000);
}

/** One output chunk a second for `ms`, which never lets the Session go quiet. */
export function heartbeat(manager: AlertManager, id: string, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
    vi.advanceTimersByTime(1_000);
    manager.onData(id);
  }
}
