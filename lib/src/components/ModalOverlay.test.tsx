/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModalFrame } from './design';
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
