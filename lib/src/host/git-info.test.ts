import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitInfo, remoteRepoName } from './git-info';

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
