/**
 * @vitest-environment jsdom
 */
import { act, StrictMode, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/copy-selection', () => ({ copySelection: vi.fn() }));
vi.mock('../lib/platform', () => ({ IS_MAC: true }));
// The registry barrel boots xterm; the editor only reads the measured grid.
vi.mock('../lib/terminal-registry', () => ({ getTerminalOverlayDims: vi.fn() }));
// jsdom lays nothing out: the editor's natural size is each test's to set.
vi.mock('./copy-editor-measure', () => ({ measureNaturalWidth: vi.fn(), measureChromeWidth: vi.fn(), createHeightMeasurer: vi.fn() }));
import { cfg } from '../cfg';
import { copySelection } from '../lib/copy-selection';
import { followCopySelection, openCopyEditor } from '../lib/copy-editor';
import { TOUCH_SLOP_PX } from '../lib/copy-editor-placement';
import { CLAUDE_REPLY, fakeXterm } from '../lib/copy-text-fixtures';
import { anchoredTarget } from '../lib/dom';
import {
  __resetMouseSelectionForTests,
  beginDrag,
  bumpRenderTick,
  endDrag,
  failCopy,
  flashCopy,
  getMouseSelectionState,
  offerProgramCopy,
  setSelection,
} from '../lib/mouse-selection';
import { getTerminalOverlayDims } from '../lib/terminal-registry';
import { CopyEditor } from './CopyEditor';
import { createHeightMeasurer, measureChromeWidth, measureNaturalWidth } from './copy-editor-measure';
import { TouchUiContext } from './touch-ui-context';
import { installFakeFrames } from './motion-test-utils';
import { pointerEvent } from './wall/wall-test-utils';
import { createWorkspaceMotion } from './workspace-motion';
import { LayoutFramesContext, WorkspaceActiveContext, WorkspaceIdContext, ZoomedIdContext } from './wall/wall-context';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// A forty-row grid of 10px cells in an 800×400 pane at (100, 50), in jsdom's
// 1024×768 window: the usable viewport is 12..1012 × 12..756. Rows 2..5 band
// y 70..110, so below starts at 114, and the pane's left plus the gap is 104.
const DIMS = {
  cols: 80,
  rows: 40,
  viewportY: 0,
  baseY: 10,
  elementLeft: 100,
  elementTop: 50,
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
/** The editor's measured size: its longest line, its header and footer, their
 *  controls alone, and its height at any width. */
let natural: { width: number; chrome: number; essential: number; height: number };
const terminal = fakeXterm(CLAUDE_REPLY);

const frames = installFakeFrames();
let previousAnimate: boolean;
let resizeObservers: Set<() => void>;

/** Advance the clock and run the frames queued as of now. */
const frame = (ms = 16) => frames.advance(ms);

const editor = () => document.body.querySelector<HTMLElement>('[data-copy-editor-for="term-1"]');
/** What the editor shows, its inert probes left out. */
const text = () => Array.from(editor()?.children ?? [], (part) => (part.hasAttribute('inert') ? '' : part.textContent)).join('');
/** A shown button by its label: its accessible name, else its text. */
const button = (label: string) => Array.from(editor()!.querySelectorAll('button'))
  .find((b) => (b.getAttribute('aria-label') ?? b.textContent) === label && !b.closest('[inert]'))!;
/** The Copy button, and the label it shows of the ones it stacks. */
const copyButton = () => editor()!.querySelector<HTMLButtonElement>(':scope > div:not([inert]) [data-copy-state]')!;
const shownLabel = () => Array.from(copyButton().querySelectorAll('span > span')).find((l) => !l.classList.contains('invisible'))?.textContent;
/** The probe laying out the header and footer, the inert part with segments. */
const chromeProbe = () => Array.from(editor()!.querySelectorAll('[inert]')).find((part) => part.querySelector('[aria-pressed]'))!;
const side = () => editor()?.dataset.copyEditorSide;
const box = () => {
  const { left, top, width, height } = editor()!.style;
  return { left, top, width, height };
};
const px = (left: number, top: number, width: number, height: number) => ({ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });

function render(ui: ReactElement = <CopyEditor terminalId="term-1" />): void {
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
  natural = { width: 300, chrome: 200, essential: 150, height: 150 };
  vi.mocked(getTerminalOverlayDims).mockImplementation(() => dims);
  vi.mocked(measureNaturalWidth).mockImplementation(() => natural.width);
  vi.mocked(measureChromeWidth).mockImplementation((parts, probe) => (probe === parts.essentialProbe ? natural.essential : natural.chrome));
  vi.mocked(createHeightMeasurer).mockImplementation(() => () => natural.height);
  vi.mocked(copySelection).mockReset();

  // Position assertions read settled rects; the easing case turns motion back on.
  previousAnimate = cfg.layout.animate;
  cfg.layout.animate = false;
  resizeObservers = new Set();
  vi.stubGlobal('ResizeObserver', class {
    private readonly fire: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.fire = () => callback([], this as unknown as ResizeObserver);
    }
    observe(): void { resizeObservers.add(this.fire); }
    unobserve(): void {}
    disconnect(): void { resizeObservers.delete(this.fire); }
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  cfg.layout.animate = previousAnimate;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('CopyEditor: opening and placement', () => {
  it('stays closed over a selection nobody opened it for', () => {
    act(() => setSelection('term-1', { startRow: 0, startCol: 0, endRow: 1, endCol: 5, shape: 'linewise', dragging: false, startedInScrollback: false }));
    render();
    expect(editor()).toBeNull();
  });

  it('opens below the selection on document.body, placed before any frame', () => {
    drag(2, 25, 5, 27);
    render();
    expect(editor()!.parentElement).toBe(document.body);
    expect(container.contains(editor())).toBe(false);
    expect(side()).toBe('below');
    // At least the pane's width less the gaps, though its lines are narrower.
    expect(box()).toEqual(px(104, 114, 792, 150));
    expect(editor()!.style.visibility).toBe('visible');
    expect(frames.pending).toBe(0);
  });

  it('grows to its longest line, held inside the window', () => {
    natural.width = 950;
    drag(2, 25, 5, 27);
    render();
    expect(box()).toEqual(px(62, 114, 950, 150));
  });

  it('widens past a narrow pane and its lines to show its header and footer whole', () => {
    // A 19-column pane over a short line.
    dims.elementWidth = 190;
    Object.assign(natural, { width: 120, chrome: 460 });
    drag(2, 25, 2, 30);
    render();
    expect(box()).toEqual(px(104, 84, 460, 150));
  });

  it('opens above when below has no room', () => {
    dims.elementTop = 350;
    drag(30, 0, 31, 5);
    render();
    expect(side()).toBe('above');
    expect(box()).toEqual(px(104, 496, 792, 150));
  });

  it.each([
    // Pane x 400..600: 408px of room to its right, 384 to its left.
    { left: 400, expected: 'right', x: 604, width: 300 },
    // Pane x 600..800: 208px to its right, 584 to its left.
    { left: 600, expected: 'left', x: 296, width: 300 },
  ])('takes the roomier side of the pane beside a tall selection ($expected)', ({ left, expected, x, width }) => {
    Object.assign(dims, { elementLeft: left, elementTop: 20, elementWidth: 200, elementHeight: 720, cellHeight: 18 });
    drag(1, 0, 38, 5);
    render();
    expect(side()).toBe(expected);
    expect(box()).toEqual(px(x, 38, width, 150));
  });

  it('takes a side narrower than its chrome, which needs only its controls', () => {
    // Pane x 400..600: 408px of room to its right, short of the 500px chrome.
    Object.assign(dims, { elementLeft: 400, elementTop: 20, elementWidth: 200, elementHeight: 720, cellHeight: 18 });
    Object.assign(natural, { chrome: 500, essential: 260 });
    drag(1, 0, 38, 5);
    render();
    expect(side()).toBe('right');
    expect(box()).toEqual(px(604, 38, 408, 150));
    // Its controls, laid out without the key hints and the legend.
    const essential = Array.from(editor()!.querySelectorAll('[inert]')).filter((part) => part.querySelector('[aria-pressed]'))[1];
    expect(essential.textContent).toContain('Paragraph');
    expect(essential.textContent).toContain('Copy');
    expect(essential.textContent).not.toContain('kept');
    expect(essential.textContent).not.toContain('[');
  });

  it('squishes into the roomier of below and above when neither holds it whole', () => {
    Object.assign(dims, { elementLeft: 0, elementTop: 0, elementWidth: 1024 });
    natural.height = 700;
    drag(10, 0, 11, 5);
    render();
    expect(side()).toBe('squish-below');
    expect(box()).toEqual(px(12, 124, 1000, 632));
  });

  it('docks over the selection at the pane bottom when no spot has room', () => {
    Object.assign(dims, { elementLeft: 0, elementTop: 0, elementWidth: 1024, elementHeight: 760, cellHeight: 19 });
    drag(0, 0, 39, 5);
    render();
    expect(side()).toBe('overlay');
    expect(box()).toEqual(px(12, 602, 1000, 150));
  });

  it('prefers above on touch, clear of the thumb, with no key hints', () => {
    drag(20, 0, 20, 40);
    render(<TouchUiContext.Provider value><CopyEditor terminalId="term-1" /></TouchUiContext.Provider>);
    expect(side()).toBe('above');
    expect(box()).toEqual(px(104, 96, 792, 150));
    expect(text()).not.toContain('[f]');
  });

  it('moves off a wider scope whose band reaches it', () => {
    // 20px rows from y 330: As selected bands rows 2..3, Paragraph rows 2..5,
    // and a 320px editor fits below the first but only above the second.
    Object.assign(dims, { elementTop: 330, rows: 20, cellHeight: 20 });
    natural.height = 320;
    drag(2, 30, 3, 20);
    render();
    expect(side()).toBe('below');
    act(() => button('Paragraph').click());
    const { scopes, scope } = getMouseSelectionState('term-1').copyEditor!;
    expect(scopes[scope].label).toBe('Paragraph');
    expect(side()).toBe('above');
    expect(box()).toEqual(px(104, 46, 792, 320));
  });
});

describe('CopyEditor: following its pane', () => {
  it('re-places on the render tick, once a frame', () => {
    drag(2, 25, 5, 27);
    render();
    dims.viewportY = 2;
    act(() => { bumpRenderTick(); bumpRenderTick(); });
    expect(frames.pending).toBe(1);
    expect(editor()!.style.top).toBe('114px');
    frame();
    expect(editor()!.style.top).toBe('94px');
  });

  it('skips placement on a tick that moved nothing', () => {
    const heightAt = vi.fn(() => natural.height);
    vi.mocked(createHeightMeasurer).mockImplementation(() => heightAt);
    drag(2, 25, 5, 27);
    render();
    const placed = heightAt.mock.calls.length;
    act(() => bumpRenderTick());
    frame();
    expect(heightAt.mock.calls.length).toBe(placed);
    dims.viewportY = 2;
    act(() => bumpRenderTick());
    frame();
    expect(heightAt.mock.calls.length).toBeGreaterThan(placed);
    expect(editor()!.style.top).toBe('94px');
  });

  it('re-places on a Lath layout frame', () => {
    const frames = new Set<(settled: boolean) => void>();
    const subscribe = (cb: (settled: boolean) => void) => {
      frames.add(cb);
      return () => { frames.delete(cb); };
    };
    drag(2, 25, 5, 27);
    render(<LayoutFramesContext.Provider value={subscribe}><CopyEditor terminalId="term-1" /></LayoutFramesContext.Provider>);
    dims.elementTop = 80;
    frames.forEach((cb) => cb(false));
    frame();
    expect(editor()!.style.top).toBe('144px');
  });

  it('stays open through a resize and re-places against the reflowed pane', () => {
    drag(2, 25, 5, 27);
    render();
    dims.elementWidth = 600;
    resizeObservers.forEach((fire) => fire());
    frame();
    expect(box()).toEqual(px(104, 114, 592, 150));
    // The reflow carried the selection two rows down (spec §3.4).
    act(() => followCopySelection('term-1', fakeXterm(CLAUDE_REPLY, { cols: 60 }), { start: { row: 4, col: 25 }, end: { row: 7, col: 27 }, block: false }));
    expect(getMouseSelectionState('term-1').copyEditor).not.toBeNull();
    expect(editor()!.style.top).toBe('134px');
  });

  it('eases a move from the displayed rect, after opening snapped', () => {
    cfg.layout.animate = true;
    drag(2, 25, 5, 27);
    render();
    expect(editor()!.style.top).toBe('114px');
    dims.viewportY = 2;
    act(() => bumpRenderTick());
    frame(0);
    frame(110);
    const top = parseFloat(editor()!.style.top);
    expect(top).toBeGreaterThan(94);
    expect(top).toBeLessThan(114);
    frame(220);
    expect(editor()!.style.top).toBe('94px');
  });

  it('hides while its Wall travels, and shows again when the travel ends', () => {
    drag(2, 25, 5, 27);
    render(<WorkspaceIdContext.Provider value="ws"><div data-workspace-wall="ws"><CopyEditor terminalId="term-1" /></div></WorkspaceIdContext.Provider>);
    // The Workspace's own presentation motion transforms the Wall and reports each frame.
    const travel = createWorkspaceMotion(container.querySelector<HTMLElement>('[data-workspace-wall]')!, 'ws');
    expect(editor()!.style.visibility).toBe('visible');
    void travel.collapse();
    frame();
    expect(editor()!.style.visibility).toBe('hidden');
    expect(side()).toBeUndefined();
    travel.expand(true);
    frame();
    expect(editor()!.style.visibility).toBe('visible');
    expect(side()).toBe('below');
    travel.dispose();
  });

  it('re-places on a window resize and a scroll outside it, never its own scroll', () => {
    drag(2, 25, 5, 27);
    render();
    dims.viewportY = 2;
    editor()!.querySelector('.overflow-auto')!.dispatchEvent(new Event('scroll'));
    expect(frames.pending).toBe(0);
    document.dispatchEvent(new Event('scroll'));
    frame();
    expect(editor()!.style.top).toBe('94px');
    dims.viewportY = 0;
    window.dispatchEvent(new Event('resize'));
    frame();
    expect(editor()!.style.top).toBe('114px');
  });

  it('hides under another pane’s zoom, not its own', () => {
    drag(2, 25, 5, 27);
    const zoomed = (id: string) => (
      <ZoomedIdContext.Provider value={id}>
        <div data-lath-leaf="term-1"><CopyEditor terminalId="term-1" /></div>
      </ZoomedIdContext.Provider>
    );
    render(zoomed('other'));
    expect(editor()!.style.visibility).toBe('hidden');
    render(zoomed('term-1'));
    expect(editor()!.style.visibility).toBe('visible');
  });

  it('hides while its pane is hidden, as a parked leaf or a Tool’s other face is', () => {
    drag(2, 25, 5, 27);
    const pane = (visibility?: 'hidden') => <div style={{ visibility }}><div><CopyEditor terminalId="term-1" /></div></div>;
    render(pane());
    expect(editor()!.style.visibility).toBe('visible');
    render(pane('hidden'));
    act(() => bumpRenderTick());
    frame();
    expect(editor()!.style.visibility).toBe('hidden');
  });

  it('survives StrictMode’s second run of its effects', () => {
    drag(2, 25, 5, 27);
    render(<StrictMode><CopyEditor terminalId="term-1" /></StrictMode>);
    expect(box()).toEqual(px(104, 114, 792, 150));
    expect(container.contains(anchoredTarget(button('Copy')))).toBe(true);
    dims.viewportY = 2;
    act(() => bumpRenderTick());
    frame();
    expect(editor()!.style.top).toBe('94px');
  });
});

describe('CopyEditor: presses inside it belong to its pane', () => {
  it('never takes focus from the pane, but leaves its scrollbar its drag', () => {
    drag(2, 2, 5, 27);
    render();
    const pressed = (target: Element) => {
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      act(() => { target.dispatchEvent(down); });
      return down.defaultPrevented;
    };
    expect(pressed(button('Exact'))).toBe(true);
    expect(pressed(button('␣'))).toBe(true);
    expect(pressed(editor()!.querySelector('.overflow-auto')!)).toBe(false);
    const buttons = Array.from(editor()!.querySelectorAll('button'));
    expect(buttons.filter((b) => b.tabIndex !== -1)).toEqual([]);
    expect(getMouseSelectionState('term-1').selection).not.toBeNull();
  });

  it('dismisses on a press outside, not inside, and keeps inside presses from the pane', () => {
    const paneDown = vi.fn();
    const paneMenu = vi.fn();
    drag(2, 2, 5, 27);
    render(<div onMouseDown={paneDown} onContextMenu={paneMenu}><CopyEditor terminalId="term-1" /></div>);
    // DOM containment checks see the editor where its anchor sits.
    expect(container.contains(anchoredTarget(button('Copy')))).toBe(true);
    act(() => { button('Copy').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    act(() => { editor()!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })); });
    expect(getMouseSelectionState('term-1').selection).not.toBeNull();
    expect(paneDown).not.toHaveBeenCalled();
    expect(paneMenu).not.toHaveBeenCalled();
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(getMouseSelectionState('term-1').selection).toBeNull();
    expect(editor()).toBeNull();
  });
});

describe('CopyEditor: preview and controls', () => {
  it('previews Auto with a mark on every break', () => {
    drag(2, 2, 5, 27);
    render();
    expect(text()).toContain('final flush␣of the output');
    expect(text()).toContain('1 line');
  });

  it('switches format from the segment and dims a format that adds nothing', () => {
    drag(2, 2, 5, 27);
    render();
    expect(button('Spaces').className).toContain('opacity-50');
    act(() => button('Exact').click());
    expect(getMouseSelectionState('term-1').copyEditor?.format).toBe('exact');
    expect(text()).toContain('4 lines');
  });

  it('flips one break from its mark and marks the format edited', () => {
    drag(2, 2, 5, 27);
    render();
    act(() => button('␣').click());
    expect(getMouseSelectionState('term-1').copyEditor?.overrides).toEqual({ 0: 'none' });
    expect(button('Auto*')).toBeDefined();
  });

  it('measures its width once per scope, never for a format or a flipped mark', () => {
    drag(2, 27, 3, 5);
    render();
    const measured = vi.mocked(measureNaturalWidth).mock.calls.length;
    act(() => button('Exact').click());
    act(() => button('Auto').click());
    act(() => button('␣').click());
    expect(vi.mocked(measureNaturalWidth).mock.calls.length).toBe(measured);
    act(() => button('Whole words').click());
    expect(vi.mocked(measureNaturalWidth).mock.calls.length).toBe(measured + 1);
  });

  it('lays its chrome probe out the same in every format', () => {
    drag(2, 2, 5, 27);
    render();
    const measured = vi.mocked(measureChromeWidth).mock.calls.length;
    const laidOut = chromeProbe().textContent;
    // A `*` on one format and the widest count, Exact's four lines.
    expect(laidOut).toContain('Auto*');
    expect(laidOut).toContain('4 lines');
    expect(chromeProbe().querySelector('svg')).not.toBeNull();
    act(() => button('␣').click());
    act(() => button('Exact').click());
    act(() => button('No breaks').click());
    expect(chromeProbe().textContent).toBe(laidOut);
    expect(vi.mocked(measureChromeWidth).mock.calls.length).toBe(measured);
  });

  it('probes each format’s three longest lines, cut to what the screen could show', () => {
    const innerWidth = window.innerWidth;
    // 40px of window at the narrowest cell leaves 18 cells a line.
    Object.defineProperty(window, 'innerWidth', { value: 40, configurable: true });
    try {
      drag(7, 0, 11, 79);
      render();
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: innerWidth, configurable: true });
    }
    const probe = editor()!.querySelector('.w-max')!;
    const [, exact, , joined] = Array.from(probe.children);
    const rows = (format: Element) => Array.from(format.children, (row) => ({ n: row.firstElementChild!.textContent, text: row.lastElementChild!.textContent! }));
    // Rows 9, 7 and 10 of the reply, heaviest first.
    expect(rows(exact).map((r) => r.n)).toEqual(['3', '1', '4']);
    expect(rows(exact).every((r) => r.text.length <= 18)).toBe(true);
    expect(rows(joined)).toEqual([{ n: '1', text: 'The fix is to awai' }]);
  });

  it('expands from the scope segment and shows what it added', () => {
    drag(2, 27, 3, 5);
    render();
    act(() => button('Whole words').click());
    expect(getMouseSelectionState('term-1').copyEditor?.scope).toBe(1);
    expect(text()).toContain('expanded');
  });

  it('copies from the button', () => {
    drag(2, 2, 5, 27);
    render();
    act(() => button('Copy').click());
    expect(copySelection).toHaveBeenCalledWith('term-1', { touch: false });
  });

  it('gives touch a full-width Copy row a thumb tall, with no key hints', () => {
    drag(2, 2, 5, 27);
    render(<TouchUiContext.Provider value><CopyEditor terminalId="term-1" /></TouchUiContext.Provider>);
    expect(copyButton().className).toContain('h-11');
    expect(copyButton().className).toContain('w-full');
    // A row of its own, under the legend and the count.
    expect(copyButton().parentElement!.lastElementChild).toBe(copyButton());
    expect(copyButton().previousElementSibling!.textContent).toContain('kept');
    expect(editor()!.className).toContain('touch-manipulation');
    act(() => copyButton().click());
    expect(copySelection).toHaveBeenCalledWith('term-1', { touch: true });
  });
});

describe('CopyEditor: the program’s own copy', () => {
  it('takes the width an offer adds on the next tick', () => {
    act(() => {
      setSelection('term-1', { startRow: 2, startCol: 25, endRow: 5, endCol: 27, shape: 'linewise', dragging: false, startedInScrollback: false, owner: 'program' });
      openCopyEditor('term-1', terminal);
    });
    render();
    expect(box().width).toBe('792px');
    natural.width = 950;
    act(() => offerProgramCopy('term-1', 'the program’s own, wider copy'));
    act(() => bumpRenderTick());
    frame();
    expect(box().width).toBe('950px');
    // Its offer kept, a flipped mark changes no format's widest line.
    const measured = vi.mocked(measureNaturalWidth).mock.calls.length;
    act(() => button('␣').click());
    expect(vi.mocked(measureNaturalWidth).mock.calls.length).toBe(measured);
  });

  it('offers it last as "From <program>" and previews its text, scope set aside', () => {
    act(() => {
      setSelection('term-1', { startRow: 2, startCol: 2, endRow: 5, endCol: 27, shape: 'linewise', dragging: false, startedInScrollback: false, owner: 'program' });
      offerProgramCopy('term-1', '**The flake** comes from a race');
      openCopyEditor('term-1', terminal);
    });
    render();
    act(() => button('From program').click());
    expect(getMouseSelectionState('term-1').copyEditor?.format).toBe('program');
    expect(text()).toContain('**The flake** comes from a race');
  });
});

describe('CopyEditor: flash', () => {
  beforeEach(() => {
    drag(5, 2, 5, 12);
    render();
  });

  it('dismisses immediately when the selection is canceled during the flash', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    act(() => flashCopy('term-1'));
    act(() => setSelection('term-1', null));
    expect(editor()).toBeNull();
  });

  it.each([
    { outcome: 'copied', label: 'Copied' },
    { outcome: 'failed', label: 'Couldn’t copy' },
  ] as const)('says $label in place, every label laid out', ({ outcome, label }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const labels = () => Array.from(copyButton().querySelectorAll('span > span'), (l) => l.textContent);
    expect(shownLabel()).toBe('Copy');
    expect(labels()).toEqual(['Copy', 'Copied', 'Couldn’t copy']);
    act(() => (outcome === 'copied' ? flashCopy('term-1') : failCopy('term-1')));
    expect(shownLabel()).toBe(label);
    expect(copyButton().getAttribute('aria-label')).toBe(label);
    expect(copyButton().querySelector('span > span:not(.invisible) svg') !== null).toBe(outcome === 'copied');
    expect(labels()).toEqual(['Copy', 'Copied', 'Couldn’t copy']);
  });

  it('keeps a newer copied selection for its own confirmation duration', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    act(() => flashCopy('term-1'));
    act(() => vi.advanceTimersByTime(400));
    drag(9, 4, 9, 20);
    act(() => flashCopy('term-1'));
    act(() => vi.advanceTimersByTime(300));
    expect(getMouseSelectionState('term-1').selection?.startRow).toBe(9);
    act(() => vi.advanceTimersByTime(400));
    expect(getMouseSelectionState('term-1').selection).toBeNull();
  });
});

