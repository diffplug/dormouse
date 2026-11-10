/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useWallKeyboard } from './use-wall-keyboard';
import type { WallKeyboardCtx } from './keyboard/types';

vi.mock('./keyboard/handle-editable-clipboard', () => ({ handleEditableClipboard: () => false }));

const copyEditor = vi.hoisted(() => ({ open: true }));

// Stands in for the copy editor taking Ctrl+C while it is open.
vi.mock('./keyboard/handle-mouse-selection-keys', () => ({
  handleMouseSelectionKeys: (e: KeyboardEvent) => {
    if (!(copyEditor.open && e.ctrlKey && e.key === 'c')) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    return true;
  },
}));

function makeCtx(): WallKeyboardCtx {
  return {
    activeRef: { current: true },
    modeRef: { current: 'passthrough' },
  } as unknown as WallKeyboardCtx;
}

describe('useWallKeyboard keyup', () => {
  let root: Root;
  let xterm: HTMLTextAreaElement;
  let released: string[];
  let received: string[];

  beforeEach(async () => {
    copyEditor.open = true;
    xterm = document.createElement('textarea');
    xterm.className = 'xterm-helper-textarea';
    document.body.appendChild(xterm);
    released = [];
    received = [];
    xterm.addEventListener('keyup', (e) => released.push(e.code));
    xterm.addEventListener('keydown', (e) => received.push(e.code));
    function Harness() {
      useWallKeyboard(makeCtx());
      return null;
    }
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Harness)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    xterm.remove();
  });

  const press = (type: 'keydown' | 'keyup', key: string, code: string, ctrlKey = false, repeat = false) =>
    xterm.dispatchEvent(new KeyboardEvent(type, { key, code, ctrlKey, repeat, bubbles: true, cancelable: true }));

  // The key that answered the Wall can move focus into the terminal (Enter
  // entering passthrough, a copy closing its editor); its held repeats must not
  // follow it there.
  it('keeps the auto-repeat of a consumed key from the terminal', () => {
    press('keydown', 'c', 'KeyC', true);
    copyEditor.open = false;
    expect(press('keydown', 'c', 'KeyC', true, true)).toBe(false);
    press('keyup', 'c', 'KeyC', true);
    press('keydown', 'c', 'KeyC', true);
    expect(received).toEqual(['KeyC']);
  });

  // Under win32-input-mode xterm reports the release to the program: a consumed
  // Ctrl+C would arrive as a lone key-up, and as user input close the editor.
  it('keeps the release of a consumed key from the terminal', () => {
    press('keydown', 'c', 'KeyC', true);
    press('keyup', 'c', 'KeyC', true);
    expect(released).toEqual([]);
  });

  it('passes the release of a key the terminal received', () => {
    press('keydown', 'c', 'KeyC', true);
    press('keyup', 'c', 'KeyC', true);
    press('keydown', 'c', 'KeyC');
    press('keyup', 'c', 'KeyC');
    press('keydown', 'x', 'KeyX');
    press('keyup', 'x', 'KeyX');
    expect(released).toEqual(['KeyC', 'KeyX']);
  });
});
