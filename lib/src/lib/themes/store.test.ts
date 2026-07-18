/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DormouseTheme } from './types';
import {
  addInstalledTheme,
  getAllThemes,
  getBundledThemes,
  getInstalledThemes,
} from './store';

const INSTALLED_KEY = 'dormouse:installed-themes';

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

function makeInstalledTheme(id: string): DormouseTheme {
  return {
    id,
    label: id,
    type: 'dark',
    swatch: '#000000',
    accent: '#ffffff',
    vars: {},
    origin: { kind: 'installed', extensionId: 'pub/ext', installedAt: '2026-07-17' },
  };
}

describe('theme store', () => {
  beforeEach(() => {
    installStorageStub();
  });

  it('returns [] when the installed-themes value is valid JSON but not an array', () => {
    // Corrupted or externally tampered storage: parses fine, wrong shape.
    localStorage.setItem(INSTALLED_KEY, JSON.stringify({ id: 'oops' }));

    // Regression: before the Array.isArray guard, the object was returned cast
    // as DormouseTheme[], and getAllThemes()'s spread / addInstalledTheme()'s
    // filter threw an uncaught TypeError.
    expect(getInstalledThemes()).toEqual([]);
    expect(() => getAllThemes()).not.toThrow();
    expect(getAllThemes()).toEqual(getBundledThemes());
    expect(() => addInstalledTheme(makeInstalledTheme('recover'))).not.toThrow();
    expect(getInstalledThemes().map((t) => t.id)).toEqual(['recover']);
  });

  it('returns [] for non-JSON garbage in storage', () => {
    localStorage.setItem(INSTALLED_KEY, 'not json at all');
    expect(getInstalledThemes()).toEqual([]);
  });

  it('installs a theme and dedupes by id on reinstall', () => {
    addInstalledTheme(makeInstalledTheme('a'));
    addInstalledTheme(makeInstalledTheme('b'));
    expect(getInstalledThemes().map((t) => t.id)).toEqual(['a', 'b']);

    addInstalledTheme(makeInstalledTheme('a'));
    expect(getInstalledThemes().map((t) => t.id)).toEqual(['b', 'a']);
  });
});
