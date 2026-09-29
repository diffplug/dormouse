/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/clipboard', () => ({ copyRaw: vi.fn(), copyRewrapped: vi.fn() }));
vi.mock('../lib/platform', () => ({ IS_MAC: true }));
// The registry barrel boots xterm; the popup only reads the measured grid.
vi.mock('../lib/terminal-registry', () => ({ getTerminalOverlayDims: vi.fn() }));
import { copyRaw } from '../lib/clipboard';
import {
  __resetMouseSelectionForTests,
  beginDrag,
  bumpRenderTick,
  endDrag,
  flashCopy,
  getMouseSelectionState,
  setSelection,
} from '../lib/mouse-selection';
import { getTerminalOverlayDims } from '../lib/terminal-registry';
import { SelectionPopup } from './SelectionPopup';
import { WorkspaceActiveContext } from './wall/wall-context';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const DIMS = {
  cols: 80,
  rows: 24,
  viewportY: 0,
  baseY: 0,
  elementWidth: 900,
  elementHeight: 400,
  cellWidth: 8,
  cellHeight: 16,
  gridLeft: 4,
  gridTop: 4,
};

let container: HTMLDivElement;
let root: Root;

function render(): void {
  act(() => root.render(<SelectionPopup terminalId="term-1" />));
}

/** Render with a finalized selection, which is what raises the popup. */
function renderWithSelection(): void {
  act(() => {
    setSelection('term-1', {
      startRow: 1,
      startCol: 0,
      endRow: 2,
      endCol: 10,
      shape: 'linewise',
      dragging: false,
      startedInScrollback: false,
    });
  });
  render();
}

/** Render one selection and read back where the clamp placed the popup. */
function renderAndReadLeft(selection: { startRow: number; startCol: number; endRow: number; endCol: number }): number {
  act(() => {
    setSelection('term-1', {
      ...selection,
      shape: 'linewise',
      dragging: false,
      startedInScrollback: false,
    });
  });
  render();
  const popup = container.querySelector<HTMLElement>('[data-selection-popup-for="term-1"]');
  return Number.parseFloat(popup?.style.left ?? 'NaN');
}

const buttons = () => Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
beforeEach(() => {
  __resetMouseSelectionForTests();
  vi.mocked(getTerminalOverlayDims).mockReturnValue({ ...DIMS });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('SelectionPopup: copy and flash', () => {
  // A ten-line viewport over ten scrollback lines, so a scroll moves the anchor
  // by whole cells.
  const COPY_DIMS = { ...DIMS, baseY: 10, elementWidth: 800, elementHeight: 240, cellWidth: 10, cellHeight: 10, gridLeft: 0, gridTop: 0 };
  let dims: typeof COPY_DIMS;
  const popup = () => container.querySelector<HTMLElement>('[data-selection-popup-for]')!;
  const copyRawButton = () => container.querySelector<HTMLButtonElement>('button')!;
  /** A finalized drag starting in scrollback, as the mouse handlers raise it. */
  const drag = (row: number, col: number) => {
    beginDrag('term-1', { row, col, altKey: false, startedInScrollback: true });
    endDrag('term-1');
  };

  beforeEach(() => {
    dims = { ...COPY_DIMS };
    vi.mocked(getTerminalOverlayDims).mockImplementation(() => dims);
    vi.mocked(copyRaw).mockReset();
    drag(5, 3);
    render();
  });

  it('reanchors after scrolling with the same finalized selection', () => {
    expect(popup().style.top).toBe('74px');
    dims.viewportY = 3;
    act(() => bumpRenderTick());
    expect(popup().style.top).toBe('44px');
  });

  it('dismisses immediately when selection is canceled during the copied flash', () => {
    vi.useFakeTimers();
    act(() => flashCopy('term-1', 'raw'));
    act(() => setSelection('term-1', null));
    expect(container.querySelector('[data-selection-popup-for]')).toBeNull();
  });

  it('keeps a newer copied selection for its own confirmation duration', () => {
    vi.useFakeTimers();
    act(() => flashCopy('term-1', 'raw'));
    act(() => vi.advanceTimersByTime(400));
    act(() => {
      drag(8, 1);
      flashCopy('term-1', 'raw');
    });
    act(() => vi.advanceTimersByTime(300));
    expect(getMouseSelectionState('term-1').selection?.startRow).toBe(8);
    act(() => vi.advanceTimersByTime(400));
    expect(getMouseSelectionState('term-1').selection).toBeNull();
  });

  it('retains a selection without a success flash when copying fails', async () => {
    vi.mocked(copyRaw).mockResolvedValue(false);
    await act(async () => copyRawButton().click());
    expect(getMouseSelectionState('term-1').copyFlash).toBeNull();
    expect(getMouseSelectionState('term-1').selection).not.toBeNull();
  });

  it('does not clear a newer selection when a previous copy finishes', async () => {
    let complete!: (copied: boolean) => void;
    vi.mocked(copyRaw).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    act(() => copyRawButton().click());
    act(() => beginDrag('term-1', { row: 8, col: 1, altKey: false, startedInScrollback: true }));
    await act(async () => complete(true));
    expect(getMouseSelectionState('term-1').copyFlash).toBeNull();
    expect(getMouseSelectionState('term-1').selection?.startRow).toBe(8);
  });
});

describe('SelectionPopup: hidden Workspace', () => {
  /** The same finalized selection, rendered inside a Wall that is not the
   *  visible Workspace. */
  function renderHidden(): void {
    act(() => {
      setSelection('term-1', {
        startRow: 1,
        startCol: 0,
        endRow: 2,
        endCol: 10,
        shape: 'linewise',
        dragging: false,
        startedInScrollback: false,
      });
    });
    act(() => root.render(
      <WorkspaceActiveContext.Provider value={false}>
        <SelectionPopup terminalId="term-1" />
      </WorkspaceActiveContext.Provider>,
    ));
  }

  it('renders nothing and swallows no window input, keeping the selection for the way back', () => {
    renderHidden();
    expect(container.querySelector('[data-selection-popup-for="term-1"]')).toBeNull();

    // The dismissal listeners are capture-phase window listeners: answering
    // these would take an Escape or a click from the visible Workspace
    // (docs/specs/layout.md -> "Workspaces").
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(false);
    act(() => { window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(getMouseSelectionState('term-1').selection).not.toBeNull();

    // Visible again: the popup comes back over the same selection.
    act(() => root.render(<SelectionPopup terminalId="term-1" />));
    expect(container.querySelector('[data-selection-popup-for="term-1"]')).not.toBeNull();
  });
});
