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
// Capture is exercised on its own; here it is only the button's effect.
vi.mock('../lib/notepad/capture', () => ({
  addSelectionToNotepad: vi.fn(() => true),
  isNotepadChordBound: vi.fn(() => true),
}));
// Whether the host has a notepad at all — one gate, shared with the headers and
// the Door (`hasNotepadArchive` in `lib/src/lib/notepad/archive-service.ts`).
vi.mock('../lib/notepad/archive-service', () => ({ hasNotepadArchive: vi.fn(() => true) }));

import { addSelectionToNotepad, isNotepadChordBound } from '../lib/notepad/capture';
import { hasNotepadArchive } from '../lib/notepad/archive-service';
import {
  __resetMouseSelectionForTests,
  getMouseSelectionState,
  setSelection,
} from '../lib/mouse-selection';
import { getTerminalOverlayDims } from '../lib/terminal-registry';
import { SelectionPopup } from './SelectionPopup';

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
const notepadButton = () =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Add to notepad'));

beforeEach(() => {
  __resetMouseSelectionForTests();
  vi.mocked(getTerminalOverlayDims).mockReturnValue({ ...DIMS });
  vi.mocked(addSelectionToNotepad).mockClear().mockReturnValue(true);
  vi.mocked(hasNotepadArchive).mockReturnValue(true);
  vi.mocked(isNotepadChordBound).mockReturnValue(true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SelectionPopup: Add to notepad', () => {
  it('offers the capture after the two copies, with its chord', () => {
    renderWithSelection();

    expect(buttons()).toEqual(['[Cmd+C] Copy Raw', '[Cmd+Shift+C] Copy Rewrapped', '[Cmd+N] Add to notepad']);
  });

  it('hides the button entirely on a host with no notepad', () => {
    vi.mocked(hasNotepadArchive).mockReturnValue(false);
    renderWithSelection();

    expect(notepadButton()).toBeUndefined();
    expect(buttons()).toHaveLength(2);
  });

  it('keeps the button but shows no chord when the browser reserves it', () => {
    vi.mocked(isNotepadChordBound).mockReturnValue(false);
    renderWithSelection();

    expect(notepadButton()?.textContent).toBe('Add to notepad');
    // The copy chords are unaffected — only N is the browser's.
    expect(buttons()[0]).toBe('[Cmd+C] Copy Raw');
  });

  it('captures and flashes on click, then dismisses the selection', () => {
    vi.useFakeTimers();
    try {
      renderWithSelection();
      act(() => {
        notepadButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(addSelectionToNotepad).toHaveBeenCalledWith('term-1');
      expect(getMouseSelectionState('term-1').copyFlash).toBe('notepad');
      // The check is laid over the (hidden, still-measured) shortcut, so the
      // button keeps its width while it flashes.
      expect(notepadButton()?.className).toContain('animate-copy-flash');
      expect(notepadButton()?.querySelector('.invisible')?.textContent).toBe('[Cmd+N]');

      // The same timer the copies use clears the flash *and* the selection, so
      // the popup dismisses without ever opening the notepad.
      act(() => {
        vi.runAllTimers();
      });
      expect(getMouseSelectionState('term-1').copyFlash).toBeNull();
      expect(getMouseSelectionState('term-1').selection).toBeNull();
      expect(container.querySelector('button')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not flash when there was nothing to capture', () => {
    vi.mocked(addSelectionToNotepad).mockReturnValue(false);
    renderWithSelection();
    act(() => {
      notepadButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(getMouseSelectionState('term-1').copyFlash).toBeNull();
    expect(getMouseSelectionState('term-1').selection).not.toBeNull();
  });

  it('reserves room for the third button when clamping to the right edge', () => {
    // End column 60 of an 600px-wide element is past where either row fits, so
    // the left is the reserve and nothing else.
    vi.mocked(getTerminalOverlayDims).mockReturnValue({ ...DIMS, elementWidth: 600 });
    const leftWith = renderAndReadLeft({ startRow: 1, startCol: 0, endRow: 2, endCol: 60 });

    act(() => root.unmount());
    root = createRoot(container);
    vi.mocked(hasNotepadArchive).mockReturnValue(false);
    const leftWithout = renderAndReadLeft({ startRow: 1, startCol: 0, endRow: 2, endCol: 60 });

    expect(leftWith).toBeGreaterThan(0);
    expect(leftWith).toBeLessThan(leftWithout);
  });
});
