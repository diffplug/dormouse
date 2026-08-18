/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemePicker } from './ThemePicker';
import { installLocalStorageStub } from '../lib/test-local-storage';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  installLocalStorageStub();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('ThemePicker', () => {
  it('keeps footer actions visible within the viewport-bounded panel', () => {
    act(() => root.render(<ThemePicker variant="settings-dialog" open />));

    const menu = container.querySelector<HTMLElement>('[role="menu"]');
    const list = menu?.firstElementChild;
    const footer = Array.from(menu?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent === 'Debug current theme')
      ?.parentElement;

    expect(menu?.style.maxHeight).toBe('calc(100dvh - 24px)');
    expect(menu?.classList.contains('flex')).toBe(true);
    expect(menu?.classList.contains('flex-col')).toBe(true);
    expect(list?.classList.contains('min-h-0')).toBe(true);
    expect(list?.classList.contains('overflow-y-auto')).toBe(true);
    expect(footer?.classList.contains('shrink-0')).toBe(true);
    // A ceiling on a tall screen, not a floor: `flex-1` lets the list take the
    // slack, and the panel cap above shrinks it on a short one.
    expect(list?.classList.contains('flex-1')).toBe(true);
  });

  it('shows the active theme swatch on the collapsed trigger', () => {
    act(() => root.render(<ThemePicker variant="settings-dialog" />));

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    // The collapsed trigger has to carry the same swatch as the row it stands
    // in for, so collapsed and expanded read as one control.
    expect(trigger?.querySelector('span[class*="rounded-full"]')).not.toBeNull();
  });
});
