/**
 * The persisted-key names for the Host's own state, kept apart from the code
 * that reads them because three places have to agree on them: the webview's
 * legacy `localStorage` copy (`enrollment.ts`, `acl.ts` → `ACL_KEY_PREFIX`),
 * the one-shot adoption that hands that copy to the service, and the VS Code
 * extension host's store (`vscode-ext/src/remote-host-store.ts`), which writes
 * the same names into `SecretStorage`.
 *
 * `ENROLLMENT_KEY` lives here rather than in `enrollment.ts` so the extension
 * host can import it without pulling `server-lib-common` into its bundle. A key
 * that drifted between any two of them would strand an enrollment that is still
 * on disk.
 */
export const ENROLLMENT_KEY = 'dormouse.remote-host.enrollment';
