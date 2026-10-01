/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/platform', () => ({ IS_MAC: true }));
// The registry barrel boots xterm; the overlay only reads the measured grid.
vi.mock('../lib/terminal-registry', () => ({ getTerminalOverlayDims: vi.fn() }));
import { cfg } from '../cfg';
import { __resetMouseSelectionForTests, flashCopy, setSelection } from '../lib/mouse-selection';
import { getTerminalOverlayDims } from '../lib/terminal-registry';
import { SelectionOverlay } from './SelectionOverlay';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const DIMS = {
  cols: 80, rows: 24, viewportY: 0, baseY: 0,
  elementLeft: 0, elementTop: 0, elementWidth: 800, elementHeight: 240,
  cellWidth: 10, cellHeight: 10, gridLeft: 0, gridTop: 0,
};

let container: HTMLDivElement;
let root: Root;
let previousAnimate: boolean;

const flashFill = () => container.querySelector('path[data-copy-flash]');

beforeEach(() => {
  __resetMouseSelectionForTests();
  vi.mocked(getTerminalOverlayDims).mockReturnValue(DIMS);
  previousAnimate = cfg.layout.animate;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => {
    setSelection('term-1', { startRow: 2, startCol: 4, endRow: 3, endCol: 10, shape: 'linewise', dragging: false, startedInScrollback: false });
    root.render(<SelectionOverlay terminalId="term-1" />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  cfg.layout.animate = previousAnimate;
  vi.useRealTimers();
});

describe('SelectionOverlay: a confirmed copy', () => {
  it('fills the copied selection, pulsing, while the copy confirms', () => {
    cfg.layout.animate = true;
    expect(flashFill()).toBeNull();
    act(() => flashCopy('term-1', 'auto'));
    const outline = container.querySelector('path[stroke]')!;
    expect(flashFill()!.getAttribute('d')).toBe(outline.getAttribute('d'));
    expect(flashFill()!.getAttribute('class')).toContain('fill-header-active-bg/25');
    expect(flashFill()!.getAttribute('class')).toContain('animate-copy-flash-fill');
    act(() => vi.advanceTimersByTime(700));
    expect(flashFill()).toBeNull();
  });

  it('shows the fill still under instant motion', () => {
    cfg.layout.animate = false;
    act(() => flashCopy('term-1', 'auto'));
    expect(flashFill()!.getAttribute('class')).toContain('fill-header-active-bg/25');
    expect(flashFill()!.getAttribute('class')).not.toContain('animate-');
  });
});
