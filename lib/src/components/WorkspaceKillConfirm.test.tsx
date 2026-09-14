/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceKillConfirm } from './WorkspaceKillConfirm';
import { ensureResizeObserver } from './wall/wall-test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  ensureResizeObserver();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
function key(key: string, modifiers: KeyboardEventInit = {}) {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })); });
}
function render(canConfirm?: () => boolean) {
  const confirm = vi.fn();
  const cancel = vi.fn();
  act(() => root.render(<WorkspaceKillConfirm char="q" onConfirm={confirm} onCancel={cancel} canConfirm={canConfirm} />));
  return { confirm, cancel };
}
describe('WorkspaceKillConfirm keyboard', () => {
  it('ignores repeat Cmd+Q, other modified letters, and bare modifiers', () => {
    const { confirm, cancel } = render();
    key('q', { metaKey: true });
    key('q', { ctrlKey: true });
    key('q', { altKey: true });
    for (const modifier of ['Shift', 'Meta', 'Control', 'Alt']) key(modifier);
    expect(confirm).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    key('Q', { shiftKey: true });
    expect(confirm).toHaveBeenCalledOnce();
  });
  it('cancels once on a wrong bare key', () => {
    const { confirm, cancel } = render();
    key('w');
    expect(cancel).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });
  it('cancels once on Escape despite the frame and gate sharing a capture target', () => {
    const { confirm, cancel } = render();
    key('Escape');
    expect(cancel).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });
  it('blocks a confirmation while its workspace is transferring', () => {
    const { confirm, cancel } = render(() => false);
    key('q');
    expect(confirm).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});
