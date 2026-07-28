import { afterEach, describe, expect, it, vi } from 'vitest';

const alertSetWatchedCommands = vi.fn();
const alertSetCommandWatched = vi.fn();

vi.mock('./platform', () => ({
  getPlatform: () => ({ alertSetWatchedCommands, alertSetCommandWatched }),
}));

import { commandArgv0 } from './terminal-state';
import {
  applyWatchedCommandsFromHost,
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

describe('commandArgv0', () => {
  it.each([
    ['claude', 'claude'],
    ['claude --print hello', 'claude'],
    ['/usr/local/bin/claude --resume', 'claude'],
    ['FOO=1 claude', 'claude'],
    ['FOO=1 env BAR=2 claude', 'claude'],
    ['"/opt/my tools/claude" --print', 'claude'],
    // Only the first simple command counts — this matches what bash's DEBUG
    // trap reports for a pipeline (docs/specs/terminal-escapes.md).
    ['foo | claude', 'foo'],
    ['pnpm test && claude', 'pnpm'],
  ])('reduces %j to %j', (raw, expected) => {
    expect(commandArgv0(raw)).toBe(expected);
  });

  it.each(['', '   ', '|', 'FOO=1'])('returns null for %j', (raw) => {
    expect(commandArgv0(raw)).toBeNull();
  });

  it('mangles an unquoted native Windows path, and that is a known limitation', () => {
    // The shared tokenizer reads `\` as a POSIX escape, so backslash separators
    // are eaten before the basename split can see them — `summarizeCommandLine`
    // has always had the same blind spot. Harmless in practice: the shells that
    // report a command line (pwsh, Git Bash, WSL) send either a bare program
    // name or a POSIX path, and the mangling is at least stable, so a rule keyed
    // on it still matches itself.
    expect(commandArgv0('C:\\tools\\claude.exe --print')).toBe('C:toolsclaude.exe');
  });
});

describe('watched-commands store', () => {
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
