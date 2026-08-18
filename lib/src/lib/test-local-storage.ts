/**
 * Install an in-memory `localStorage` for a jsdom test.
 *
 * This environment provides none — Node only exposes one behind
 * `--localstorage-file` — so anything reading it (the theme store, the alert
 * settings mirror) throws on `window.localStorage.clear()` without a stub.
 * `configurable: true` so `vi.unstubAllGlobals()` and a later re-install both
 * work across tests.
 */
export function installLocalStorageStub(): void {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    },
  });
}
