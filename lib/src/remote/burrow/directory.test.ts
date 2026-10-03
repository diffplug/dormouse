import { describe, expect, it } from 'vitest';
import {
  buildDirectoryEntry,
  buildDirectorySnapshot,
  type DirectoryPaneInput,
  type DirectoryWorkspaceInput,
} from './directory';
import type { CwdState, ShellActivity, TerminalPaneState } from '../../lib/terminal-state';

function pane(partial: Partial<TerminalPaneState> = {}): TerminalPaneState {
  return {
    cwd: null,
    activity: { kind: 'unknown' },
    pendingCommandLine: null,
    currentCommand: null,
    lastCommand: null,
    title: null,
    titleCandidates: {},
    ...partial,
  };
}

function cwd(path: string): CwdState {
  return { path, pathKind: 'posix', isRemote: false, source: 'osc7', updatedAt: 1 };
}

function input(partial: Partial<DirectoryPaneInput> = {}): DirectoryPaneInput {
  return {
    paneRef: 'p1',
    surfaceId: 'p1',
    title: 'shell',
    focused: false,
    alive: true,
    pane: pane(),
    ringing: false,
    hasTODO: false,
    ...partial,
  };
}

describe('buildDirectoryEntry', () => {
  it('maps a running pane with a cwd and carries the flags through', () => {
    const entry = buildDirectoryEntry(
      input({
        paneRef: 'pane-a',
        surfaceId: 'pane-a',
        title: 'pnpm dev',
        focused: true,
        ringing: true,
        hasTODO: true,
        pane: pane({ activity: { kind: 'running' }, cwd: cwd('/home/me/project') }),
      }),
    );
    expect(entry).toEqual({
      paneRef: 'pane-a',
      surfaceId: 'pane-a',
      type: 'terminal',
      title: 'pnpm dev',
      focused: true,
      activity: 'running',
      alive: true,
      cwd: '/home/me/project',
      ringing: true,
      hasTODO: true,
    });
    // No exitCode field while running.
    expect('exitCode' in entry).toBe(false);
  });

  it('passes alive straight through (true for a live pane, false for an exited one)', () => {
    expect(buildDirectoryEntry(input({ alive: true })).alive).toBe(true);
    // An exited pane lingering in the registry: exitCode may still be present,
    // but alive is independently false.
    const dead = buildDirectoryEntry(
      input({ alive: false, pane: pane({ activity: { kind: 'finished', exitCode: 0 } as ShellActivity }) }),
    );
    expect(dead.alive).toBe(false);
    expect(dead.exitCode).toBe(0);
  });

  it('includes exitCode only when a finished command has a real code', () => {
    const withCode = buildDirectoryEntry(
      input({ pane: pane({ activity: { kind: 'finished', exitCode: 1 } as ShellActivity }) }),
    );
    expect(withCode.activity).toBe('finished');
    expect(withCode.exitCode).toBe(1);

    const noCode = buildDirectoryEntry(
      input({ pane: pane({ activity: { kind: 'finished' } as ShellActivity }) }),
    );
    expect(noCode.activity).toBe('finished');
    expect('exitCode' in noCode).toBe(false);
  });

  it('omits cwd when the pane has none', () => {
    const entry = buildDirectoryEntry(input());
    expect('cwd' in entry).toBe(false);
    expect(entry.activity).toBe('unknown');
  });

  it('builds a snapshot preserving order', () => {
    const entries = buildDirectorySnapshot([
      input({ paneRef: 'a', surfaceId: 'a' }),
      input({ paneRef: 'b', surfaceId: 'b' }),
    ]);
    expect(entries.map((e) => e.surfaceId)).toEqual(['a', 'b']);
  });
});

describe('buildDirectorySnapshot with Workspaces', () => {
  const panes = (...ids: string[]) => ids.map((id) => input({ paneRef: id, surfaceId: id }));
  const workspace = (
    ref: string,
    surfaceIds: string[],
    active = false,
  ): DirectoryWorkspaceInput => ({ ref, name: `name of ${ref}`, active, surfaceIds });

  it('orders entries by Workspace, keeping registry order within one', () => {
    const entries = buildDirectorySnapshot(panes('a', 'b', 'c', 'd'), [
      workspace('workspace:7', ['d', 'b']),
      workspace('workspace:3', ['c', 'a'], true),
    ]);
    expect(entries.map((entry) => [entry.surfaceId, entry.workspace?.ref])).toEqual([
      ['b', 'workspace:7'],
      ['d', 'workspace:7'],
      ['a', 'workspace:3'],
      ['c', 'workspace:3'],
    ]);
  });

  it('names each entry’s Workspace with its ref, name, and whether its Window shows it', () => {
    const [shown, hidden] = buildDirectorySnapshot(panes('a', 'b'), [
      workspace('workspace:1', ['a'], true),
      workspace('workspace:2', ['b']),
    ]);
    expect(shown!.workspace).toEqual({ ref: 'workspace:1', name: 'name of workspace:1', active: true });
    expect(hidden!.workspace).toEqual({ ref: 'workspace:2', name: 'name of workspace:2', active: false });
  });

  it('lists a pane no Workspace claims last, naming none', () => {
    const entries = buildDirectorySnapshot(panes('loose', 'a'), [workspace('workspace:1', ['a'], true)]);
    expect(entries.map((entry) => entry.surfaceId)).toEqual(['a', 'loose']);
    expect('workspace' in entries[1]!).toBe(false);
  });

  it('names no Workspace and keeps registry order where none is given', () => {
    const entries = buildDirectorySnapshot(panes('b', 'a'));
    expect(entries.map((entry) => entry.surfaceId)).toEqual(['b', 'a']);
    expect(entries.some((entry) => 'workspace' in entry)).toBe(false);
  });
});
