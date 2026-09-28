// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IS_MAC } from '../../../lib/platform';
import { handleContextCopy } from './handle-context-copy';

let diagnostic: HTMLDivElement;
let write: ReturnType<typeof vi.fn>;
beforeEach(() => {
  diagnostic = document.createElement('div');
  diagnostic.dataset.contextDiagnostic = '';
  diagnostic.tabIndex = -1;
  diagnostic.textContent = "agent-browser binary not found ('agent-browser' was not found)";
  document.body.append(diagnostic);
  diagnostic.focus();
  write = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText: write } });
});
afterEach(() => { window.getSelection()?.removeAllRanges(); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function select(start = 0, end = diagnostic.textContent!.length) {
  const range = document.createRange();
  range.setStart(diagnostic.firstChild!, start);
  range.setEnd(diagnostic.firstChild!, end);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}
function copy(target: HTMLElement = diagnostic) {
  const event = new KeyboardEvent('keydown', { key: 'c', metaKey: IS_MAC, ctrlKey: !IS_MAC, cancelable: true });
  Object.defineProperty(event, 'target', { value: target });
  return { event, handled: handleContextCopy(event) };
}
it('copies exactly the selected diagnostic substring without clearing it', () => {
  select(0, 13);
  const { event, handled } = copy();
  expect(handled).toBe(true);
  expect(event.defaultPrevented).toBe(true);
  expect(write).toHaveBeenCalledExactlyOnceWith('agent-browser');
  expect(window.getSelection()!.toString()).toBe('agent-browser');
});
it('leaves collapsed and unrelated selections alone', () => {
  select(0, 0);
  expect(copy().handled).toBe(false);
  select();
  const helper = document.createElement('textarea');
  document.body.append(helper);
  helper.focus();
  expect(copy(helper).handled).toBe(false);
  expect(write).not.toHaveBeenCalled();
});
it('retains selection after clipboard rejection for another attempt', async () => {
  write.mockRejectedValue(new Error('Clipboard unavailable'));
  select();
  copy();
  await Promise.resolve();
  expect(window.getSelection()!.toString()).toBe(diagnostic.textContent);
});
