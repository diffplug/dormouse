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
 *
 * `localStorage` is the default backend, but a host whose storage lives
 * elsewhere can claim a key prefix with {@link setJsonStoreBackend} — the VS
 * Code webview routes `dormouse.remote-host.*` to the extension host, whose
 * `SecretStorage` holds the Host's bearer credential (docs/specs/vscode.md).
 * The claim is per-prefix rather than global so unrelated stores (alert
 * settings, watched commands) keep their own backend.
 */

/** The minimal `localStorage` surface these helpers use. */
export interface JsonStoreBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Prefix claims, longest-first so a more specific prefix wins. */
const backends: Array<{ prefix: string; backend: JsonStoreBackend }> = [];

/**
 * Route every key starting with `prefix` to `backend`. Pass `null` to release
 * the claim. Backends must be synchronous: callers read at module init and on
 * every access, so an async store has to be hydrated into memory first.
 */
export function setJsonStoreBackend(prefix: string, backend: JsonStoreBackend | null): void {
  const at = backends.findIndex((entry) => entry.prefix === prefix);
  if (at !== -1) backends.splice(at, 1);
  if (backend) {
    backends.push({ prefix, backend });
    backends.sort((a, b) => b.prefix.length - a.prefix.length);
  }
}

function backendFor(key: string): JsonStoreBackend | undefined {
  for (const entry of backends) {
    if (key.startsWith(entry.prefix)) return entry.backend;
  }
  return globalThis.localStorage as JsonStoreBackend | undefined;
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
    const raw = backendFor(key)?.getItem(key);
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
    backendFor(key)?.setItem(key, JSON.stringify(value));
  } catch {
    // No localStorage / quota exceeded: the in-memory value still works.
  }
}

/**
 * Delete the value at `key`, swallowing any failure. Callers must go through
 * this rather than touching `localStorage` directly, or a claimed prefix would
 * clear the wrong store.
 */
export function removeJson(key: string): void {
  try {
    backendFor(key)?.removeItem(key);
  } catch {
    // No storage: nothing to clear.
  }
}
