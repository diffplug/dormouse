import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./clipboard', () => ({ writeTextToClipboard: vi.fn() }));
vi.mock('./terminal-registry', () => ({ getTerminalInstance: vi.fn() }));
import { writeTextToClipboard } from './clipboard';
import { cycleCopyFormat, flipCopyBreak, openCopyEditor, setCopyFormat, stepCopyScope } from './copy-editor';
import { copySelection, nudgeSelection } from './copy-selection';
import {
  __resetMouseSelectionForTests,
  beginDrag,
  getMouseSelectionState,
  offerProgramCopy,
  setSelection,
  subscribeToMouseSelection,
  type Selection,
} from './mouse-selection';
import { getTerminalInstance } from './terminal-registry';
import { CLAUDE_REPLY, fakeXterm } from './copy-text-fixtures';

const terminal = fakeXterm(CLAUDE_REPLY);
const ID = 'term-1';

/** The reply's first paragraph, or part of it, as mouse-up leaves it. */
function select(over: Partial<Selection>): void {
  setSelection(ID, { startRow: 2, startCol: 2, endRow: 5, endCol: 27, shape: 'linewise', dragging: false, startedInScrollback: false, ...over });
  openCopyEditor(ID, terminal);
}
const editor = () => getMouseSelectionState(ID).copyEditor!;

beforeEach(() => {
  __resetMouseSelectionForTests();
  vi.mocked(getTerminalInstance).mockReturnValue(terminal);
  vi.mocked(writeTextToClipboard).mockReset();
});

describe('copy editor transitions', () => {
  it('opens in Auto at the selection’s own scope', () => {
    select({ startCol: 27, endRow: 3, endCol: 5 });
    expect(editor()).toMatchObject({ scope: 0, format: 'auto', overrides: {} });
    expect(editor().scopes.map((s) => s.label)).toEqual(['As selected', 'Whole words', 'Paragraph']);
  });

  it('steps the scope and stops at either end, clearing overrides', () => {
    select({ startCol: 27, endRow: 3, endCol: 5 });
    flipCopyBreak(ID, 0, 'space');
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

  it('flips the kind a mark shows: keep → space → none → keep', () => {
    select({});
    flipCopyBreak(ID, 0, 'space');
    expect(editor().overrides[0]).toBe('none');
    flipCopyBreak(ID, 0, 'none');
    expect(editor().overrides[0]).toBe('keep');
  });

  it('nudges an edge in one write, keeping the format', () => {
    select({ endRow: 2, endCol: 11 });
    cycleCopyFormat(ID, 1);
    const seen: unknown[] = [];
    const unsubscribe = subscribeToMouseSelection(() => seen.push(getMouseSelectionState(ID).copyEditor?.format));
    nudgeSelection(ID, 'end', 1);
    unsubscribe();
    expect(getMouseSelectionState(ID).selection).toMatchObject({ endRow: 2, endCol: 16 });
    expect(editor()).toMatchObject({ format: 'exact', scope: 0 });
    expect(seen).toEqual(['exact']);
  });

  it('never nudges a block slab', () => {
    select({ shape: 'block', endRow: 4, endCol: 11 });
    nudgeSelection(ID, 'end', 1);
    expect(getMouseSelectionState(ID).selection?.endCol).toBe(11);
  });
});

describe('the program’s own copy', () => {
  function shadowWithOffer(text: string): void {
    setSelection(ID, { startRow: 2, startCol: 27, endRow: 3, endCol: 5, shape: 'linewise', dragging: false, startedInScrollback: false, owner: 'program' });
    offerProgramCopy(ID, text);
    openCopyEditor(ID, terminal);
  }

  it('joins the f cycle last, only once the program sent one', () => {
    select({});
    cycleCopyFormat(ID, -1);
    expect(editor().format).toBe('joined');
    shadowWithOffer('**The flake** comes from a race');
    cycleCopyFormat(ID, -1);
    expect(editor().format).toBe('program');
  });

  it('sets scope aside: picking it returns to the selection, and e does nothing', () => {
    shadowWithOffer('anything');
    stepCopyScope(ID, 1);
    expect(editor().scope).toBe(1);
    setCopyFormat(ID, 'program');
    expect(editor().scope).toBe(0);
    stepCopyScope(ID, 1);
    expect(editor().scope).toBe(0);
  });

  it('is never a format without an offer', () => {
    select({});
    setCopyFormat(ID, 'program');
    expect(editor().format).toBe('auto');
  });

  it('copies the program’s text, as sent', async () => {
    vi.mocked(writeTextToClipboard).mockResolvedValue(true);
    shadowWithOffer('**The flake** comes\nfrom a race');
    setCopyFormat(ID, 'program');
    await copySelection(ID);
    expect(writeTextToClipboard).toHaveBeenCalledWith('**The flake** comes\nfrom a race');
    expect(getMouseSelectionState(ID).copyFlash).toBe('program');
  });

  it('falls back to Auto when a nudge moves off what the program copied', () => {
    shadowWithOffer('anything');
    setCopyFormat(ID, 'program');
    nudgeSelection(ID, 'end', -1);
    expect(editor().format).toBe('auto');
    expect(getMouseSelectionState(ID).programCopy).toBeNull();
  });
});

describe('copySelection', () => {
  it('writes what the editor shows and flashes its format', async () => {
    vi.mocked(writeTextToClipboard).mockResolvedValue(true);
    select({ endRow: 3, endCol: 14 });
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
    beginDrag(ID, { row: 9, col: 1, altKey: false, startedInScrollback: false });
    complete(true);
    await pending;
    expect(getMouseSelectionState(ID).copyFlash).toBeNull();
    expect(getMouseSelectionState(ID).selection?.startRow).toBe(9);
  });
});
