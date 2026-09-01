/**
 * The persisted-key name for the Host's enrollment, kept apart from the code
 * that reads it because two packages have to agree on it: the VS Code extension
 * host's store (`vscode-ext/src/remote-host-store.ts`), which writes it into
 * `SecretStorage`, and the tests on both sides.
 *
 * It lives here rather than in `enrollment.ts` so the extension host can import
 * it without pulling `server-lib-common` into its bundle. A key that drifted
 * between the two would strand an enrollment that is still on disk.
 */
export const ENROLLMENT_KEY = 'dormouse.remote-host.enrollment';
