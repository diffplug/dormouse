/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stepCopyScope } from '../../lib/copy-editor';
import { useWallKeyboard } from './use-wall-keyboard';
import { portalAnchoredButton } from './wall-test-utils';
import type { WallKeyboardCtx } from './keyboard/types';

vi.mock('../../lib/copy-editor', () => ({
  cycleCopyFormat: vi.fn(),
  nudgeCopyEdge: vi.fn(),
  openCopyEditor: vi.fn(),
  stepCopyScope: vi.fn(),
}));
// Every terminal has an open copy editor.
vi.mock('../../lib/mouse-selection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/mouse-selection')>(),
  getMouseSelectionState: () => ({ selection: { dragging: false }, copyEditor: {} }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ctx = {
  activeRef: { current: true },
  modeRef: { current: 'passthrough' },
  selectedIdRef: { current: 'source' },
  selectedTypeRef: { current: 'pane' },
  nav: { paneParams: () => undefined, findInDirection: () => null, hasPane: () => false, panes: () => [] },
} as unknown as WallKeyboardCtx;

function Harness() {
  useWallKeyboard(ctx);
  return null;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

it('routes a copy editor key from a helper\'s portaled editor to the helper', () => {
  const context = document.createElement('section');
  context.dataset.terminalContext = '';
  const helper = document.createElement('div');
  helper.dataset.helperTerminal = 'helper-1';
  context.append(helper);
  document.body.append(context);
  const button = portalAnchoredButton(helper);
  button.focus();
  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true }));
  expect(vi.mocked(stepCopyScope).mock.calls).toEqual([['helper-1', 1]]);
});
