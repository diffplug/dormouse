// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useWallKeyboard } from '../use-wall-keyboard';
import { COMMAND_KEYS, WORKSPACE_KEYS } from '../../StrayKeyPrompt';
import type { WallKeyboardCtx } from './types';

function makeCtx(workspaceId: string | undefined) {
  const strayKeyRef = { current: null as string | null };
  const wallActions = { onSplitH: vi.fn(), onSplitV: vi.fn(), onZoom: vi.fn() };
  const ctx = {
    nav: { findInDirection: () => null, paneParams: () => ({}), hasPane: () => true, panes: () => ['p1'] },
    activeRef: { current: true },
    workspaceId,
    swapWithNeighbor: vi.fn(),
    modeRef: { current: 'command' },
    selectedIdRef: { current: 'p1' },
    selectedTypeRef: { current: 'pane' },
    doorsRef: { current: [] },
    confirmKillRef: { current: null },
    renamingRef: { current: null },
    dialogKeyboardActiveRef: { current: false },
    wallActionsRef: { current: wallActions },
    handleReattachRef: { current: vi.fn() },
    selectPane: vi.fn(),
    selectDoor: vi.fn(),
    selectWorkspace: vi.fn(),
    returnToPane: vi.fn(),
    enterTerminalMode: vi.fn(),
    exitTerminalMode: vi.fn(),
    minimizePane: vi.fn(),
    openTerminalContext: vi.fn(),
    requestKill: vi.fn(),
    reopenClosed: vi.fn(),
    acceptKill: vi.fn(),
    rejectKill: vi.fn(),
    strayKeyRef,
    raiseStrayKey: vi.fn((key: string) => { strayKeyRef.current = key; }),
    dismissStrayKey: vi.fn(() => { strayKeyRef.current = null; }),
    setRenamingPaneId: vi.fn(),
    fireEvent: vi.fn(),
  };
  return { ctx, wallActions, strayKeyRef };
}

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

async function mount(workspaceId: string | undefined) {
  const made = makeCtx(workspaceId);
  function Harness() {
    useWallKeyboard(made.ctx as unknown as WallKeyboardCtx);
    return null;
  }
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(createElement(Harness)));
  return made;
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
}

const ARROWS: Record<string, string> = { '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight' };
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const listedKeys = (keys: string) => keys === '1–9' ? DIGITS : keys.split(' ').map(key => ARROWS[key] ?? key);

describe('stray keys in command mode', () => {
  it('stops a word typed in the wrong mode at its first stray, before its letters fire verbs', async () => {
    const { ctx, wallActions } = await mount('ws');
    const events = [...'ls -la'].map(key => press(key));
    expect(ctx.raiseStrayKey).toHaveBeenCalledExactlyOnceWith('l');
    expect(wallActions.onSplitV).not.toHaveBeenCalled();
    expect(ctx.enterTerminalMode).not.toHaveBeenCalled();
    expect(events.every(event => event.defaultPrevented)).toBe(true);
  });

  it('Escape takes the prompt down and stays in command mode', async () => {
    const { ctx, wallActions, strayKeyRef } = await mount('ws');
    press('l');
    expect(press('Escape').defaultPrevented).toBe(true);
    expect(strayKeyRef.current).toBeNull();
    expect(ctx.enterTerminalMode).not.toHaveBeenCalled();
    press('z');
    expect(wallActions.onZoom).toHaveBeenCalledWith('p1');
  });

  it('Enter takes the prompt down and does the ordinary Enter', async () => {
    const { ctx, strayKeyRef } = await mount('ws');
    press('l');
    press('Enter');
    expect(strayKeyRef.current).toBeNull();
    expect(ctx.enterTerminalMode).toHaveBeenCalledWith('p1');
  });

  it('leaves host chords and bare modifiers to the host while the prompt shows', async () => {
    const { strayKeyRef } = await mount('ws');
    press('l');
    expect(press('c', { metaKey: true }).defaultPrevented).toBe(false);
    expect(press('Shift').defaultPrevented).toBe(false);
    expect(strayKeyRef.current).toBe('l');
  });

  it.each([' ', 'Backspace', 'L', 'q', '/'])('counts %j as a stray', async key => {
    const { ctx } = await mount('ws');
    press(key, { shiftKey: key === 'L' });
    expect(ctx.raiseStrayKey).toHaveBeenCalledExactlyOnceWith(key);
  });

  it.each([{ key: 'l', metaKey: true }, { key: 'l', ctrlKey: true }, { key: 'l', altKey: true }, { key: 'Escape' }, { key: 'Tab' }, { key: 'F1' }])(
    'never counts %j as a stray', async init => {
      const { ctx } = await mount('ws');
      press(init.key, init);
      expect(ctx.raiseStrayKey).not.toHaveBeenCalled();
    });

  it('counts digits as strays only on a bare Wall, which leaves them unbound', async () => {
    const bare = await mount(undefined);
    press('3');
    expect(bare.ctx.raiseStrayKey).toHaveBeenCalledExactlyOnceWith('3');
  });

  it.each([...COMMAND_KEYS, WORKSPACE_KEYS].flatMap(([keys]) => listedKeys(keys)))(
    'dispatches the listed key %j instead of calling it a stray', async key => {
      const { ctx } = await mount('ws');
      press(key);
      expect(ctx.raiseStrayKey).not.toHaveBeenCalled();
    });

  it.each(['t', 'a', '>', ','])('does not call a bound key a stray where its verb is inert (%j on a Door)', async key => {
    const { ctx } = await mount('ws');
    ctx.selectedTypeRef.current = 'door';
    press(key);
    expect(ctx.raiseStrayKey).not.toHaveBeenCalled();
  });
});
