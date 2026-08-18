/**
 * `localStorage` if this environment actually has a working one, else `null`.
 *
 * Duck-typed rather than a `typeof window` check: the lib runs in webviews, in
 * jsdom with a stub, in SSR-ish prerender passes, and under Storybook, and some
 * of those define a `localStorage` global that is missing methods. Callers use
 * `getStorage()?.getItem(...)` and treat a missing store as "nothing persisted".
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
