/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODAL_LAYERS, ModalFrame, SELECTION_RING_Z_INDEX } from './design';
import { ensureResizeObserver } from './wall/wall-test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let workspace: HTMLDivElement;
beforeEach(() => {
  ensureResizeObserver();
  // Stands in for the active Workspace: its own stacking context, which the
  // body-level selection ring paints above (docs/specs/layout.md → "Selection
  // overlay").
  workspace = document.createElement('div');
  workspace.style.position = 'relative';
  workspace.style.zIndex = '10';
  document.body.append(workspace);
  root = createRoot(workspace);
});
afterEach(() => {
  act(() => root.unmount());
  workspace.remove();
});

describe('ModalOverlay', () => {
  // Both share body's stacking context, so only the value keeps a modal above
  // the ring; insertion order must not be what does it.
  it('stacks every modal layer above the selection ring', () => {
    expect(Math.min(...Object.values(MODAL_LAYERS))).toBeGreaterThan(SELECTION_RING_Z_INDEX);
  });

  it('renders into document.body, outside the stacking context that rendered it', () => {
    act(() => root.render(<ModalFrame titleId="t"><h2 id="t">Title</h2></ModalFrame>));
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(workspace.contains(dialog)).toBe(false);
    expect(dialog.parentElement!.parentElement).toBe(document.body);

    act(() => root.render(null));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});


it.each([{ isComposing: true }, { keyCode: 229 }])('leaves modal Escape and Tab to IME input with %j', imeState => {
  const onEscape = vi.fn();
  act(() => root.render(<ModalFrame titleId="title" onEscape={onEscape}>
    <h2 id="title">Title</h2><input /><button>Action</button>
  </ModalFrame>));
  const dialog = document.querySelector('[role="dialog"]')!;
  const input = dialog.querySelector('input')!;
  input.focus();
  for (const key of ['Tab', 'Escape']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...imeState });
    act(() => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(onEscape).not.toHaveBeenCalled();
  }
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(dialog.querySelector('button'));
  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(onEscape).toHaveBeenCalledOnce();
});
