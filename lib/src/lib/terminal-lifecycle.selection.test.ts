// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/**
 * Any input the terminal receives ends a finalized selection — the copy editor
 * over it, or a shadowed program drag — however it arrives
 * (docs/specs/mouse-and-clipboard.md §4.3, §3.8). A resize carries one the
 * terminal owns through the reflow (§3.4).
 */

// xterm's real buffer, so a resize reflows; never opened, and the addons it
// loads are stand-ins, since no canvas can measure glyphs.
vi.mock('@xterm/xterm', async () => {
  const xterm = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm');
  class Terminal extends xterm.Terminal {
    override open(): void {}
    override loadAddon(): void {}
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-image', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-serialize', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-unicode-graphemes', () => import('./xterm-test-mock'));
vi.mock('./platform', async () => {
  const actual = await vi.importActual<typeof import('./platform')>('./platform');
  const fakePlatform = new actual.FakePtyAdapter();
  return { ...actual, getPlatform: () => fakePlatform };
});

import { flipCopyBreak, openCopyEditor, setCopyFormat, setCopyScope } from './copy-editor';
import { finalizedSelection } from './copy-text-fixtures';
import { beginDrag, flashCopy, getMouseSelectionState, setSelection, type Selection } from './mouse-selection';
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

describe('a terminal resize', () => {
  async function paneWith(id: string, data: string) {
    const { terminal } = getOrCreateTerminal(id);
    terminal.resize(20, 10);
    await new Promise<void>((resolve) => terminal.write(data, resolve));
    return terminal;
  }

  it('carries a linewise selection and its editor through the reflow', async () => {
    // Soft-wraps after `dddd ` at 20 columns, and after `bbbb ` at 10.
    const terminal = await paneWith('resize-1', 'aaaa bbbb cccc dddd eeee ffff\r\n');
    setSelection('resize-1', finalizedSelection({ startRow: 0, startCol: 6, endRow: 1, endCol: 1 })); // `bbb` through `ee`
    openCopyEditor('resize-1', terminal);
    setCopyScope('resize-1', getMouseSelectionState('resize-1').copyEditor!.scopes.findIndex((s) => s.label === 'Whole words'));
    setCopyFormat('resize-1', 'exact');
    flipCopyBreak('resize-1', 0, 'keep');
    expect(getMouseSelectionState('resize-1').copyEditor!.overrides).not.toEqual({});

    terminal.resize(10, 10);
    const { selection, copyEditor } = getMouseSelectionState('resize-1');
    expect(selection).toMatchObject({ startRow: 0, startCol: 6, endRow: 2, endCol: 1 });
    expect(copyEditor).toMatchObject({ format: 'exact', overrides: {} });
    expect(copyEditor!.scopes[copyEditor!.scope].label).toBe('Whole words');
    expect(copyEditor!.scopes[0].span).toEqual({ start: { row: 0, col: 6 }, end: { row: 2, col: 1 }, block: false });
    // The moved selection's two edges, the first selection's released.
    expect(terminal.markers).toHaveLength(2);
  });

  it('still cancels a block selection, one the program owns, and one whose copy is confirming', async () => {
    const terminal = await paneWith('resize-2', 'aaaa bbbb cccc dddd eeee ffff\r\n');
    const resizeCancels = (over: Partial<Selection>, flashing = false) => {
      setSelection('resize-2', finalizedSelection({ startRow: 0, startCol: 6, endRow: 0, endCol: 8, ...over }));
      openCopyEditor('resize-2', terminal);
      if (flashing) flashCopy('resize-2', 'auto');
      terminal.resize(terminal.cols === 20 ? 10 : 20, 10);
      expect(getMouseSelectionState('resize-2')).toMatchObject({ selection: null, copyEditor: null });
    };
    resizeCancels({ shape: 'block' });
    resizeCancels({ owner: 'program' });
    resizeCancels({}, true);
  });
});
