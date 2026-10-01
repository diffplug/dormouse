/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMouseSelectionKeys } from './handle-mouse-selection-keys';
import type { WallKeyboardCtx } from './types';

vi.mock('../../../lib/clipboard', () => ({
  doPaste: vi.fn(),
}));
vi.mock('../../../lib/copy-selection', () => ({
  copySelection: vi.fn(),
  nudgeSelection: vi.fn(),
}));
vi.mock('../../../lib/copy-editor', () => ({
  cycleCopyFormat: vi.fn(),
  stepCopyScope: vi.fn(),
}));
vi.mock('../../../lib/platform', () => ({ IS_MAC: true }));
// The real mouse-selection store keeps per-id module state; mock it so each
// test can drive the drag/selection shape the handler reads.
vi.mock('../../../lib/mouse-selection', () => ({
  getMouseSelectionState: vi.fn(() => ({ selection: null })),
  extendSelectionToToken: vi.fn(),
  setSelection: vi.fn(),
}));
function makeCtx(params?: Record<string, unknown>): WallKeyboardCtx {
  return {
    selectedIdRef: { current: 'pane-a' },
    selectedTypeRef: { current: 'pane' },
    // Surface-type lookup now flows through the engine-neutral `nav` seam; an
    // absent params reads as a terminal.
    nav: {
      paneParams: () => params,
      findInDirection: () => null,
      hasPane: () => false,
      panes: () => [],
    },
  } as unknown as WallKeyboardCtx;
}

function fakeEvent(target: HTMLElement, init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, 'target', { value: target });
  return e;
}

