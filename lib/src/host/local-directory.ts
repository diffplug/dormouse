/**
 * The canonical path of an existing local directory, for the terminal context
 * directory actions and Workspace auto-naming's git lookup
 * (`docs/specs/security-local.md` → "Terminal context directory actions").
 * Both take a terminal-reported cwd, so any program names the path, and
 * `canonicalLocalDirectory` resolves it without following a link to a share
 * or device path.
 *
 * Bundled into the standalone sidecar through `git-info.cjs` and into VS Code's
 * PTY host, which hand it to `pty-core`.
 */
export { canonicalLocalDirectory } from 'dor-lib-common/local-path';
