/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMouseSelectionKeys } from './handle-mouse-selection-keys';
import type { WallKeyboardCtx } from './types';

vi.mock('../../../lib/clipboard', () => ({
  copyRaw: vi.fn(),
  copyRewrapped: vi.fn(),
  doPaste: vi.fn(),
}));
vi.mock('../../../lib/platform', () => ({ IS_MAC: true }));
// The real mouse-selection store keeps per-id module state; mock it so each
// test can drive the drag/selection shape the handler reads.
vi.mock('../../../lib/mouse-selection', () => ({
  getMouseSelectionState: vi.fn(() => ({ selection: null })),
  extendSelectionToToken: vi.fn(),
  flashCopy: vi.fn(),
  setSelection: vi.fn(),
}));

function makeCtx(overrides: { surfaceType?: string } = {}): WallKeyboardCtx {
  return {
    selectedIdRef: { current: 'pane-a' },
    // Surface-type lookup now flows through the engine-neutral `nav` seam; an
    // absent params reads as a terminal.
    nav: {
      paneParams: () => (overrides.surfaceType ? { surfaceType: overrides.surfaceType } : undefined),
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

    const handled = handleMouseSelectionKeys(e, makeCtx({ surfaceType: 'agent-browser' }));

    expect(handled).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(doPaste).not.toHaveBeenCalled();
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

  it('copies raw on Cmd+C and rewrapped on Cmd+Shift+C outside a drag', async () => {
    const { copyRaw, copyRewrapped } = await import('../../../lib/clipboard');
    const { getMouseSelectionState, flashCopy } = await import('../../../lib/mouse-selection');
    vi.mocked(copyRaw).mockClear().mockResolvedValue(undefined as never);
    vi.mocked(copyRewrapped).mockClear().mockResolvedValue(undefined as never);
    vi.mocked(flashCopy).mockClear();
    vi.mocked(getMouseSelectionState).mockReturnValue({ selection: { dragging: false } } as never);

    const rawEvt = fakeEvent(document.createElement('div'), { key: 'c', metaKey: true });
    expect(handleMouseSelectionKeys(rawEvt, makeCtx())).toBe(true);
    expect(rawEvt.defaultPrevented).toBe(true);
    expect(copyRaw).toHaveBeenCalledWith('pane-a');
    expect(copyRewrapped).not.toHaveBeenCalled();

    const rewrapEvt = fakeEvent(document.createElement('div'), { key: 'c', metaKey: true, shiftKey: true });
    expect(handleMouseSelectionKeys(rewrapEvt, makeCtx())).toBe(true);
    expect(copyRewrapped).toHaveBeenCalledWith('pane-a');

    // flashCopy fires from the copy promise's continuation.
    await Promise.resolve();
    await Promise.resolve();
    expect(flashCopy).toHaveBeenCalledWith('pane-a', 'raw');
    expect(flashCopy).toHaveBeenCalledWith('pane-a', 'rewrapped');
  });
});
