import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnAndCapture = vi.fn();
vi.mock('dor-lib-common', () => ({ spawnAndCapture: (...args: unknown[]) => spawnAndCapture(...args) }));

const { resolveUpstreamUrl } = await import('./git-upstream');

const ok = (stdout: string) => ({ ok: true, exitCode: 0, stdout, stderr: '' });
const failed = (exitCode = 128) => ({ ok: true, exitCode, stdout: '', stderr: 'fatal' });
const enoent = () => ({ ok: false, error: { code: 'ENOENT', message: 'git not found' } });

/** Script the two calls in order: upstream lookup, then remote get-url. */
function script(...results: unknown[]) {
  spawnAndCapture.mockReset();
  for (const result of results) spawnAndCapture.mockResolvedValueOnce(result);
  spawnAndCapture.mockResolvedValue(failed());
}

beforeEach(() => spawnAndCapture.mockReset());

describe('resolveUpstreamUrl', () => {
  it('uses the branch upstream’s remote', async () => {
    script(ok('origin/main'), ok('git@github.com:diffplug/dormouse.git'));
    expect(await resolveUpstreamUrl('/repo')).toBe('https://github.com/diffplug/dormouse');
    expect(spawnAndCapture).toHaveBeenNthCalledWith(1, 'git',
      ['-C', '/repo', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    expect(spawnAndCapture).toHaveBeenNthCalledWith(2, 'git', ['-C', '/repo', 'remote', 'get-url', 'origin']);
  });

  it('prefers a fork over the repo you trusted', async () => {
    // The case the branch lookup exists for: a PR branch tracking a
    // contributor's fork must not inherit the upstream repo's grant.
    script(ok('newbie/pr-500'), ok('https://github.com/newbie/dormouse.git'));
    expect(await resolveUpstreamUrl('/repo')).toBe('https://github.com/newbie/dormouse');
    expect(spawnAndCapture).toHaveBeenNthCalledWith(2, 'git', ['-C', '/repo', 'remote', 'get-url', 'newbie']);
  });

  it('keeps a branch name containing slashes out of the remote name', async () => {
    script(ok('origin/feature/nested'), ok('https://github.com/o/r'));
    await expect(resolveUpstreamUrl('/repo')).resolves.toBe('https://github.com/o/r');
    expect(spawnAndCapture).toHaveBeenNthCalledWith(2, 'git', ['-C', '/repo', 'remote', 'get-url', 'origin']);
  });

  it('falls back to origin with no upstream set', async () => {
    script(failed(), ok('https://github.com/diffplug/dormouse'));
    expect(await resolveUpstreamUrl('/repo')).toBe('https://github.com/diffplug/dormouse');
    expect(spawnAndCapture).toHaveBeenNthCalledWith(2, 'git', ['-C', '/repo', 'remote', 'get-url', 'origin']);
  });

  it('falls back to origin on a detached HEAD', async () => {
    script(ok('HEAD'), ok('https://github.com/diffplug/dormouse'));
    expect(await resolveUpstreamUrl('/repo')).toBe('https://github.com/diffplug/dormouse');
  });

  it('is null when the remote has no URL', async () => {
    script(ok('origin/main'), failed());
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
    script(ok('origin/main'), ok('/srv/repos/bare.git'));
    expect(await resolveUpstreamUrl('/repo')).toBeNull();
  });

  it('never runs a shell and never interpolates the directory', async () => {
    script(ok('origin/main'), ok('https://github.com/o/r'));
    await resolveUpstreamUrl('/repo with spaces/;rm -rf /');
    for (const [binary, args] of spawnAndCapture.mock.calls) {
      expect(binary).toBe('git');
      expect(args[0]).toBe('-C');
      expect(args[1]).toBe('/repo with spaces/;rm -rf /');
    }
  });
});
