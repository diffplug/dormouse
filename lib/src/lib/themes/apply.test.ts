/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { applyTheme, restoreActiveTheme } from './apply';
import { getTheme } from './store';

const KIMBIE_DARK = 'vscode.theme-kimbie-dark.kimbie-dark';

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

describe('applyTheme', () => {
  beforeEach(() => {
    installStorageStub();
    document.body.removeAttribute('class');
    document.body.removeAttribute('style');
  });

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
    restoreActiveTheme(KIMBIE_DARK);
    document.body.removeAttribute('class');
    document.body.removeAttribute('style');

    restoreActiveTheme(KIMBIE_DARK);
    expect(document.body.style.getPropertyValue('--vscode-editor-background')).toBe('#221a0f');
    expect(document.body.style.getPropertyValue('--vscode-terminal-background')).toBe('#221a0f');
  });
});
