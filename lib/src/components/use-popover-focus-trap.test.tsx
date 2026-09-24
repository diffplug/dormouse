// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePopoverFocusTrap } from './use-popover-focus-trap';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it.each(['composing', 'WebKit ending'])('leaves Escape and Tab to the IME (%s)', phase => {
  const onClose = vi.fn();
  function Popover() {
    const ref = useRef<HTMLDivElement>(null);
    usePopoverFocusTrap(ref, onClose);
    return <div ref={ref}><input /><button>Action</button></div>;
  }
  act(() => root.render(<Popover />));
  const input = container.querySelector('input')!;
  input.focus();
  for (const key of ['Tab', 'Escape']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: phase === 'composing' });
    if (phase === 'WebKit ending') Object.defineProperty(event, 'keyCode', { value: 229 });
    act(() => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(onClose).not.toHaveBeenCalled();
  }
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(container.querySelector('button'));
  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(onClose).toHaveBeenCalledOnce();
});
