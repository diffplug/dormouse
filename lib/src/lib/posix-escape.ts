/**
 * The one definition of "characters a POSIX shell backslash-escapes", shared by
 * the two halves that have to agree about it:
 *
 * - `shellEscapePosix` (`shell-escape.ts`) *writes* them, backslash-escaping
 *   each one so a dropped path pastes as a path rather than as opaque text.
 * - `tokenizeCommand` (`terminal-state.ts`) *reads* them back, treating `\`
 *   before anything else as a literal path separator so a native Windows
 *   program path survives to the basename split.
 *
 * They disagreed once, about `~`, and a path Dormouse itself escaped rendered
 * with a stray backslash in the pane header. `terminal-state.test.ts` ->
 * "command tokenizer dialects" pins both directions character by character.
 *
 * Its own module because `terminal-state.ts` is bundled into the VS Code
 * extension host and the Tauri sidecar, where the `dor/*` path `shell-escape.ts`
 * imports does not resolve — this file must stay dependency-free.
 */
export const POSIX_ESCAPABLE = /[ \t!"#$&'()*;<>?[\\\]`{|}~]/;
