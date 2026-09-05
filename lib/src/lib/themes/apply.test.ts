/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  restoreActiveTheme,
  setDefaultThemeId,
  subscribeToActiveTheme,
} from './apply';

import {
  addInstalledTheme,
  getActiveThemeId,
  getBundledThemes,
  getTheme,
  removeInstalledTheme,
  setActiveThemeId,
} from './store';
import type { DormouseTheme } from './types';
import { installLocalStorageStub } from '../test-local-storage';

const KIMBIE_DARK = 'vscode.theme-kimbie-dark.kimbie-dark';

const INSTALLED_THEME: DormouseTheme = {
  id: 'store.installed-theme',
  label: 'Store Installed',
  type: 'dark',
  swatch: '#111111',
  accent: '#eeeeee',
  vars: {},
  origin: {
    kind: 'installed',
    extensionId: 'store/installed-theme',
    installedAt: '2026-08-18T00:00:00.000Z',
  },
};

describe('applyTheme', () => {
  beforeEach(() => {
    installLocalStorageStub();
    // Module state, so it outlives the test that set it.
    setDefaultThemeId(null);
    document.body.removeAttribute('class');
    document.body.removeAttribute('style');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['access', 'read', 'write'] as const)(
    'restores the host default when theme storage fails on %s',
    (failure) => {
      const error = new DOMException('Storage unavailable',
        failure === 'write' ? 'QuotaExceededError' : 'SecurityError');
      const fail = () => { throw error; };
      if (failure === 'access') {
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: fail });
      } else {
        vi.spyOn(localStorage, failure === 'read' ? 'getItem' : 'setItem').mockImplementation(fail);
      }
      setDefaultThemeId(KIMBIE_DARK);

      expect(restoreActiveTheme()?.id).toBe(KIMBIE_DARK);
      expect(document.body.style.getPropertyValue('--vscode-editor-background')).toBe('#221a0f');
      expect(document.body.classList.contains('vscode-dark')).toBe(true);
      expect(getActiveThemeId()).toBe(getBundledThemes()[0]?.id);
    },
  );

  it('reapplies the same theme when document hydration removes body styles', () => {
    const theme = getTheme(KIMBIE_DARK);
    expect(theme).toBeDefined();

    applyTheme(theme!);
    expect(document.body.style.getPropertyValue('--vscode-editor-background')).toBe('#221a0f');
    expect(document.body.style.getPropertyValue('--vscode-terminal-background')).toBe('#221a0f');
    expect(document.body.classList.contains('vscode-dark')).toBe(true);

    document.body.removeAttribute('class');
    document.body.removeAttribute('style');

    applyTheme(theme!);
    expect(document.body.style.getPropertyValue('--vscode-editor-background')).toBe('#221a0f');
    expect(document.body.style.getPropertyValue('--vscode-terminal-background')).toBe('#221a0f');
    expect(document.body.classList.contains('vscode-dark')).toBe(true);
  });

  it('restores the default theme after hydration strips the first render pass', () => {
    setDefaultThemeId(KIMBIE_DARK);
    restoreActiveTheme();
    document.body.removeAttribute('class');
    document.body.removeAttribute('style');

    restoreActiveTheme();
    expect(document.body.style.getPropertyValue('--vscode-editor-background')).toBe('#221a0f');
    expect(document.body.style.getPropertyValue('--vscode-terminal-background')).toBe('#221a0f');
  });

  // The gap this default closed: the picker's uninstall and the store dialog's
  // Remove both re-resolve the active theme, from different depths. When the
  // fallback was a prop the picker held, Remove reached `restoreActiveTheme()`
  // without it and dropped to the first bundled theme instead of the host's.
  // Both call it bare now, so there is one answer.
  it('falls back to the host default once the active theme stops resolving', () => {
    setDefaultThemeId(KIMBIE_DARK);
    addInstalledTheme(INSTALLED_THEME);
    setActiveThemeId(INSTALLED_THEME.id);

    removeInstalledTheme(INSTALLED_THEME.id);

    expect(restoreActiveTheme()?.id).toBe(KIMBIE_DARK);
  });

  it('falls back to the first bundled theme when no host declared a default', () => {
    addInstalledTheme(INSTALLED_THEME);
    setActiveThemeId(INSTALLED_THEME.id);

    removeInstalledTheme(INSTALLED_THEME.id);

    expect(restoreActiveTheme()?.id).toBe(getBundledThemes()[0]?.id);
  });

  // `getInstalledThemes()` re-parses its JSON on every call, so an installed
  // theme is a *different object* each time even though it is the same theme.
  // An identity check here reported every restore as a fresh user choice.
  it('does not notify when an already-active installed theme is re-restored', () => {
    addInstalledTheme(INSTALLED_THEME);
    setActiveThemeId(INSTALLED_THEME.id);
    restoreActiveTheme();

    const listener = vi.fn();
    const unsubscribe = subscribeToActiveTheme(listener);
    restoreActiveTheme();
    restoreActiveTheme();
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies once when the active theme actually changes', () => {
    addInstalledTheme(INSTALLED_THEME);
    setActiveThemeId(INSTALLED_THEME.id);
    restoreActiveTheme();

    const listener = vi.fn();
    const unsubscribe = subscribeToActiveTheme(listener);
    const kimbie = getTheme(KIMBIE_DARK);
    if (kimbie) applyTheme(kimbie);
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
