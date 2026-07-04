/**
 * The load/save dance for a single JSON blob kept in `localStorage`. Several
 * host-side stores (the ACL, the enrollment credentials) persist one value
 * under one key with identical failure semantics:
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
    const raw = globalThis.localStorage?.getItem(key);
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
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // No localStorage / quota exceeded: the in-memory value still works.
  }
}
