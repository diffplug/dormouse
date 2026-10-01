/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/copy-selection', () => ({ copySelection: vi.fn() }));
vi.mock('../lib/platform', () => ({ IS_MAC: true }));
// The registry barrel boots xterm; the editor only reads the grid and buffer.
vi.mock('../lib/terminal-registry', () => ({ getTerminalOverlayDims: vi.fn(), getTerminalInstance: vi.fn() }));
import { copySelection } from '../lib/copy-selection';
import { openCopyEditor } from '../lib/copy-editor';
import { CLAUDE_REPLY, fakeXterm } from '../lib/copy-text-fixtures';
import {
  __resetMouseSelectionForTests,
  beginDrag,
  bumpRenderTick,
  endDrag,
  flashCopy,
  getMouseSelectionState,
  setSelection,
} from '../lib/mouse-selection';
import { getTerminalInstance, getTerminalOverlayDims } from '../lib/terminal-registry';
import { CopyEditor } from './CopyEditor';
import { TouchUiContext } from './touch-ui-context';
import { WorkspaceActiveContext } from './wall/wall-context';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// A forty-row viewport over ten scrollback lines, so a scroll moves the editor
// by whole cells.
const DIMS = {
  cols: 80,
  rows: 40,
  viewportY: 0,
  baseY: 10,
  elementWidth: 800,
  elementHeight: 400,
  cellWidth: 10,
  cellHeight: 10,
  gridLeft: 0,
  gridTop: 0,
};

let container: HTMLDivElement;
let root: Root;
let dims: typeof DIMS;
const terminal = fakeXterm(CLAUDE_REPLY);

const editor = () => container.querySelector<HTMLElement>('[data-copy-editor-for="term-1"]');
const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)!;

function render(ui = <CopyEditor terminalId="term-1" />): void {
  act(() => root.render(ui));
}

/** A finalized drag over rows `r0`..`r1`, opened as mouse-up opens it. */
function drag(r0: number, c0: number, r1: number, c1: number): void {
  act(() => {
    beginDrag('term-1', { row: r0, col: c0, altKey: false, startedInScrollback: false });
    setSelection('term-1', { ...getMouseSelectionState('term-1').selection!, endRow: r1, endCol: c1 });
    endDrag('term-1');
    openCopyEditor('term-1', terminal);
  });
}

beforeEach(() => {
  __resetMouseSelectionForTests();
  dims = { ...DIMS };
  vi.mocked(getTerminalOverlayDims).mockImplementation(() => dims);
  vi.mocked(getTerminalInstance).mockReturnValue(terminal);
  vi.mocked(copySelection).mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('CopyEditor: opening and placement', () => {
  it('stays closed over a selection nobody opened it for', () => {
    act(() => setSelection('term-1', { startRow: 0, startCol: 0, endRow: 1, endCol: 5, shape: 'linewise', dragging: false, startedInScrollback: false }));
    render();
    expect(editor()).toBeNull();
  });

  it('opens below a selection with room, and reanchors when it scrolls', () => {
    drag(2, 25, 5, 27);
    render();
    expect(editor()?.style.top).toBe('64px');
    dims.viewportY = 2;
    act(() => bumpRenderTick());
    expect(editor()?.style.top).toBe('44px');
  });

  it('opens above when there is more room there', () => {
    drag(30, 0, 31, 5);
    render();
    expect(editor()?.style.top).toBe('');
    expect(editor()?.style.bottom).toBe('104px');
  });

  it('docks over a selection that leaves no room beside it', () => {
    drag(2, 0, 37, 5);
    render();
    expect(editor()?.style.bottom).toBe('4px');
  });

  it('prefers above on touch, clear of the thumb', () => {
    drag(20, 0, 20, 40);
    render(<TouchUiContext.Provider value><CopyEditor terminalId="term-1" /></TouchUiContext.Provider>);
    expect(editor()?.style.bottom).not.toBe('');
    expect(container.textContent).not.toContain('[f]');
  });
});

describe('CopyEditor: preview and controls', () => {
  it('previews Auto with a mark on every break', () => {
    drag(2, 2, 5, 27);
    render();
    expect(container.textContent).toContain('final flush␣of the output');
    expect(container.textContent).toContain('1 line');
  });

  it('switches format from the segment and dims a format that adds nothing', () => {
    drag(2, 2, 5, 27);
    render();
    expect(button('Spaces').className).toContain('opacity-50');
    act(() => button('Exact').click());
    expect(getMouseSelectionState('term-1').copyEditor?.format).toBe('exact');
    expect(container.textContent).toContain('4 lines');
  });

  it('flips one break from its mark and marks the format edited', () => {
    drag(2, 2, 5, 27);
    render();
    act(() => button('␣').click());
    expect(getMouseSelectionState('term-1').copyEditor?.overrides).toEqual({ 0: 'none' });
    expect(button('Auto*')).toBeDefined();
  });

  it('expands from the scope segment and shows what it added', () => {
    drag(2, 27, 3, 5);
    render();
    act(() => button('Whole words').click());
    expect(getMouseSelectionState('term-1').copyEditor?.scope).toBe(1);
    expect(container.textContent).toContain('expanded');
  });

  it('copies from the button', () => {
    drag(2, 2, 5, 27);
    render();
    act(() => button('Copy').click());
    expect(copySelection).toHaveBeenCalledWith('term-1');
  });

  it('dismisses on a click outside, not inside', () => {
    drag(2, 2, 5, 27);
    render();
    act(() => { editor()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(getMouseSelectionState('term-1').selection).not.toBeNull();
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(getMouseSelectionState('term-1').selection).toBeNull();
  });
});

describe('CopyEditor: flash', () => {
  beforeEach(() => {
    drag(5, 2, 5, 12);
    render();
  });

  it('dismisses immediately when the selection is canceled during the flash', () => {
    vi.useFakeTimers();
    act(() => flashCopy('term-1', 'auto'));
    act(() => setSelection('term-1', null));
    expect(editor()).toBeNull();
  });

  it('keeps a newer copied selection for its own confirmation duration', () => {
    vi.useFakeTimers();
    act(() => flashCopy('term-1', 'auto'));
    act(() => vi.advanceTimersByTime(400));
    drag(9, 4, 9, 20);
    act(() => flashCopy('term-1', 'auto'));
    act(() => vi.advanceTimersByTime(300));
    expect(getMouseSelectionState('term-1').selection?.startRow).toBe(9);
    act(() => vi.advanceTimersByTime(400));
    expect(getMouseSelectionState('term-1').selection).toBeNull();
  });
});

describe('CopyEditor: hidden Workspace', () => {
  it('renders nothing and swallows no window input, keeping the selection for the way back', () => {
    drag(0, 0, 1, 10);
    render(
      <WorkspaceActiveContext.Provider value={false}>
        <CopyEditor terminalId="term-1" />
      </WorkspaceActiveContext.Provider>,
    );
    expect(editor()).toBeNull();
    // The dismissal listener is a capture-phase window listener: answering it
    // would take a click from the visible Workspace (docs/specs/layout.md ->
    // "Workspaces").
    act(() => { window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(getMouseSelectionState('term-1').selection).not.toBeNull();
    render();
    expect(editor()).not.toBeNull();
  });
});
