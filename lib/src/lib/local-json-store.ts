/**
 * The load/save dance for a single JSON blob kept in `localStorage`. Several
 * stores (the ACL, the enrollment credentials, the selected shell) persist one
 * value under one key with identical failure semantics:
 *
 *   - absent `localStorage` (SSR / no-storage host / test context) must not
 *     throw — reads yield the fallback, writes are silently dropped;
 *   - a missing key, malformed JSON, or a value that fails validation all
 *     collapse to the caller's fallback rather than propagating;
 *   - a failed write (no storage, quota exceeded) is swallowed so the
 *     in-memory value keeps working for the session.
 *
 * Each caller supplies its own key, fallback, and (optionally) a type guard, so
 * the fallback and validation stay caller-specific while the boilerplate lives
 * here once.
 */

/**
 * `localStorage` if this environment actually has a working one, else `null`.
 *
 * Duck-typed rather than a `typeof window` check: the lib runs in webviews, in
 * jsdom with a stub, in SSR-ish prerender passes, and under Storybook, and some
 * of those define a `localStorage` global that is missing methods. Exported for
 * the stores that need the raw handle (`themes/store.ts` keeps its own string
 * cache; `shell-store.ts` removes a key); everything else should go through
 * `loadJson`/`saveJson`, which route through this and add the try/catch — the
 * property access itself can throw where storage is blocked by policy.
 */
export function getStorage(): Storage | null {
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

/**
 * Read and JSON-parse the value at `key`, returning `fallback` if storage is
 * unavailable, the key is missing, the JSON is malformed, or `validate` (when
 * given) rejects the parsed value.
 */
export function loadJson<V, F = V>(
  key: string,
  fallback: F,
  validate?: (value: unknown) => value is V,
): V | F {
  try {
    const raw = getStorage()?.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (validate && !validate(parsed)) return fallback;
    return parsed as V;
  } catch {
    return fallback;
  }
}

/**
 * JSON-stringify `value` and write it to `key`, swallowing any failure (absent
 * storage, quota exceeded) so callers keep their in-memory value.
 */
export function saveJson(key: string, value: unknown): void {
  try {
    getStorage()?.setItem(key, JSON.stringify(value));
  } catch {
    // No localStorage / quota exceeded: the in-memory value still works.
  }
}
