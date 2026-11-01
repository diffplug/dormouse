import { UNTRUSTED_REPO_GIT_ARGS, localGitRepository, resolveBinaryPath, spawnAndCapture, untrustedGitEnv } from 'dor-lib-common';

/** Subcommands that open no index, so their repository check need not read it. */
const INDEXLESS_SUBCOMMANDS = new Set(['config', 'remote']);

/**
 * Run git against `dir` and answer its trimmed stdout, or null on any failure:
 * no git on `PATH`, not a repository `localGitRepository` accepts, a non-zero
 * exit, or empty output.
 *
 * The directory travels in argv, not a `cwd` option (`docs/specs/dor-cli.md`
 * -> the `spawnAndCapture` rules). Each caller owns validating `dir` first:
 * the host-resolved project root in `git-upstream.ts`; an existing absolute
 * directory, canonicalized, in `git-info.ts`, whose paths originate as
 * terminal-reported cwds. Either may be a repository the user has never
 * trusted, so every run leads with `UNTRUSTED_REPO_GIT_ARGS`.
 */
export async function runGit(dir: string, args: string[]): Promise<string | null> {
  // The `PATH`-resolved file, never the bare name, which Windows looks up in
  // the host's working directory first (`docs/specs/security-local.md` ->
  // "Spawned programs").
  const git = resolveBinaryPath('git', process.env);
  const repository = git && await localGitRepository(dir, { index: !INDEXLESS_SUBCOMMANDS.has(args[0]) });
  if (!repository) return null;
  const result = await spawnAndCapture(git, [...UNTRUSTED_REPO_GIT_ARGS, '-C', dir, ...args], { env: untrustedGitEnv(repository) });
  if (!result.ok || result.exitCode !== 0) return null;
  const out = result.stdout.trim();
  return out || null;
}