describe('CopyEditor: a missed tap', () => {
  // The editor opens at x 104..896, y 114..264.
  beforeEach(() => {
    drag(2, 25, 5, 27);
    render();
    editor()!.getBoundingClientRect = () => new DOMRect(104, 114, 792, 150);
  });

  /** A press at (x, y) on an element under it, and whether that element saw it. */
  function press(x: number, y: number, pointerType = 'touch'): { down: PointerEvent; reached: boolean } {
    const under = document.body.appendChild(document.createElement('div'));
    let reached = false;
    under.addEventListener('pointerdown', () => { reached = true; });
    under.addEventListener('mousedown', () => { reached = true; });
    under.addEventListener('click', () => { reached = true; });
    const down = pointerEvent('pointerdown', { clientX: x, clientY: y, pointerType });
    act(() => { under.dispatchEvent(down); });
    // The compatibility mousedown, where the engine sends one, and the click.
    act(() => { under.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y })); });
    act(() => { under.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 1 })); });
    under.remove();
    return { down, reached };
  }

  it('swallows a touch press just outside the editor, keeping it open', () => {
    // 8px under its bottom edge, and 15px off its left.
    for (const [x, y] of [[500, 272], [89, 200]]) {
      const { down, reached } = press(x, y);
      expect(down.defaultPrevented).toBe(true);
      expect(reached).toBe(false);
      expect(getMouseSelectionState('term-1').selection).not.toBeNull();
    }
    // A keyboard click (`detail` 0) between the press and its own click goes through.
    const clicked = vi.fn();
    document.body.addEventListener('click', clicked);
    act(() => { document.body.dispatchEvent(pointerEvent('pointerdown', { clientX: 500, clientY: 272 })); });
    act(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })); });
    expect(clicked).toHaveBeenCalledTimes(1);
    act(() => { document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
    expect(clicked).toHaveBeenCalledTimes(1);
    document.body.removeEventListener('click', clicked);
  });

  it('lets a touch press past the slop through, which dismisses', () => {
    const { down, reached } = press(500, 264 + TOUCH_SLOP_PX + 2);
    expect(down.defaultPrevented).toBe(false);
    expect(reached).toBe(true);
    expect(getMouseSelectionState('term-1').selection).toBeNull();
  });

  it('dismisses on a mouse press just outside, which aims', () => {
    expect(press(500, 272, 'mouse').reached).toBe(true);
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
