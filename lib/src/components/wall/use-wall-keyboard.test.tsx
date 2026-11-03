/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useWallKeyboard } from './use-wall-keyboard';
import type { WallKeyboardCtx } from './keyboard/types';

vi.mock('./keyboard/handle-editable-clipboard', () => ({ handleEditableClipboard: () => false }));

// Stands in for the copy editor taking Ctrl+C.
vi.mock('./keyboard/handle-mouse-selection-keys', () => ({
  handleMouseSelectionKeys: (e: KeyboardEvent) => {
    if (!(e.ctrlKey && e.key === 'c')) return false;
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

  beforeEach(async () => {
    xterm = document.createElement('textarea');
    xterm.className = 'xterm-helper-textarea';
    document.body.appendChild(xterm);
    released = [];
    xterm.addEventListener('keyup', (e) => released.push(e.code));
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

  const press = (type: 'keydown' | 'keyup', key: string, code: string, ctrlKey = false) =>
    xterm.dispatchEvent(new KeyboardEvent(type, { key, code, ctrlKey, bubbles: true, cancelable: true }));

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
