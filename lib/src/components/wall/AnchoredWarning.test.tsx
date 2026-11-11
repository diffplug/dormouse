/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnchoredWarning } from './AnchoredWarning';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setViewport(1000, 800);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setViewport(originalWidth, originalHeight);
  vi.restoreAllMocks();
});

describe('AnchoredWarning', () => {
  it('stays the shared overlay margin inside the viewport when its anchor sits near the bottom-right corner', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 40));
    const anchorRect = new DOMRect(980, 770, 10, 20);
    act(() => root.render(<AnchoredWarning anchorRect={anchorRect} title="Refused" message="Not here" onClose={() => {}} />));

    const warning = document.body.querySelector<HTMLElement>('[role="alert"]')!;
    // 12px (`OVERLAY_VIEWPORT_MARGIN_PX`) inside the right and bottom edges.
    expect(warning.style.left).toBe('788px');
    expect(warning.style.top).toBe('748px');
  });
});
