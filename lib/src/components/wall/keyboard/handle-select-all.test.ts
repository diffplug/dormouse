// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cancelUiSelectAll } from './handle-select-all';

vi.mock('../../../lib/platform', () => ({ IS_MAC: true }));

afterEach(() => { document.body.replaceChildren(); });
function dispatch(target: HTMLElement, init: KeyboardEventInit = { metaKey: true }) {
  document.body.append(target);
  const event = new KeyboardEvent('keydown', { key: 'a', cancelable: true, ...init });
  Object.defineProperty(event, 'target', { value: target });
  const stop = vi.spyOn(event, 'stopPropagation');
  cancelUiSelectAll(event);
  return { cancelled: event.defaultPrevented, stopped: stop.mock.calls.length > 0 };
}
const selectAll = (target: HTMLElement, init?: KeyboardEventInit) => dispatch(target, init).cancelled;
function xtermInput() {
  const el = document.createElement('textarea');
  el.className = 'xterm-helper-textarea';
  return el;
}

it('cancels Cmd+A on the UI and in the terminal, so the menu never selects the page', () => {
  expect(dispatch(document.createElement('div'))).toEqual({ cancelled: true, stopped: false });
});

it('keeps Cmd+A from xterm.js, whose own select-all would highlight the buffer', () => {
  expect(dispatch(xtermInput())).toEqual({ cancelled: true, stopped: true });
});

it('leaves Cmd+A to our text fields and other chords alone', () => {
  expect(selectAll(document.createElement('input'))).toBe(false);
  expect(selectAll(document.createElement('textarea'))).toBe(false);
  expect(selectAll(document.createElement('div'), { ctrlKey: true })).toBe(false);
  expect(selectAll(document.createElement('div'), { metaKey: true, altKey: true })).toBe(false);
});
