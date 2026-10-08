/**
 * The arguments that lead every git run in a repository the user has not
 * vouched for: a terminal-reported cwd, a Tool's project root before trust, a
 * folder `dor open` lists or the folder viewer browses
 * (`docs/specs/security-local.md` -> "Spawned programs").
 *
 * A repository's own `.git/config` can name a program for git to run.
 * `core.fsmonitor` is the one such key the queries Dormouse runs can reach —
 * `rev-parse`, `config --get`, `remote get-url`, and the index readers
 * `ls-files` and `check-ignore` — since none runs a hook, reads contents
 * through a filter or textconv, pages to a pipe, or fetches. A subcommand that
 * does any of those needs its own override here before it runs untrusted.
 */
export const UNTRUSTED_REPO_GIT_ARGS: readonly string[] = ['-c', 'core.fsmonitor=false'];
