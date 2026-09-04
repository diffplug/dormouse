/**
 * @vitest-environment jsdom
 */
import { act, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureResizeObserver } from './wall/wall-test-utils';
import { useAnchoredMenu } from './use-anchored-menu';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Bounds = { top: number; left: number; width: number; height: number };

const domRect = ({ top, left, width, height }: Bounds): DOMRect => ({
  x: left,
  y: top,
  top,
  left,
  width,
  height,
  right: left + width,
  bottom: top + height,
  toJSON: () => ({}),
});

let container: HTMLDivElement;
let root: Root;
let triggerBounds: Bounds;
let menuBounds: Bounds;
const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

function Harness({ side = 'below' }: { side?: 'above' | 'below' }) {
  const { setTriggerEl, setMenuEl, menuStyle } = useAnchoredMenu(true, 300, { side });
  const triggerRef = useCallback((element: HTMLButtonElement | null) => {
    if (element) element.getBoundingClientRect = () => domRect(triggerBounds);
    setTriggerEl(element);
  }, [setTriggerEl]);
  const menuRef = useCallback((element: HTMLDivElement | null) => {
    if (element) element.getBoundingClientRect = () => domRect(menuBounds);
    setMenuEl(element);
  }, [setMenuEl]);

  return (
    <>
      <button ref={triggerRef}>Open</button>
      <div ref={menuRef} data-menu style={menuStyle}>Menu</div>
    </>
  );
}

beforeEach(() => {
  ensureResizeObserver();
  setViewport(1000, 800);
  triggerBounds = { top: 100, left: 100, width: 100, height: 20 };
  menuBounds = { top: 0, left: 0, width: 300, height: 300 };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setViewport(originalWidth, originalHeight);
});

describe('useAnchoredMenu', () => {
  const menu = () => container.querySelector<HTMLElement>('[data-menu]')!;

  it('flips to the roomier side instead of collapsing at the requested edge', () => {
    triggerBounds = { top: 760, left: 100, width: 100, height: 20 };
    act(() => root.render(<Harness />));

    expect(menu().style.maxHeight).toContain('744px');
    expect(menu().style.top).toBe('456px');
    expect(menu().style.visibility).toBe('');
  });

  it('recomputes viewport-dependent geometry when the trigger rect is unchanged', () => {
    act(() => root.render(<Harness />));
    expect(menu().style.maxHeight).toContain('664px');
    expect(menu().style.top).toBe('124px');

    act(() => {
      setViewport(1000, 210);
      window.dispatchEvent(new Event('resize'));
    });

    expect(menu().style.maxHeight).toContain('84px');
    expect(menu().style.top).toBe('12px');
  });
});
