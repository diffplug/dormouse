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
