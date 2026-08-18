import type { DormouseTheme } from './types';
import { getStorage } from '../safe-storage';
// JSON import types are inferred too narrowly — cast at the boundary.
import _bundledThemes from './bundled.json';
const bundledThemes = _bundledThemes as unknown as DormouseTheme[];

const INSTALLED_KEY = 'dormouse:installed-themes';
const ACTIVE_KEY = 'dormouse:active-theme';

export function getBundledThemes(): DormouseTheme[] {
  return bundledThemes;
}

/**
 * Parsed installed themes, keyed by the exact JSON they came from.
 *
 * Bundled themes are a module array, so repeated `getBundledThemes()` calls
 * hand back the same objects; installed ones were re-parsed on every call and
 * so never had stable identity. `applyTheme` compares the incoming theme with
 * the applied one to skip redundant work, and that comparison silently never
 * held for an installed theme — every restore cleared and rewrote ~44 CSS
 * variables. Keying on the raw string keeps the semantics exact: reinstalling
 * an extension rewrites the JSON, so the objects are new and the re-apply
 * happens as it should.
 */
let installedCache: { raw: string; themes: DormouseTheme[] } | null = null;

export function getInstalledThemes(): DormouseTheme[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(INSTALLED_KEY);
    if (!raw) return [];
    // A fresh array over cached elements: identity matters per theme, and no
    // caller should be able to reach in and mutate the cache.
    if (installedCache?.raw === raw) return [...installedCache.themes];
    // Guard against valid-but-wrong-shaped JSON (corrupted or externally
    // tampered storage): a non-array value, or an array with malformed
    // elements, would otherwise be returned cast as DormouseTheme[], and the
    // later `.filter`/`.find`/spread callers that dereference `.id` would
    // throw an uncaught TypeError that breaks theme listing and installation.
    // Drop only the malformed entries so well-formed themes still load.
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const themes = parsed.filter(
      (t): t is DormouseTheme =>
        typeof t === 'object' && t !== null && typeof (t as { id?: unknown }).id === 'string',
    );
    installedCache = { raw, themes };
    return [...themes];
  } catch {
    return [];
  }
}

export function getAllThemes(): DormouseTheme[] {
  return [...getBundledThemes(), ...getInstalledThemes()];
}

export function getTheme(id: string): DormouseTheme | undefined {
  return getAllThemes().find((t) => t.id === id);
}

export function addInstalledTheme(theme: DormouseTheme): void {
  const storage = getStorage();
  if (!storage) return;
  const installed = getInstalledThemes().filter((t) => t.id !== theme.id);
  installed.push(theme);
  storage.setItem(INSTALLED_KEY, JSON.stringify(installed));
}

export function removeInstalledTheme(id: string): void {
  const storage = getStorage();
  if (!storage) return;
  const installed = getInstalledThemes().filter((t) => t.id !== id);
  storage.setItem(INSTALLED_KEY, JSON.stringify(installed));
}

export function getActiveThemeId(): string {
  const storage = getStorage();
  if (!storage) return getBundledThemes()[0]?.id ?? '';
  return storage.getItem(ACTIVE_KEY) ?? getBundledThemes()[0]?.id ?? '';
}

/** Returns the persisted active theme ID, or undefined if none is stored.
 *  Distinct from getActiveThemeId() which falls back to a bundled default. */
export function getStoredActiveThemeId(): string | undefined {
  const storage = getStorage();
  if (!storage) return undefined;
  return storage.getItem(ACTIVE_KEY) ?? undefined;
}

export function setActiveThemeId(id: string): void {
  const storage = getStorage();
  if (!storage) return;
  // `restoreActiveTheme` re-persists the id it just read, which is the common
  // case now that the picker remounts on every Settings-dialog open.
  if (storage.getItem(ACTIVE_KEY) === id) return;
  storage.setItem(ACTIVE_KEY, id);
}
