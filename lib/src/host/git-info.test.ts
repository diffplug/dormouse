import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The real spawner, observed: a symlinked path gives git's answer unchanged
// (git chdirs to the physical path itself), so only argv shows canonicalization.
const spawned = vi.hoisted(() => [] as string[][]);
vi.mock('dor-lib-common', async (importActual) => {
  const actual = await importActual<typeof import('dor-lib-common')>();
  return {
    ...actual,
    spawnAndCapture: (binary: string, args: readonly string[]) => {
      spawned.push([...args]);
      // A directory named `hung` stands in for a network mount git never returns from.
      if (args.some((arg) => arg.endsWith('/hung'))) return new Promise(() => {});
      return actual.spawnAndCapture(binary, args);
    },
  };
});

const { gitInfo, remoteRepoName } = await import('./git-info');

let root: string;
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'git-info-')));
  const repo = join(root, 'myrepo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'one');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature/x', join(root, 'myrepo.feature-x'));

  const detached = join(root, 'detached');
  git(root, 'clone', '-q', repo, detached);
  git(detached, 'checkout', '-q', '--detach');
  git(detached, 'remote', 'set-url', 'origin', 'git@github.com:diffplug/dormouse.git');

  mkdirSync(join(root, 'plain'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('gitInfo', () => {
  it('names a checkout with no origin after its folder, from any subdirectory', async () => {
    const result = await gitInfo([join(root, 'myrepo/src')]);
    expect(result[join(root, 'myrepo/src')]).toEqual({ repo: 'myrepo', branch: 'main' });
  });

  it('names a worktree after its main checkout', async () => {
    const dir = join(root, 'myrepo.feature-x');
    expect((await gitInfo([dir]))[dir]).toEqual({ repo: 'myrepo', branch: 'feature/x' });
  });

  it("prefers origin's name, and a short hash on a detached HEAD", async () => {
    const dir = join(root, 'detached');
    const info = (await gitInfo([dir]))[dir];
    expect(info?.repo).toBe('dormouse');
    expect(info?.branch).toMatch(/^[0-9a-f]{7,}$/);
  });

  it('answers null outside a repository, for a missing path, and for a relative one', async () => {
    const plain = join(root, 'plain');
    const missing = join(root, 'nope');
    expect(await gitInfo([plain, missing, 'myrepo'])).toEqual({ [plain]: null, [missing]: null, myrepo: null });
  });

  it('hands git the canonical path, never the symlink it was given', async () => {
    const link = join(root, 'link-to-src');
    symlinkSync(join(root, 'myrepo/src'), link);
    spawned.length = 0;
    expect((await gitInfo([link]))[link]).toEqual({ repo: 'myrepo', branch: 'main' });
    const dirs = spawned.map((args) => args[args.indexOf('-C') + 1]);
    expect(dirs.length).toBeGreaterThan(0);
    expect(new Set(dirs)).toEqual(new Set([join(root, 'myrepo/src')]));
  });

  it('names an unborn branch', async () => {
    const dir = join(root, 'unborn');
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'fresh');
    expect((await gitInfo([dir]))[dir]).toEqual({ repo: 'unborn', branch: 'fresh' });
  });

  it('leaves a lookup past its deadline out of the answer, never answering null', async () => {
    const hung = join(root, 'hung');
    mkdirSync(hung, { recursive: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const answer = gitInfo([hung]);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await answer).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores anything but a list of strings', async () => {
    expect(await gitInfo('nope')).toEqual({});
    expect(await gitInfo([42])).toEqual({});
  });
});

describe('remoteRepoName', () => {
  it.each([
    ['git@github.com:diffplug/dormouse.git', 'dormouse'],
    ['https://github.com/diffplug/dormouse/', 'dormouse'],
    ['ssh://git@host:22/team/app', 'app'],
    ['/srv/git/local.git', 'local'],
    ['C:\\repos\\thing', 'thing'],
    ['', null],
  ])('%s → %s', (url, name) => {
    expect(remoteRepoName(url)).toBe(name);
  });
});
