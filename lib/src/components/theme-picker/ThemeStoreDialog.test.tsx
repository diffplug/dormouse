/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/themes', () => ({
  addInstalledTheme: vi.fn(),
  applyTheme: vi.fn(),
  fetchExtensionThemes: vi.fn(),
  getInstalledThemes: vi.fn(() => []),
  removeInstalledTheme: vi.fn(),
  restoreActiveTheme: vi.fn(),
  searchThemes: vi.fn(async () => ({ extensions: [] })),
  setActiveThemeId: vi.fn(),
}));

import { searchThemes } from '../../lib/themes';
import { ThemeStoreDialog } from './ThemeStoreDialog';

const searchThemesMock = vi.mocked(searchThemes);

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom does not implement the native <dialog> modal methods.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render(open: boolean) {
  act(() => {
    root.render(<ThemeStoreDialog open={open} onClose={() => {}} onThemesChanged={() => {}} />);
  });
}

function typeQuery(value: string) {
  const input = container.querySelector('input');
  if (!input) throw new Error('search input not rendered');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ThemeStoreDialog', () => {
  it('resets the search query when reopened after being closed', () => {
    render(true);
    typeQuery('dracula');
    expect(container.querySelector('input')?.value).toBe('dracula');

    render(false); // close — component renders null but stays mounted
    render(true); // reopen

    expect(container.querySelector('input')?.value).toBe('');
  });

  it('cancels a pending debounce when closed before it fires', () => {
    vi.useFakeTimers();
    try {
      render(true);
      typeQuery('dracula'); // schedules doSearch in 300ms

      render(false); // close within the debounce window
      act(() => {
        vi.advanceTimersByTime(300); // the cancelled timer must not fire
      });

      expect(searchThemesMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
