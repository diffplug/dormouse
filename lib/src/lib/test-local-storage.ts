import { vi } from 'vitest';

/**
 * Install an in-memory `localStorage` for a jsdom test.
 *
 * jsdom implements `localStorage`, but it does not survive into this
 * environment: Node 24 defines its own `localStorage` global, unavailable
 * without `--localstorage-file`, and it shadows jsdom's — so `window.localStorage`
 * reads back `undefined` and anything touching it throws. (`Baseboard.test.tsx`
 * failed exactly this way before this helper existed.)
 *
 * Uses `vi.stubGlobal` rather than `Object.defineProperty` so the stub is
 * restore-tracked: a test's `vi.unstubAllGlobals()` puts the environment back,
 * and it matches how the rest of the lib's tests stub this global
 * (`local-json-store.test.ts`, `feature-flags.test.ts`, `alert-settings.test.ts`,
 * `window-persistence.test.ts`, `remote/host/{acl,enrollment}.test.ts`).
 */
export function installLocalStorageStub(): void {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  });
}
