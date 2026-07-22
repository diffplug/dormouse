import type { DormouseTheme } from './types';
// JSON import types are inferred too narrowly — cast at the boundary.
import _bundledThemes from './bundled.json';
const bundledThemes = _bundledThemes as unknown as DormouseTheme[];

const INSTALLED_KEY = 'dormouse:installed-themes';
const ACTIVE_KEY = 'dormouse:active-theme';

function getStorage(): Storage | null {
  const storage = globalThis.localStorage;
  if (
    typeof storage?.getItem !== 'function' ||
    typeof storage?.setItem !== 'function' ||
    typeof storage?.removeItem !== 'function'
  ) {
    return null;
  }
  return storage;
}

export function getBundledThemes(): DormouseTheme[] {
  return bundledThemes;
}

export function getInstalledThemes(): DormouseTheme[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(INSTALLED_KEY);
    if (!raw) return [];
    // Guard against valid-but-wrong-shaped JSON (corrupted or externally
    // tampered storage): a non-array value would otherwise be returned cast
    // as DormouseTheme[], and the later `.filter`/spread callers would throw
    // an uncaught TypeError that breaks theme listing and installation.
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DormouseTheme[]) : [];
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
  storage.setItem(ACTIVE_KEY, id);
}
