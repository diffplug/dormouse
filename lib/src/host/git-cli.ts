import { resolveBinaryPath, spawnAndCapture } from 'dor-lib-common';

/**
 * Run git against `dir` and answer its trimmed stdout, or null on any failure:
 * no git on `PATH`, not a repository, a non-zero exit, or empty output.
 *
 * The directory travels in argv, not a `cwd` option (`docs/specs/dor-cli.md`
 * -> the `spawnAndCapture` rules). Each caller owns validating `dir` first:
 * the host-resolved project root in `git-upstream.ts`; an existing absolute
 * directory, canonicalized, in `git-info.ts`, whose paths originate as
 * terminal-reported cwds.
 */
export async function runGit(dir: string, args: string[]): Promise<string | null> {
  // The `PATH`-resolved file, never the bare name, which Windows looks up in
  // the host's working directory first (`docs/specs/security-local.md` ->
  // "Spawned programs").
  const git = resolveBinaryPath('git', process.env);
  if (!git) return null;
  const result = await spawnAndCapture(git, ['-C', dir, ...args]);
  if (!result.ok || result.exitCode !== 0) return null;
  const out = result.stdout.trim();
  return out || null;
}
