/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleWorkspaceShortcuts } from './handle-workspace-shortcuts';
import type { WallKeyboardCtx } from './types';
import type { WorkspaceCommands } from '../wall-types';

const KEYS = ['c', 'n', 'p', '&', '$', '1', '5', '9'];

function commands(): WorkspaceCommands & Record<keyof WorkspaceCommands, ReturnType<typeof vi.fn>> {
  return {
    create: vi.fn(),
    cycle: vi.fn(),
    selectIndex: vi.fn(),
    requestClose: vi.fn(),
    requestRename: vi.fn(),
  } as unknown as WorkspaceCommands & Record<keyof WorkspaceCommands, ReturnType<typeof vi.fn>>;
}

function ctxWith(workspaces?: WorkspaceCommands): WallKeyboardCtx {
  return { activeRef: { current: true }, workspaces } as unknown as WallKeyboardCtx;
}

function keydown(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, cancelable: true, ...init });
}

let verbs: ReturnType<typeof commands>;

beforeEach(() => {
  verbs = commands();
});

describe('handleWorkspaceShortcuts', () => {
  it('leaves every key unbound without the Workspace verbs — the bare-Wall guard', () => {
    const ctx = ctxWith();
    for (const key of KEYS) {
      const event = keydown(key);
      expect(handleWorkspaceShortcuts(event, ctx)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it('binds create, cycle, select, close, and rename', () => {
    const ctx = ctxWith(verbs);
    expect(handleWorkspaceShortcuts(keydown('c'), ctx)).toBe(true);
    expect(verbs.create).toHaveBeenCalledTimes(1);

    handleWorkspaceShortcuts(keydown('n'), ctx);
    handleWorkspaceShortcuts(keydown('p'), ctx);
    expect(verbs.cycle.mock.calls).toEqual([[1], [-1]]);

    handleWorkspaceShortcuts(keydown('1'), ctx);
    handleWorkspaceShortcuts(keydown('9'), ctx);
    // The digit is 1-based on screen and 0-based in the verb.
    expect(verbs.selectIndex.mock.calls).toEqual([[0], [8]]);

    handleWorkspaceShortcuts(keydown('&'), ctx);
    expect(verbs.requestClose).toHaveBeenCalledTimes(1);
    handleWorkspaceShortcuts(keydown('$'), ctx);
    expect(verbs.requestRename).toHaveBeenCalledTimes(1);
  });

  it('claims the key it handles and leaves every other one alone', () => {
    const ctx = ctxWith(verbs);
    const handled = keydown('c');
    handleWorkspaceShortcuts(handled, ctx);
    expect(handled.defaultPrevented).toBe(true);

    for (const key of ['0', 'x', 'k', ',', 'z', 'Enter', '|']) {
      expect(handleWorkspaceShortcuts(keydown(key), ctx)).toBe(false);
    }
  });

  it('ignores a modified key, so Cmd+C stays a clipboard chord', () => {
    const ctx = ctxWith(verbs);
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      expect(handleWorkspaceShortcuts(keydown('c', init), ctx)).toBe(false);
    }
    expect(verbs.create).not.toHaveBeenCalled();
  });
});
