/**
 * The persisted-key name for the Burrow's enrollment, kept apart from the code
 * that reads it because two packages have to agree on it: the VS Code extension
 * burrow's store (`vscode-ext/src/burrow-store.ts`), which writes it into
 * `SecretStorage`, and the tests on both sides.
 *
 * A key that drifted between the two would strand an enrollment that is still
 * on disk.
 */
export const ENROLLMENT_KEY = 'dormouse.burrow.enrollment';
