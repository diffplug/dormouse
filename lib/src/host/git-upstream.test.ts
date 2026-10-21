import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const GIT = '/usr/bin/git';
// The repository's git directory, whose `HEAD` the lookup reads itself.
const gitDir = join(mkdtempSync(join(tmpdir(), 'git-upstream-')), '.git');
mkdirSync(gitDir);
afterAll(() => rmSync(join(gitDir, '..'), { recursive: true, force: true }));
const head = (contents: string) => writeFileSync(join(gitDir, 'HEAD'), `${contents}\n`);

const spawnAndCapture = vi.fn();
const resolveBinaryPath = vi.fn((_name: string, _env: unknown): string | undefined => GIT);
const localGitRepository = vi.fn(async (dir: string) => ({ gitDir, commonDir: gitDir, workTree: dir }) as unknown);
vi.mock('dor-lib-common', async (importOriginal) => ({
  ...await importOriginal<typeof import('dor-lib-common')>(),
  spawnAndCapture: (...args: unknown[]) => spawnAndCapture(...args),
  resolveBinaryPath: (name: string, env: unknown) => resolveBinaryPath(name, env),
  localGitRepository: (dir: string) => localGitRepository(dir),
}));

const { resolveUpstreamUrl } = await import('./git-upstream');
const { UNTRUSTED_REPO_GIT_ARGS: UNTRUSTED } = await import('dor-lib-common');

const ok = (stdout: string) => ({ ok: true, exitCode: 0, stdout, stderr: '' });
const failed = (exitCode = 128) => ({ ok: true, exitCode, stdout: '', stderr: 'fatal' });
const enoent = () => ({ ok: false, error: { code: 'ENOENT', message: 'git not found' } });

/** Script the two calls in order: the branch's remote, then remote get-url. */
function script(...results: unknown[]) {
  spawnAndCapture.mockReset();
  for (const result of results) spawnAndCapture.mockResolvedValueOnce(result);
  spawnAndCapture.mockResolvedValue(failed());
}
/** The argv of the `n`th git run, one-based. */
const argv = (n: number) => spawnAndCapture.mock.calls[n - 1]?.[1];

beforeEach(() => {
  spawnAndCapture.mockReset();
  head('ref: refs/heads/main');
});

describe('resolveUpstreamUrl', () => {
  it('runs git by its PATH-resolved path, and nothing when PATH has none', async () => {
    // Windows looks a bare name up in the working directory before PATH.
    script(ok('origin'), ok('https://github.com/o/r'));
    await resolveUpstreamUrl('/repo');
    expect(resolveBinaryPath).toHaveBeenCalledWith('git', process.env);
    for (const [binary] of spawnAndCapture.mock.calls) expect(binary).toBe(GIT);
    spawnAndCapture.mockReset();
    resolveBinaryPath.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined);
    expect(await resolveUpstreamUrl('/repo')).toBeNull();
    expect(spawnAndCapture).not.toHaveBeenCalled();
  });

  it('runs no git where localGitRepository refuses the directory', async () => {
    script(ok('origin'), ok('https://github.com/o/r'));
    localGitRepository.mockResolvedValueOnce(null);
    expect(await resolveUpstreamUrl('/repo')).toBeNull();
    expect(localGitRepository).toHaveBeenCalledWith('/repo');
    expect(spawnAndCapture).not.toHaveBeenCalled();
  });

  it('uses the branch upstream’s remote, read from config, never by resolving a ref', async () => {
    script(ok('origin'), ok('git@github.com:diffplug/dormouse.git'));
    expect(await resolveUpstreamUrl('/repo')).toBe('https://github.com/diffplug/dormouse');
    expect(argv(1)).toEqual([...UNTRUSTED, '-C', '/repo', 'config', '--get', 'branch.main.remote']);
    expect(argv(2)).toEqual([...UNTRUSTED, '-C', '/repo', 'remote', 'get-url', 'origin']);
    expect(spawnAndCapture).toHaveBeenCalledTimes(2);
  });

  it('prefers a fork over the repo you trusted', async () => {
    // The case the branch lookup exists for: a PR branch tracking a
    // contributor's fork must not inherit the upstream repo's grant.
    head('ref: refs/heads/pr-500');
    script(ok('newbie'), ok('https://github.com/newbie/dormouse.git'));
    expect(await resolveUpstreamUrl('/repo')).toBe('https://github.com/newbie/dormouse');
    expect(argv(1)).toEqual([...UNTRUSTED, '-C', '/repo', 'config', '--get', 'branch.pr-500.remote']);
    expect(argv(2)).toEqual([...UNTRUSTED, '-C', '/repo', 'remote', 'get-url', 'newbie']);
  });

  it('reads a branch name containing slashes whole', async () => {
    head('ref: refs/heads/feature/nested');
    script(ok('origin'), ok('https://github.com/o/r'));
    await expect(resolveUpstreamUrl('/repo')).resolves.toBe('https://github.com/o/r');
    expect(argv(1)).toEqual([...UNTRUSTED, '-C', '/repo', 'config', '--get', 'branch.feature/nested.remote']);
  });

  it('falls back to origin when the branch tracks a local branch', async () => {
    script(ok('.'), ok('https://github.com/o/r'));
    await expect(resolveUpstreamUrl('/repo')).resolves.toBe('https://github.com/o/r');
    expect(argv(2)).toEqual([...UNTRUSTED, '-C', '/repo', 'remote', 'get-url', 'origin']);
  });

  it('falls back to origin with no upstream set', async () => {
    script(failed(), ok('https://github.com/diffplug/dormouse'));
    expect(await resolveUpstreamUrl('/repo')).toBe('https://github.com/diffplug/dormouse');
    expect(argv(2)).toEqual([...UNTRUSTED, '-C', '/repo', 'remote', 'get-url', 'origin']);
  });

  it('falls back to origin on a detached HEAD', async () => {
    head('0123456789abcdef0123456789abcdef01234567');
    script(ok('https://github.com/diffplug/dormouse'));
    expect(await resolveUpstreamUrl('/repo')).toBe('https://github.com/diffplug/dormouse');
    expect(argv(1)).toEqual([...UNTRUSTED, '-C', '/repo', 'remote', 'get-url', 'origin']);
  });

  it('is null when the remote has no URL', async () => {
    script(ok('origin'), failed());
    expect(await resolveUpstreamUrl('/repo')).toBeNull();
  });

  it('is null outside a git repo', async () => {
    script(failed(), failed());
    expect(await resolveUpstreamUrl('/tmp/plain')).toBeNull();
  });

  it('is null when git is not installed', async () => {
    script(enoent(), enoent());
    expect(await resolveUpstreamUrl('/repo')).toBeNull();
  });

  it('is null when the remote URL is a local path', async () => {
    // A local clone's "upstream" is a directory on this machine; folder trust
    // is the right tool for that, not a shared remote key.
    script(ok('origin'), ok('/srv/repos/bare.git'));
    expect(await resolveUpstreamUrl('/repo')).toBeNull();
  });

  it('never runs a shell and never interpolates the directory', async () => {
    script(ok('origin'), ok('https://github.com/o/r'));
    await resolveUpstreamUrl('/repo with spaces/;rm -rf /');
    for (const [binary, args] of spawnAndCapture.mock.calls) {
      expect(binary).toBe(GIT);
      expect(args.slice(0, UNTRUSTED.length + 2)).toEqual([...UNTRUSTED, '-C', '/repo with spaces/;rm -rf /']);
    }
  });
});
