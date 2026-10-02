// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { cancelUiSelectAll } from '../components/wall/keyboard/cancel-ui-select-all';
import { isMacSelectAll } from './select-all';

vi.mock('./platform', () => ({ IS_MAC: true }));

function keydown(target: HTMLElement, init: KeyboardEventInit = { metaKey: true }) {
  const event = new KeyboardEvent('keydown', { key: 'a', cancelable: true, ...init });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

it('matches only Cmd+A keydowns', () => {
  const div = document.createElement('div');
  expect(isMacSelectAll(keydown(div))).toBe(true);
  expect(isMacSelectAll(keydown(div, { metaKey: true, key: 'A', shiftKey: true }))).toBe(true);
  expect(isMacSelectAll(keydown(div, { ctrlKey: true }))).toBe(false);
  expect(isMacSelectAll(keydown(div, { metaKey: true, altKey: true }))).toBe(false);
  expect(isMacSelectAll(new KeyboardEvent('keyup', { key: 'a', metaKey: true }))).toBe(false);
});

it('cancels Cmd+A on the UI, so the Edit menu never selects the page, but not in text fields', () => {
  const ui = keydown(document.createElement('div'));
  cancelUiSelectAll(ui);
  expect(ui.defaultPrevented).toBe(true);
  for (const tag of ['input', 'textarea']) {
    const field = keydown(document.createElement(tag));
    cancelUiSelectAll(field);
    expect(field.defaultPrevented).toBe(false);
  }
});
