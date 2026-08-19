/**
 * The one key prefix every Host-side persisted value lives under
 * (`enrollment.ts` → `ENROLLMENT_KEY`, `acl.ts` → `ACL_KEY_PREFIX`).
 *
 * One prefix rather than a scatter of keys so a host can name the whole Host
 * store at once — which is what lets a Node-resident Host adopt what a webview
 * persisted before it existed, and what keys the VS Code extension host writes
 * its own copy under (`vscode-ext/src/remote-host-store.ts`).
 */
export const REMOTE_HOST_STORE_PREFIX = 'dormouse.remote-host.';

/**
 * The enrollment blob's key. It lives here rather than in `enrollment.ts` so
 * the extension host can import it without pulling `server-lib-common` into the
 * extension bundle; `enrollment.ts` re-exports it for its own callers.
 */
export const ENROLLMENT_KEY = `${REMOTE_HOST_STORE_PREFIX}enrollment`;
