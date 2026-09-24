// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InlineEditInput } from './InlineEditInput';
import { setNativeFieldValue } from '../../lib/dom';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it.each([
  { isComposing: true, finish: 'Enter' },
  { keyCode: 229, finish: 'Enter' },
  { isComposing: true, finish: 'Escape' },
  { keyCode: 229, finish: 'Escape' },
  { isComposing: true, finish: 'blur' },
  { keyCode: 229, finish: 'blur' },
])('keeps an IME edit unsettled until $finish with %j', ({ finish, ...imeState }) => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const onParentKey = vi.fn();
  act(() => root.render(<div onKeyDown={onParentKey}>
    <InlineEditInput initialValue="draft" className="" onSubmit={onSubmit} onCancel={onCancel} blurAction="submit" />
  </div>));
  const input = container.querySelector('input')!;
  for (const key of ['Enter', 'Escape']) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...imeState });
    act(() => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(onParentKey).not.toHaveBeenCalled();
  }
  act(() => setNativeFieldValue(input, '日本'));
  if (finish !== 'blur') {
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: finish, bubbles: true })));
  }
  act(() => input.blur());
  if (finish === 'Escape') {
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  } else {
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('日本', input);
    expect(onCancel).not.toHaveBeenCalled();
  }
});
