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
