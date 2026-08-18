/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemePicker } from './ThemePicker';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function installStorageStub(): void {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  installStorageStub();
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

    expect(menu?.style.maxHeight).toBe('calc(100vh - 24px)');
    expect(menu?.classList.contains('flex')).toBe(true);
    expect(menu?.classList.contains('flex-col')).toBe(true);
    expect(list?.classList.contains('min-h-0')).toBe(true);
    expect(list?.classList.contains('overflow-y-auto')).toBe(true);
    expect(footer?.classList.contains('shrink-0')).toBe(true);
  });
});
