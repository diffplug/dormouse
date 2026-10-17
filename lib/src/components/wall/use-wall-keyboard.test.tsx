/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useWallKeyboard } from './use-wall-keyboard';
import type { WallKeyboardCtx } from './keyboard/types';
import { registerProxyOrigin } from '../../lib/iframe-proxy-registry';

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

// A focused cross-origin frame keeps the keyboard, so the proxy shim posts the
// leader chord out; any page can post the same shape, so only a live proxy
// grant's origin may end passthrough (docs/specs/security-local.md -> "Browser
// panes").
describe('useWallKeyboard leader channel', () => {
  let root: Root;
  let ctx: WallKeyboardCtx;
  let exitTerminalMode: ReturnType<typeof vi.fn>;
  let unregister: () => void;
  const PROXY = 'http://127.0.0.1:61234';

  beforeEach(async () => {
    exitTerminalMode = vi.fn();
    ctx = { ...makeCtx(), exitTerminalMode } as unknown as WallKeyboardCtx;
    unregister = registerProxyOrigin(PROXY);
    function Harness() {
      useWallKeyboard(ctx);
      return null;
    }
    root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Harness)));
  });

  afterEach(async () => {
    unregister();
    await act(async () => root.unmount());
  });

  const leader = (origin: string) =>
    window.dispatchEvent(new MessageEvent('message', { origin, data: { __dormouse: 'leader' } }));

  it('exits passthrough only for a live proxy origin', () => {
    for (const origin of ['http://127.0.0.1:61235', 'http://localhost:61234', 'https://evil.example', window.location.origin, 'null']) {
      leader(origin);
    }
    expect(exitTerminalMode).not.toHaveBeenCalled();

    leader(PROXY);
    expect(exitTerminalMode).toHaveBeenCalledOnce();
  });

  it('forgets a proxy origin once its grant is released', () => {
    unregister();
    leader(PROXY);
    expect(exitTerminalMode).not.toHaveBeenCalled();
  });
});
