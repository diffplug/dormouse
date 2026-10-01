import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./clipboard', () => ({ writeTextToClipboard: vi.fn() }));
import { writeTextToClipboard } from './clipboard';
import { cycleCopyFormat, flipCopyBreak, nudgeCopyEdge, openCopyEditor, setCopyFormat, stepCopyScope } from './copy-editor';
import { copySelection } from './copy-selection';
import {
  __resetMouseSelectionForTests,
  beginDrag,
  COPY_FLASH_MS,
  flashCopy,
  getMouseSelectionState,
  offerProgramCopy,
  setSelection,
  subscribeToMouseSelection,
  TOUCH_COPY_FLASH_MS,
  type Selection,
} from './mouse-selection';
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
    nudgeCopyEdge(ID, 'end', 1);
    unsubscribe();
    expect(getMouseSelectionState(ID).selection).toMatchObject({ endRow: 2, endCol: 16 });
    expect(editor()).toMatchObject({ format: 'exact', scope: 0 });
    expect(seen).toEqual(['exact']);
  });

  it('never nudges a block slab', () => {
    select({ shape: 'block', endRow: 4, endCol: 11 });
    nudgeCopyEdge(ID, 'end', 1);
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
    expect(getMouseSelectionState(ID).copyOutcome).toBe('copied');
  });

  it('falls back to Auto when a nudge moves off what the program copied', () => {
    shadowWithOffer('anything');
    setCopyFormat(ID, 'program');
    nudgeCopyEdge(ID, 'end', -1);
    expect(editor().format).toBe('auto');
    expect(getMouseSelectionState(ID).programCopy).toBeNull();
  });
});

describe('copySelection', () => {
  it('writes what the editor shows and confirms it', async () => {
    vi.mocked(writeTextToClipboard).mockResolvedValue(true);
    select({ endRow: 3, endCol: 14 });
    await copySelection(ID);
    expect(writeTextToClipboard).toHaveBeenCalledWith('The flake comes from a race between the PTY exit event and the final flush of the output');
    expect(getMouseSelectionState(ID).copyOutcome).toBe('copied');
  });

  it('closes when the flash ends, though a nudge moved the selection during it', () => {
    vi.useFakeTimers();
    try {
      select({ endRow: 2, endCol: 11 });
      flashCopy(ID);
      nudgeCopyEdge(ID, 'end', 1);
      expect(getMouseSelectionState(ID)).toMatchObject({ selection: { endCol: 16 }, copyOutcome: 'copied' });
      vi.advanceTimersByTime(700);
      expect(getMouseSelectionState(ID)).toMatchObject({ selection: null, copyEditor: null, copyOutcome: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('says a failed write failed, for that selection', async () => {
    vi.mocked(writeTextToClipboard).mockResolvedValue(false);
    select({});
    const { selection } = getMouseSelectionState(ID);
    await copySelection(ID);
    expect(getMouseSelectionState(ID)).toMatchObject({ selection, copyOutcome: 'failed' });
  });

  it('holds the flash longer on touch, with a tap of vibration', async () => {
    vi.useFakeTimers();
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate });
    try {
      vi.mocked(writeTextToClipboard).mockResolvedValue(true);
      select({});
      await copySelection(ID, { touch: true });
      expect(vibrate).toHaveBeenCalledWith(10);
      vi.advanceTimersByTime(COPY_FLASH_MS);
      expect(getMouseSelectionState(ID).copyOutcome).toBe('copied');
      vi.advanceTimersByTime(TOUCH_COPY_FLASH_MS - COPY_FLASH_MS);
      expect(getMouseSelectionState(ID).selection).toBeNull();
      // Desktop keeps the short flash, and never vibrates.
      select({});
      await copySelection(ID);
      vi.advanceTimersByTime(COPY_FLASH_MS);
      expect(getMouseSelectionState(ID).selection).toBeNull();
      expect(vibrate).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it.each([true, false])('neither flashes nor fails a newer selection when an earlier copy finishes (copied: %s)', async (copied) => {
    let complete!: (copied: boolean) => void;
    vi.mocked(writeTextToClipboard).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    select({});
    const pending = copySelection(ID);
    beginDrag(ID, { row: 9, col: 1, altKey: false, startedInScrollback: false });
    complete(copied);
    await pending;
    expect(getMouseSelectionState(ID)).toMatchObject({ copyOutcome: null, selection: { startRow: 9 } });
  });
});
