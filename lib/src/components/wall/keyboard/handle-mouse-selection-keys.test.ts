/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { handleMouseSelectionKeys } from './handle-mouse-selection-keys';
import type { WallKeyboardCtx } from './types';

vi.mock('../../../lib/clipboard', () => ({
  copyRaw: vi.fn(),
  copyRewrapped: vi.fn(),
  doPaste: vi.fn(),
}));
vi.mock('../../../lib/platform', () => ({ IS_MAC: true }));

function makeCtx(): WallKeyboardCtx {
  return {
    selectedIdRef: { current: 'pane-a' },
    // Surface-type lookup now flows through the engine-neutral `nav` seam; an
    // absent params reads as a terminal.
    nav: { paneParams: () => undefined, findInDirection: () => null, hasPane: () => false, panes: () => [] },
  } as unknown as WallKeyboardCtx;
}

function fakeEvent(target: HTMLElement, init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, 'target', { value: target });
  return e;
}

describe('handleMouseSelectionKeys', () => {
  it('does not intercept Cmd+V on a non-xterm textarea', async () => {
    const { doPaste } = await import('../../../lib/clipboard');
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

});
