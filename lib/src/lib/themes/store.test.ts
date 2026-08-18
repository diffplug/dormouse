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
import { installLocalStorageStub } from '../test-local-storage';

const INSTALLED_KEY = 'dormouse:installed-themes';

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
    installLocalStorageStub();
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

  it('drops malformed array elements while keeping well-formed themes', () => {
    // Corrupted or externally tampered storage: a valid array whose elements
    // are the wrong shape (null / missing id). Before the per-element guard,
    // Array.isArray passed and these reached getTheme()'s `.find(t => t.id)`
    // and addInstalledTheme()'s `.filter(t => t.id)`, throwing on `null.id`.
    localStorage.setItem(
      INSTALLED_KEY,
      JSON.stringify([null, { label: 'no id' }, makeInstalledTheme('good')]),
    );

    expect(getInstalledThemes().map((t) => t.id)).toEqual(['good']);
    expect(() => getAllThemes()).not.toThrow();
    expect(() => addInstalledTheme(makeInstalledTheme('recover'))).not.toThrow();
    expect(getInstalledThemes().map((t) => t.id)).toEqual(['good', 'recover']);
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

  // `applyTheme` skips redundant work by comparing the incoming theme with the
  // applied one. That comparison never held for installed themes while every
  // call re-parsed the JSON into fresh objects.
  it('hands back the same theme object while the stored JSON is unchanged', () => {
    addInstalledTheme(makeInstalledTheme('pub.stable'));

    const first = getInstalledThemes().find((t) => t.id === 'pub.stable');
    const second = getInstalledThemes().find((t) => t.id === 'pub.stable');

    expect(first).toBe(second);
  });

  it('hands back a new object once the stored JSON changes', () => {
    addInstalledTheme(makeInstalledTheme('pub.rewritten'));
    const before = getInstalledThemes().find((t) => t.id === 'pub.rewritten');

    // A reinstall rewrites the entry, and its colors may differ.
    addInstalledTheme({ ...makeInstalledTheme('pub.rewritten'), swatch: '#123456' });
    const after = getInstalledThemes().find((t) => t.id === 'pub.rewritten');

    expect(after).not.toBe(before);
    expect(after?.swatch).toBe('#123456');
  });

  it('never hands out the cached array itself', () => {
    addInstalledTheme(makeInstalledTheme('pub.array'));

    expect(getInstalledThemes()).not.toBe(getInstalledThemes());
  });
});
