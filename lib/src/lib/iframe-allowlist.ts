import { loadJson, saveJson } from './local-json-store';

/**
 * The exact origins the user allowed the iframe renderer to preview off this
 * machine (docs/specs/dor-browser.md → "Iframe External Origins"). One list per
 * host install: every window shares the origin, so `localStorage` holds it and
 * its `storage` event tells the other windows when one changes it. Listed, each
 * removable, in Settings.
 */

const KEY = 'dormouse:iframe-allowed-origins';

/** An entry is an exact origin — scheme, host, and port, nothing else. */
export function iframeOriginOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

const isOrigin = (value: unknown): value is string => typeof value === 'string' && iframeOriginOf(value) === value;
const isOriginList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isOrigin);

const listeners = new Set<() => void>();
let origins: readonly string[] = loadJson(KEY, [], isOriginList);

function publish(next: readonly string[]): void {
  origins = next;
  for (const listener of listeners) listener();
}

export function getIframeAllowlist(): readonly string[] {
  return origins;
}

export function isIframeOriginAllowed(origin: string | null): boolean {
  return origin !== null && origins.includes(origin);
}

export function allowIframeOrigin(origin: string): void {
  if (!isOrigin(origin) || origins.includes(origin)) return;
  const next = [...origins, origin];
  saveJson(KEY, next);
  publish(next);
}

export function removeIframeOrigin(origin: string): void {
  if (!origins.includes(origin)) return;
  const next = origins.filter((entry) => entry !== origin);
  saveJson(KEY, next);
  publish(next);
}

export function subscribeToIframeAllowlist(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Another window changed it.
globalThis.addEventListener?.('storage', (event: StorageEvent) => {
  if (event.key !== KEY) return;
  publish(loadJson(KEY, [], isOriginList));
});

/** @internal */
export function _resetIframeAllowlistForTesting(): void {
  origins = [];
}
