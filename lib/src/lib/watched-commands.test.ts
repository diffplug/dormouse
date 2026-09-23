import { afterEach, describe, expect, it, vi } from 'vitest';

const alertSetWatchedCommands = vi.fn();
const alertSetCommandWatched = vi.fn();

vi.mock('./platform', () => ({
  getPlatform: () => ({ alertSetWatchedCommands, alertSetCommandWatched }),
}));

import {
  applyWatchedCommandsFromHost,
  getRunningCommandWatchRule,
  getWatchedCommands,
  publishWatchedCommands,
  setCommandWatched,
  subscribeToWatchedCommands,
} from './watched-commands';
import { applyTerminalSemanticEvents, removeTerminalPaneState } from './terminal-state-store';

const PANE = 'watched-commands-pane';

function clearRules(): void {
  for (const name of getWatchedCommands()) setCommandWatched(name, false);
}

function run(commandLine: string): void {
  applyTerminalSemanticEvents(PANE, [
    { type: 'commandLine', commandLine },
    { type: 'commandStart', source: 'osc633_boundaries' },
  ]);
}

afterEach(() => {
  clearRules();
  removeTerminalPaneState(PANE);
  alertSetWatchedCommands.mockClear();
  alertSetCommandWatched.mockClear();
});

describe('watched-commands store', () => {
  it('drops a key no command line can ever produce', () => {
    // Written by the pre-fix tokenizer, which ate the backslashes in
    // `C:\tools\claude.exe`. A real key is a basename, so it holds no separator.
    // A colon outside a leading drive prefix is legal in a POSIX basename.
    applyWatchedCommandsFromHost([
      'C:toolsclaude.exe',
      'claude',
      'foo:bar',
      '/usr/bin/claude',
    ]);
    expect(getWatchedCommands()).toEqual(['claude', 'foo:bar']);
    // Same gate on the write path — a drive-relative invocation is the one
    // shape a program name can still arrive in with a `:` in it.
    setCommandWatched('C:foo.exe', true);
    expect(getWatchedCommands()).toEqual(['claude', 'foo:bar']);
    // A launcher suffix is the other tell: a relative invocation had no
    // separator to eat (`tools\\dor.cmd` -> `toolsdor.cmd`), and a bare
    // `npm.cmd` stored cleanly — but `commandProgramName` strips the suffix, so
    // neither can match again.
    applyWatchedCommandsFromHost([
      'npm.cmd',
      'toolsdor.cmd',
      '.build.ps1',
      'claude',
      'foo:bar',
    ]);
    expect(getWatchedCommands()).toEqual(['claude', 'foo:bar']);
  });

  it('keeps a runner and script key and drops a malformed one', () => {
    applyWatchedCommandsFromHost([
      'pnpm dev',
      'npm test:unit',
      'pnpm',
      'pnpm  dev',
      'npm run dev extra',
      'npm.cmd test',
      'make build/app.o',
      ' pnpm',
    ]);
    expect(getWatchedCommands()).toEqual(['npm test:unit', 'pnpm', 'pnpm dev']);
    setCommandWatched('npm.cmd dev', true);
    setCommandWatched('cargo build', true);
    expect(getWatchedCommands()).toEqual(['cargo build', 'npm test:unit', 'pnpm', 'pnpm dev']);
  });

  it('adds, reports, and removes the rule covering a running command', () => {
    run('cd web && pnpm dev');
    expect(getWatchedCommands()).toEqual([]);
    expect(getRunningCommandWatchRule(PANE)).toBeNull();

    setCommandWatched('pnpm', true);
    expect(getWatchedCommands()).toEqual(['pnpm']);
    expect(getRunningCommandWatchRule(PANE)).toBe('pnpm');

    setCommandWatched('pnpm', false);
    expect(getWatchedCommands()).toEqual([]);
    expect(getRunningCommandWatchRule(PANE)).toBeNull();
  });

  it('keeps the rule set sorted and free of duplicates and blanks', () => {
    setCommandWatched('pnpm', true);
    setCommandWatched('claude', true);
    setCommandWatched('claude', true);
    setCommandWatched('  ', true);

    expect(getWatchedCommands()).toEqual(['claude', 'pnpm']);
  });

  it('names no rule for a Session at a prompt or never seen', () => {
    setCommandWatched('claude', true);
    expect(getRunningCommandWatchRule('no-such-pane')).toBeNull();
    run('claude');
    applyTerminalSemanticEvents(PANE, [{ type: 'commandFinish', exitCode: 0 }]);
    expect(getRunningCommandWatchRule(PANE)).toBeNull();
  });

  it('sends mutations as deltas and offers the full rule set only as a startup seed', () => {
    setCommandWatched('claude', true);
    expect(alertSetCommandWatched).toHaveBeenLastCalledWith('claude', true);
    expect(alertSetWatchedCommands).not.toHaveBeenCalled();

    // A no-op write must not churn the host.
    alertSetCommandWatched.mockClear();
    setCommandWatched('claude', true);
    expect(alertSetCommandWatched).not.toHaveBeenCalled();

    publishWatchedCommands();
    expect(alertSetWatchedCommands).toHaveBeenLastCalledWith(['claude']);
  });

  it('replaces a stale renderer mirror with the host snapshot', () => {
    const listener = vi.fn();
    subscribeToWatchedCommands(listener);
    setCommandWatched('npm', true);
    listener.mockClear();

    run('claude');
    applyWatchedCommandsFromHost(['claude', 'npm', 'claude']);

    expect(getWatchedCommands()).toEqual(['claude', 'npm']);
    expect(getRunningCommandWatchRule(PANE)).toBe('claude');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(alertSetCommandWatched).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers on change only', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToWatchedCommands(listener);

    setCommandWatched('claude', true);
    expect(listener).toHaveBeenCalledTimes(1);

    setCommandWatched('claude', true);
    expect(listener).toHaveBeenCalledTimes(1);

    setCommandWatched('claude', false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setCommandWatched('claude', true);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
