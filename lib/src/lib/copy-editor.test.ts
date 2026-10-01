import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';

vi.mock('./clipboard', () => ({ writeTextToClipboard: vi.fn() }));
vi.mock('./terminal-registry', () => ({ getTerminalInstance: vi.fn(), refreshSelectionBaseline: vi.fn() }));
import { writeTextToClipboard } from './clipboard';
import { cycleCopyFormat, flipCopyBreak, openCopyEditor, stepCopyScope } from './copy-editor';
import { copySelection, nudgeSelection } from './copy-selection';
import {
  __resetMouseSelectionForTests,
  beginDrag,
  getMouseSelectionState,
  setSelection,
  type Selection,
} from './mouse-selection';
import { getTerminalInstance, refreshSelectionBaseline } from './terminal-registry';

const LINES = [
  'The flake comes from a race between the PTY exit event and the final flush',
  'of the output buffer. When the child exits before xterm has drained its',
  'write queue, the last chunk is dropped and the assertion on the prompt',
  'text fails intermittently.',
];

function fakeTerminal(lines: string[]): Terminal {
  const getLine = (r: number) => {
    const text = lines[r];
    if (text === undefined) return undefined;
    return {
      length: 80,
      isWrapped: false,
      getCell: (c: number) => ({ getChars: () => text[c] ?? '', getWidth: () => 1 }),
      translateToString: (_trim?: boolean, start = 0, end = 80) => text.slice(start, end),
    };
  };
  return { cols: 80, rows: 24, buffer: { active: { length: lines.length, getLine } } } as unknown as Terminal;
}

const terminal = fakeTerminal(LINES);
const ID = 'term-1';

function select(over: Partial<Selection>): void {
  setSelection(ID, { startRow: 0, startCol: 0, endRow: 3, endCol: 26, shape: 'linewise', dragging: false, startedInScrollback: false, ...over });
  openCopyEditor(ID, terminal);
}
const editor = () => getMouseSelectionState(ID).copyEditor!;

beforeEach(() => {
  __resetMouseSelectionForTests();
  vi.mocked(getTerminalInstance).mockReturnValue(terminal);
  vi.mocked(writeTextToClipboard).mockReset();
  vi.mocked(refreshSelectionBaseline).mockReset();
});

describe('copy editor transitions', () => {
  it('opens in Auto at the selection’s own scope', () => {
    select({ startCol: 25, endRow: 1, endCol: 5 });
    expect(editor()).toMatchObject({ scope: 0, format: 'auto', overrides: {} });
    expect(editor().scopes.map((s) => s.label)).toEqual(['As selected', 'Whole words', 'Paragraph']);
  });

  it('steps the scope and stops at either end, clearing overrides', () => {
    select({ startCol: 25, endRow: 1, endCol: 5 });
    flipCopyBreak(ID, terminal, 0);
    stepCopyScope(ID, 1);
    expect(editor()).toMatchObject({ scope: 1, overrides: {} });
    stepCopyScope(ID, 1);
    stepCopyScope(ID, 1);
    expect(editor().scope).toBe(2);
    stepCopyScope(ID, -1);
    stepCopyScope(ID, -1);
    stepCopyScope(ID, -1);
    expect(editor().scope).toBe(0);
  });

  it('cycles formats in f order, wrapping both ways', () => {
    select({});
    cycleCopyFormat(ID, 1);
    expect(editor().format).toBe('exact');
    cycleCopyFormat(ID, -1);
    cycleCopyFormat(ID, -1);
    expect(editor().format).toBe('joined');
  });

  it('flips a break keep → space → none → keep from wherever the format put it', () => {
    select({});
    flipCopyBreak(ID, terminal, 0);
    expect(editor().overrides[0]).toBe('none');
    flipCopyBreak(ID, terminal, 0);
    flipCopyBreak(ID, terminal, 0);
    expect(editor().overrides[0]).toBe('space');
  });

  it('nudges an edge, keeping the format and re-arming the baseline', () => {
    select({ endRow: 0, endCol: 9 });
    cycleCopyFormat(ID, 1);
    nudgeSelection(ID, 'end', 1);
    expect(getMouseSelectionState(ID).selection).toMatchObject({ endRow: 0, endCol: 14 });
    expect(editor()).toMatchObject({ format: 'exact', scope: 0 });
    expect(refreshSelectionBaseline).toHaveBeenCalledWith(ID);
  });

  it('never nudges a block slab', () => {
    select({ shape: 'block', endRow: 2, endCol: 9 });
    nudgeSelection(ID, 'end', 1);
    expect(getMouseSelectionState(ID).selection?.endCol).toBe(9);
    expect(refreshSelectionBaseline).not.toHaveBeenCalled();
  });
});

describe('copySelection', () => {
  it('writes what the editor shows and flashes its format', async () => {
    vi.mocked(writeTextToClipboard).mockResolvedValue(true);
    select({ endRow: 1, endCol: 12 });
    await copySelection(ID);
    expect(writeTextToClipboard).toHaveBeenCalledWith('The flake comes from a race between the PTY exit event and the final flush of the output');
    expect(getMouseSelectionState(ID).copyFlash).toBe('auto');
  });

  it('retains the selection without a flash when the write fails', async () => {
    vi.mocked(writeTextToClipboard).mockResolvedValue(false);
    select({});
    await copySelection(ID);
    expect(getMouseSelectionState(ID).copyFlash).toBeNull();
    expect(getMouseSelectionState(ID).selection).not.toBeNull();
  });

  it('does not flash a newer selection when an earlier copy finishes', async () => {
    let complete!: (copied: boolean) => void;
    vi.mocked(writeTextToClipboard).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    select({});
    const pending = copySelection(ID);
    beginDrag(ID, { row: 2, col: 1, altKey: false, startedInScrollback: false });
    complete(true);
    await pending;
    expect(getMouseSelectionState(ID).copyFlash).toBeNull();
    expect(getMouseSelectionState(ID).selection?.startRow).toBe(2);
  });
});
