/**
 * The one key prefix every Host-side persisted value lives under
 * (`enrollment.ts` → `ENROLLMENT_KEY`, `acl.ts` → `ACL_KEY_PREFIX`).
 *
 * It exists so a host can move the whole Host store somewhere other than
 * `localStorage` in one claim: the VS Code webview hands this prefix to
 * `PlatformAdapter.hydrateScopedStore`, and the extension host backs it with
 * `SecretStorage` (the enrollment blob carries `hostToken`, a bearer
 * credential) plus `globalState` for the ACL. Both sides validate against this
 * prefix, so a webview can never reach unrelated extension storage.
 */
export const REMOTE_HOST_STORE_PREFIX = 'dormouse.remote-host.';

/**
 * The enrollment blob's key. It lives here rather than in `enrollment.ts` so
 * the extension host can import it without pulling `server-lib-common` into the
 * extension bundle; `enrollment.ts` re-exports it for its own callers.
 */
export const ENROLLMENT_KEY = `${REMOTE_HOST_STORE_PREFIX}enrollment`;

/**
 * Resolves once the Host store is readable — see
 * `PlatformAdapter.hydrateScopedStore`.
 *
 * The webview entry starts hydration at boot but must not gate first paint on
 * it: the read waits on an OS keychain, which can take seconds, and a blank
 * terminal for that long reads as a hang. The real ordering constraint is
 * narrower — hydrated before anything reads a `dormouse.remote-host.` key,
 * which happens when `installRemoteHostConsoleHook` runs, downstream of render.
 * So the entry publishes the promise here and the lazily-mounted Host awaits
 * it. Hosts that never hydrate leave the resolved default in place.
 */
let ready: Promise<unknown> = Promise.resolve();

export function setHostStoreReady(promise: Promise<unknown> | undefined): void {
  ready = promise ?? Promise.resolve();
}

export function hostStoreReady(): Promise<unknown> {
  return ready;
}
