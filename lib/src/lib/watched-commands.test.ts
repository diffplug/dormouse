import { afterEach, describe, expect, it, vi } from 'vitest';

const alertSetWatchedCommands = vi.fn();
const alertSetCommandWatched = vi.fn();

vi.mock('./platform', () => ({
  getPlatform: () => ({ alertSetWatchedCommands, alertSetCommandWatched }),
}));

import {
  applyWatchedCommandsFromHost,
  commandWatchRule,
  getWatchedCommands,
  isCommandWatched,
  publishWatchedCommands,
  setCommandWatched,
  subscribeToWatchedCommands,
} from './watched-commands';

function clearRules(): void {
  for (const name of getWatchedCommands()) setCommandWatched(name, false);
}

afterEach(() => {
  clearRules();
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

  it('names the rule covering a running command, a bare runner covering its scripts', () => {
    setCommandWatched('pnpm test', true);
    expect(commandWatchRule('pnpm test')).toBe('pnpm test');
    expect(commandWatchRule('pnpm dev')).toBeNull();
    setCommandWatched('pnpm', true);
    expect(commandWatchRule('pnpm dev')).toBe('pnpm');
    expect(commandWatchRule(null)).toBeNull();
  });

  it('adds, reports, and removes rules', () => {
    expect(getWatchedCommands()).toEqual([]);
    expect(isCommandWatched('claude')).toBe(false);

    setCommandWatched('claude', true);
    expect(getWatchedCommands()).toEqual(['claude']);
    expect(isCommandWatched('claude')).toBe(true);

    setCommandWatched('claude', false);
    expect(getWatchedCommands()).toEqual([]);
    expect(isCommandWatched('claude')).toBe(false);
  });

  it('keeps the rule set sorted and free of duplicates and blanks', () => {
    setCommandWatched('pnpm', true);
    setCommandWatched('claude', true);
    setCommandWatched('claude', true);
    setCommandWatched('  ', true);

    expect(getWatchedCommands()).toEqual(['claude', 'pnpm']);
  });

  it('treats a null or empty name as unwatched', () => {
    setCommandWatched('claude', true);
    expect(isCommandWatched(null)).toBe(false);
    expect(isCommandWatched(undefined)).toBe(false);
    expect(isCommandWatched('')).toBe(false);
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

    applyWatchedCommandsFromHost(['claude', 'npm', 'claude']);

    expect(getWatchedCommands()).toEqual(['claude', 'npm']);
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
