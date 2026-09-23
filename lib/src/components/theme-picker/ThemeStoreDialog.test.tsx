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

import { fetchExtensionThemes, searchThemes, type OpenVSXExtension } from '../../lib/themes';
import { ThemeStoreDialog } from './ThemeStoreDialog';
import { setNativeFieldValue } from '../../lib/dom';

const searchThemesMock = vi.mocked(searchThemes);

function extension(name: string, displayName: string): OpenVSXExtension {
  return {
    namespace: 'test',
    name,
    displayName,
    description: '',
    version: '1.0.0',
    downloadCount: 1,
  };
}

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
  act(() => { setNativeFieldValue(input, value); });
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

  it('discards a search already in flight when the store closes', async () => {
    let resolveSearch!: (result: { extensions: OpenVSXExtension[] }) => void;
    searchThemesMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSearch = resolve; }),
    );

    vi.useFakeTimers();
    try {
      render(true);
      typeQuery('dracula');
      act(() => { vi.advanceTimersByTime(300); }); // the request leaves
      expect(searchThemesMock).toHaveBeenCalledTimes(1);

      render(false); // close while it is still in flight
      await act(async () => {
        resolveSearch({ extensions: [extension('dracula', 'Dracula Official')] });
      });
      render(true);

      expect(container.textContent).not.toContain('Dracula Official');
      expect(container.textContent).toContain('Search for a VS Code theme to install');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops searching when the box is emptied while a request is in flight', async () => {
    let resolveSearch!: (result: { extensions: OpenVSXExtension[] }) => void;
    searchThemesMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveSearch = resolve; }),
    );

    vi.useFakeTimers();
    try {
      render(true);
      typeQuery('dracula');
      act(() => { vi.advanceTimersByTime(300); });

      // Emptying the box supersedes the in-flight request, so nothing it
      // resolves with may show — but the spinner it turned on must still go.
      typeQuery('');
      act(() => { vi.advanceTimersByTime(300); });
      await act(async () => {
        resolveSearch({ extensions: [extension('dracula', 'Dracula Official')] });
      });

      expect(container.textContent).not.toContain('Searching...');
      expect(container.textContent).not.toContain('Dracula Official');
      expect(container.textContent).toContain('Search for a VS Code theme to install');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a failed search\'s error banner when the box is emptied', async () => {
    let rejectSearch!: (reason: Error) => void;
    searchThemesMock.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectSearch = reject; }),
    );

    vi.useFakeTimers();
    try {
      render(true);
      typeQuery('dracula');
      act(() => { vi.advanceTimersByTime(300); });
      await act(async () => {
        rejectSearch(new Error('OpenVSX is unreachable'));
      });
      expect(container.textContent).toContain('OpenVSX is unreachable');

      // An emptied box has no query for the banner to be about, and its own
      // empty state is what should be showing instead.
      typeQuery('');
      act(() => { vi.advanceTimersByTime(300); });

      expect(container.textContent).not.toContain('OpenVSX is unreachable');
      expect(container.textContent).toContain('Search for a VS Code theme to install');
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards a failed install whose rejection lands after the store closes', async () => {
    searchThemesMock.mockImplementationOnce(async () => ({
      extensions: [extension('dracula', 'Dracula Official')],
    }));
    let rejectInstall!: (reason: Error) => void;
    vi.mocked(fetchExtensionThemes).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectInstall = reject; }),
    );

    vi.useFakeTimers();
    try {
      render(true);
      typeQuery('dracula');
      await act(async () => { vi.advanceTimersByTime(300); });

      const install = [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Install');
      if (!install) throw new Error('install button not rendered');
      act(() => { install.click(); });

      render(false); // close while the install is still in flight
      await act(async () => {
        rejectInstall(new Error('Install failed: 503'));
      });
      render(true);

      expect(container.textContent).not.toContain('Install failed: 503');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a superseded search whose response arrives last', async () => {
    let resolveFirst!: (result: { extensions: OpenVSXExtension[] }) => void;
    let resolveSecond!: (result: { extensions: OpenVSXExtension[] }) => void;
    searchThemesMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    vi.useFakeTimers();
    try {
      render(true);
      typeQuery('dra');
      act(() => { vi.advanceTimersByTime(300); });
      typeQuery('nord');
      act(() => { vi.advanceTimersByTime(300); });
      expect(searchThemesMock).toHaveBeenCalledTimes(2);

      // The newer query answers first; the older one lands afterwards.
      await act(async () => {
        resolveSecond({ extensions: [extension('nord', 'Nord Theme')] });
      });
      await act(async () => {
        resolveFirst({ extensions: [extension('dracula', 'Dracula Official')] });
      });

      expect(container.textContent).toContain('Nord Theme');
      expect(container.textContent).not.toContain('Dracula Official');
    } finally {
      vi.useRealTimers();
    }
  });
});
