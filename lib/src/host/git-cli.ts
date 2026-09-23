import { spawnAndCapture } from 'dor-lib-common';

/**
 * Run git against `dir` and answer its trimmed stdout, or null on any failure:
 * no git, not a repository, a non-zero exit, or empty output.
 *
 * The directory travels in argv, not a `cwd` option (`docs/specs/dor-cli.md`
 * -> the `spawnAndCapture` rules). `dir` is a host-validated path, never a raw
 * string off the wire.
 */
export async function runGit(dir: string, args: string[]): Promise<string | null> {
  const result = await spawnAndCapture('git', ['-C', dir, ...args]);
  if (!result.ok || result.exitCode !== 0) return null;
  const out = result.stdout.trim();
  return out || null;
}