describe('handleMouseSelectionKeys', () => {
  beforeEach(async () => {
    const { getMouseSelectionState } = await import('../../../lib/mouse-selection');
    // Reset to the no-selection default; individual tests override as needed.
    vi.mocked(getMouseSelectionState).mockReturnValue({ selection: null } as never);
  });

  it('does not intercept Cmd+V on a non-xterm textarea', async () => {
    const { doPaste } = await import('../../../lib/clipboard');
    vi.mocked(doPaste).mockClear();
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    const e = fakeEvent(ta, { key: 'v', metaKey: true });

    const handled = handleMouseSelectionKeys(e, makeCtx());

    expect(handled).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(doPaste).not.toHaveBeenCalled();
  });

  it('still intercepts Cmd+V on the xterm helper textarea', async () => {
    const { doPaste } = await import('../../../lib/clipboard');
    vi.mocked(doPaste).mockClear();
    const ta = document.createElement('textarea');
    ta.classList.add('xterm-helper-textarea');
    document.body.appendChild(ta);
    const e = fakeEvent(ta, { key: 'v', metaKey: true });

    const handled = handleMouseSelectionKeys(e, makeCtx());

    expect(handled).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(doPaste).toHaveBeenCalledWith('pane-a');
  });

  it('yields clipboard keys on a non-terminal (agent-browser) surface', async () => {
    const { doPaste } = await import('../../../lib/clipboard');
    vi.mocked(doPaste).mockClear();
    const e = fakeEvent(document.createElement('div'), { key: 'v', metaKey: true });

    const handled = handleMouseSelectionKeys(e, makeCtx({ surfaceType: 'browser' }));

    expect(handled).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(doPaste).not.toHaveBeenCalled();
  });

  it('routes clipboard keys only when a tool has its terminal forward', async () => {
    const { doPaste } = await import('../../../lib/clipboard');
    vi.mocked(doPaste).mockClear();
    const terminal = { surfaceType: 'tool', command: 'pnpm storybook' };
    const browser = { ...terminal, url: 'http://localhost:6006/', renderMode: 'iframe' };

    const terminalEvent = fakeEvent(document.createElement('div'), { key: 'v', metaKey: true });
    expect(handleMouseSelectionKeys(terminalEvent, makeCtx(terminal))).toBe(true);
    expect(doPaste).toHaveBeenCalledWith('pane-a');

    vi.mocked(doPaste).mockClear();
    const browserEvent = fakeEvent(document.createElement('div'), { key: 'v', metaKey: true });
    expect(handleMouseSelectionKeys(browserEvent, makeCtx(browser))).toBe(false);
    expect(doPaste).not.toHaveBeenCalled();

    const contextTerminal = document.createElement('div');
    contextTerminal.dataset.contextTerminal = 'pane-a';
    const pinnedEvent = fakeEvent(contextTerminal, { key: 'v', metaKey: true });
    expect(handleMouseSelectionKeys(pinnedEvent, makeCtx(browser))).toBe(true);
    expect(doPaste).toHaveBeenCalledWith('pane-a');
  });

  it('extends the selection to the hint token on "e" during a drag', async () => {
    const { getMouseSelectionState, extendSelectionToToken } = await import('../../../lib/mouse-selection');
    const hintToken = { start: 0, end: 4 };
    vi.mocked(getMouseSelectionState).mockReturnValue({ selection: { dragging: true }, hintToken } as never);
    const e = fakeEvent(document.createElement('div'), { key: 'e' });

    const handled = handleMouseSelectionKeys(e, makeCtx());

    expect(handled).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(extendSelectionToToken).toHaveBeenCalledWith('pane-a', hintToken);
  });

  it('clears the selection on Escape during a drag', async () => {
    const { getMouseSelectionState, setSelection } = await import('../../../lib/mouse-selection');
    vi.mocked(getMouseSelectionState).mockReturnValue({ selection: { dragging: true } } as never);
    const e = fakeEvent(document.createElement('div'), { key: 'Escape' });

    const handled = handleMouseSelectionKeys(e, makeCtx());

    expect(handled).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(setSelection).toHaveBeenCalledWith('pane-a', null);
  });

  it('swallows non-Alt keys during a drag but lets Alt reach the OS', async () => {
    const { getMouseSelectionState } = await import('../../../lib/mouse-selection');
    vi.mocked(getMouseSelectionState).mockReturnValue({ selection: { dragging: true } } as never);
    const ctx = makeCtx();

    const swallowed = fakeEvent(document.createElement('div'), { key: 'x' });
    expect(handleMouseSelectionKeys(swallowed, ctx)).toBe(true);
    expect(swallowed.defaultPrevented).toBe(true);

    const alt = fakeEvent(document.createElement('div'), { key: 'Alt' });
    expect(handleMouseSelectionKeys(alt, ctx)).toBe(true);
    expect(alt.defaultPrevented).toBe(false);
  });

  describe('with the copy editor open', () => {
    const open = async () => {
      const { getMouseSelectionState, setSelection } = await import('../../../lib/mouse-selection');
      const { copySelection, nudgeSelection } = await import('../../../lib/copy-selection');
      const { cycleCopyFormat, stepCopyScope } = await import('../../../lib/copy-editor');
      for (const fn of [setSelection, copySelection, nudgeSelection, cycleCopyFormat, stepCopyScope]) vi.mocked(fn).mockClear();
      vi.mocked(getMouseSelectionState).mockReturnValue({ selection: { dragging: false }, copyEditor: {} } as never);
      return { setSelection, copySelection, nudgeSelection, cycleCopyFormat, stepCopyScope };
    };
    const press = (init: Partial<KeyboardEventInit> & { key: string }) => {
      const e = fakeEvent(document.createElement('div'), init);
      return { e, handled: handleMouseSelectionKeys(e, makeCtx()) };
    };

    it('copies on the copy chord, with or without Shift, and on Enter', async () => {
      const { copySelection } = await open();
      for (const init of [{ key: 'c', metaKey: true }, { key: 'C', metaKey: true, shiftKey: true }, { key: 'Enter' }]) {
        const { e, handled } = press(init);
        expect(handled).toBe(true);
        expect(e.defaultPrevented).toBe(true);
      }
      expect(copySelection).toHaveBeenCalledTimes(3);
      expect(copySelection).toHaveBeenCalledWith('pane-a');
    });

    it('expands and shrinks on e / Shift+E, cycles formats on f / Shift+F', async () => {
      const { stepCopyScope, cycleCopyFormat } = await open();
      press({ key: 'e' });
      press({ key: 'E', shiftKey: true });
      press({ key: 'f' });
      press({ key: 'F', shiftKey: true });
      expect(vi.mocked(stepCopyScope).mock.calls).toEqual([['pane-a', 1], ['pane-a', -1]]);
      expect(vi.mocked(cycleCopyFormat).mock.calls).toEqual([['pane-a', 1], ['pane-a', -1]]);
    });

    it('nudges the end on arrows and the start on Shift+arrows', async () => {
      const { nudgeSelection } = await open();
      press({ key: 'ArrowRight' });
      press({ key: 'ArrowLeft', shiftKey: true });
      expect(vi.mocked(nudgeSelection).mock.calls).toEqual([['pane-a', 'end', 1], ['pane-a', 'start', -1]]);
    });

    it('closes on Escape, consuming it', async () => {
      const { setSelection } = await open();
      const { e, handled } = press({ key: 'Escape' });
      expect(handled).toBe(true);
      expect(e.defaultPrevented).toBe(true);
      expect(setSelection).toHaveBeenCalledWith('pane-a', null);
    });

    it('closes on any other key and lets it reach the terminal', async () => {
      const { setSelection, copySelection } = await open();
      const { e, handled } = press({ key: 'g' });
      expect(handled).toBe(false);
      expect(e.defaultPrevented).toBe(false);
      expect(setSelection).toHaveBeenCalledWith('pane-a', null);
      expect(copySelection).not.toHaveBeenCalled();
    });

    it('stays open for a bare modifier; a modified e is no editor key', async () => {
      const { setSelection, stepCopyScope } = await open();
      expect(press({ key: 'Shift', shiftKey: true }).handled).toBe(false);
      expect(press({ key: 'e', metaKey: true }).handled).toBe(false);
      expect(stepCopyScope).not.toHaveBeenCalled();
      expect(vi.mocked(setSelection).mock.calls).toEqual([['pane-a', null]]);
    });
  });
});
