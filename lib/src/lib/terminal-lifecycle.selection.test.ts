// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';

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
import type { EditorFormat } from './copy-text';
import { finalizedSelection, WRAPPING } from './copy-text-fixtures';
import { beginDrag, flashCopy, getMouseSelectionState, setSelection, type Selection } from './mouse-selection';
import { getOrCreateTerminal, writeUserInput } from './terminal-registry';

const write = (terminal: Terminal, data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));

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
  const editor = (id: string) => getMouseSelectionState(id).copyEditor!;

  /** A 20-column pane, `above` then {@link WRAPPING} (which soft-wraps after
   *  `dddd ` at 20 columns, and after `bbbb ` at 10), `bbb` through `ee`
   *  selected, and its editor open at `scope` in `format` with a per-break
   *  edit. */
  async function openEdited(id: string, { above = '', format = 'auto', scope = 'As selected', over = {} }: {
    above?: string; format?: EditorFormat; scope?: string; over?: Partial<Selection>;
  } = {}) {
    const { terminal } = getOrCreateTerminal(id);
    terminal.resize(20, 10);
    await write(terminal, `${above}${WRAPPING}\r\n`);
    const row = terminal.buffer.active.baseY + terminal.buffer.active.cursorY - 2;
    setSelection(id, finalizedSelection({ startRow: row, startCol: 6, endRow: row + 1, endCol: 1, ...over }));
    openCopyEditor(id, terminal);
    setCopyScope(id, editor(id).scopes.findIndex((s) => s.label === scope));
    setCopyFormat(id, format);
    flipCopyBreak(id, 0, 'keep');
    return terminal;
  }

  it('carries a linewise selection and its editor through the reflow', async () => {
    const id = 'resize-1';
    const terminal = await openEdited(id, { format: 'exact', scope: 'Whole words' });
    expect(editor(id).overrides).not.toEqual({});

    terminal.resize(10, 10);
    const { selection, copyEditor } = getMouseSelectionState(id);
    expect(selection).toMatchObject({ startRow: 0, startCol: 6, endRow: 2, endCol: 1 });
    expect(copyEditor!.format).toBe('exact');
    expect(copyEditor!.overrides).toEqual({});
    expect(copyEditor!.scopes[copyEditor!.scope].label).toBe('Whole words');
    expect(copyEditor!.scopes[0].span).toEqual({ start: { row: 0, col: 6 }, end: { row: 2, col: 1 }, block: false });
    // The moved selection's two edges, the first selection's released.
    expect(terminal.markers).toHaveLength(2);
  });

  it('keeps per-break edits through a resize that moves the selection but keeps the width', async () => {
    const id = 'resize-2';
    const terminal = await openEdited(id, { above: 'x\r\n'.repeat(7) });
    terminal.options.scrollback = 0;
    const { overrides } = editor(id);

    // A shorter full buffer trims rows off its top.
    terminal.resize(20, 6);
    expect(getMouseSelectionState(id).selection).toMatchObject({ startRow: 3, endRow: 4 });
    expect(editor(id).overrides).toEqual(overrides);
  });

  it('writes nothing when the resize moved nothing', async () => {
    const id = 'resize-3';
    const terminal = await openEdited(id);
    const { selection, copyEditor } = getMouseSelectionState(id);

    terminal.resize(20, 6);
    expect(getMouseSelectionState(id).selection).toBe(selection);
    expect(getMouseSelectionState(id).copyEditor).toBe(copyEditor);
  });

  it('carries a selection whose copy is confirming, and the flash still closes it', async () => {
    const id = 'resize-4';
    const terminal = await openEdited(id);
    vi.useFakeTimers();
    try {
      flashCopy(id);
      terminal.resize(10, 10);
      expect(getMouseSelectionState(id)).toMatchObject({ selection: { endRow: 2, endCol: 1 }, copyOutcome: 'copied' });
      vi.advanceTimersByTime(700);
      expect(getMouseSelectionState(id)).toMatchObject({ selection: null, copyEditor: null, copyOutcome: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('still cancels a block selection, and one the program owns', async () => {
    for (const [id, over] of [['resize-5', { shape: 'block' }], ['resize-6', { owner: 'program' }]] as const) {
      const terminal = await openEdited(id, { over });
      terminal.resize(10, 10);
      expect(getMouseSelectionState(id)).toMatchObject({ selection: null, copyEditor: null });
    }
  });
});
