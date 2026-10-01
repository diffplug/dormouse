// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/**
 * Any input the terminal receives ends a finalized selection — the copy editor
 * over it, or a shadowed program drag — however it arrives
 * (docs/specs/mouse-and-clipboard.md §4.3, §3.8).
 */

vi.mock('@xterm/xterm', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-fit', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-image', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-serialize', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-unicode-graphemes', () => import('./xterm-test-mock'));
vi.mock('./platform', async () => {
  const actual = await vi.importActual<typeof import('./platform')>('./platform');
  const fakePlatform = new actual.FakePtyAdapter();
  return { ...actual, getPlatform: () => fakePlatform };
});

import { finalizedSelection } from './copy-text-fixtures';
import { beginDrag, getMouseSelectionState, setSelection } from './mouse-selection';
import { getOrCreateTerminal, writeUserInput } from './terminal-registry';

describe('writeUserInput', () => {
  it('ends a finalized selection, and a shadowed drag', () => {
    getOrCreateTerminal('pane-1');
    for (const owner of [undefined, 'program'] as const) {
      setSelection('pane-1', finalizedSelection({ endCol: 4, owner }));
      writeUserInput('pane-1', 'x');
      expect(getMouseSelectionState('pane-1').selection).toBeNull();
    }
  });

  it('leaves a drag in progress alone', () => {
    getOrCreateTerminal('pane-2');
    beginDrag('pane-2', { row: 0, col: 0, altKey: false, startedInScrollback: false });
    writeUserInput('pane-2', 'x');
    expect(getMouseSelectionState('pane-2').selection?.dragging).toBe(true);
  });
});
