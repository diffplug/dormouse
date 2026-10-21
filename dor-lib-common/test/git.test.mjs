import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitConfigEntries, localGitRepository } from '../dist/git.js';
import { dir, fakeFs, file, isShare, link } from './fake-fs.mjs';

const win32 = path.win32;
const hasGit = spawnSync('git', ['--version']).status === 0;
const real = { skip: !hasGit ? 'git is not installed' : process.platform === 'win32' ? 'POSIX reads `//x` as `/x`' : false };

/** A Windows repository at `C:\work`, its `.git` entries overridden by `extra`. */
function windowsRepo(extra = {}) {
  return fakeFs({
    'C:\\': dir,
    'C:\\work': dir,
    'C:\\work\\src': dir,
    'C:\\work\\.git': dir,
    'C:\\work\\.git\\HEAD': file('ref: refs/heads/main\n'),
    'C:\\work\\.git\\objects': dir,
    'C:\\work\\.git\\refs': dir,
    'C:\\work\\.git\\config': file('[core]\n\tbare = false\n'),
    ...extra,
  });
}
const windows = (fs) => ({ fs, path: win32, home: 'C:\\Users\\me' });

test('finds the repository a directory sits in, as git does', async () => {
  const fs = windowsRepo();
  assert.deepEqual(await localGitRepository('C:\\work\\src', windows(fs)), { gitDir: 'C:\\work\\.git', commonDir: 'C:\\work\\.git', workTree: 'C:\\work' });
  const worktree = windowsRepo({
    'C:\\wt': dir,
    'C:\\wt\\.git': file('gitdir: C:/work/.git/worktrees/wt\n'),
    'C:\\work\\.git\\worktrees': dir,
    'C:\\work\\.git\\worktrees\\wt': dir,
    'C:\\work\\.git\\worktrees\\wt\\HEAD': file('ref: refs/heads/x\n'),
    'C:\\work\\.git\\worktrees\\wt\\commondir': file('../..\n'),
  });
  assert.deepEqual(await localGitRepository('C:\\wt', windows(worktree)),
    { gitDir: 'C:\\work\\.git\\worktrees\\wt', commonDir: 'C:\\work\\.git', workTree: 'C:\\wt' });
  assert.equal(await localGitRepository('C:\\', windows(fakeFs({ 'C:\\': dir }))), null);
});

test('with Windows semantics, refuses a repository that names a share before anything reaches it', async () => {
  const cases = {
    'a .git file naming a share': { 'C:\\work\\.git': file('gitdir: \\\\host\\share\\repo\n') },
    'a .git file naming a device path': { 'C:\\work\\.git': file('gitdir: //?/UNC/host/share\r\n') },
    'a .git link to a share': { 'C:\\work\\.git': link('\\\\host\\share\\.git') },
    'a commondir naming a share': { 'C:\\work\\.git\\commondir': file('//host/share/repo.git\n') },
    'HEAD linked to a share': { 'C:\\work\\.git\\HEAD': link('\\\\host\\share\\HEAD') },
    'info/exclude linked to a share': { 'C:\\work\\.git\\info': dir, 'C:\\work\\.git\\info\\exclude': link('//host/share/exclude') },
    'an include': { 'C:\\work\\.git\\config': file('[include]\n\tpath = local.inc\n') },
    'a conditional include': { 'C:\\work\\.git\\config': file('[includeIf "onbranch:main"]\n\tpath = local.inc\n') },
    'an excludes file on a share': { 'C:\\work\\.git\\config': file('[core]\n\texcludesFile = "\\\\\\\\host\\\\share\\\\x"\n') },
    'a work tree on a share': { 'C:\\work\\.git\\config': file('[core]\n\tworktree = //host/share\n') },
    "another user's home": { 'C:\\work\\.git\\config': file('[core]\n\texcludesFile = ~other/x\n') },
    'an excludes file through a link to a share': { 'C:\\work\\.git\\config': file('[core]\n\texcludesFile = ignores/x\n'), 'C:\\work\\ignores': link('\\\\host\\share') },
    'a config git would refuse': { 'C:\\work\\.git\\config': file('[core\n') },
    'a legacy remote file linked to a share': { 'C:\\work\\.git\\remotes': dir, 'C:\\work\\.git\\remotes\\origin': link('\\\\host\\share\\origin') },
    // git passes over a candidate it judges more strictly, so it may try the next one.
    'the work tree, as a bare repository, naming a share': { 'C:\\work\\commondir': file('\\\\host\\share\\repo.git\n') },
    'a lower .git without HEAD whose objects are a share': { 'C:\\work\\src\\.git': dir, 'C:\\work\\src\\.git\\objects': link('//host/share/objects') },
  };
  for (const [name, extra] of Object.entries(cases)) {
    const fs = windowsRepo(extra);
    assert.equal(await localGitRepository('C:\\work\\src', windows(fs)), null, name);
    assert.deepEqual(fs.reached.filter(isShare), [], name);
  }
});

test('refuses a repository whose parent folder holds the path-list delimiter, which no ceiling can name', async () => {
  const under = (parent) => fakeFs({
    'C:\\': dir,
    [parent]: dir,
    [`${parent}\\work`]: dir,
    [`${parent}\\work\\.git`]: dir,
    [`${parent}\\work\\.git\\HEAD`]: file('ref: refs/heads/main\n'),
    [`${parent}\\work\\.git\\objects`]: dir,
    [`${parent}\\work\\.git\\refs`]: dir,
  });
  assert.equal(await localGitRepository('C:\\evil;x\\work', windows(under('C:\\evil;x'))), null);
  assert.equal((await localGitRepository('C:\\evil x\\work', windows(under('C:\\evil x'))))?.gitDir, 'C:\\evil x\\work\\.git');
});

test('with Windows semantics, accepts a config naming local paths', async () => {
  const fs = windowsRepo({
    'C:\\work\\.git\\config': file('[core]\n\tworktree = ../..\n\texcludesFile = ~/ignores\n[remote "origin"]\n\turl = //host/share/repo.git\n'),
    'C:\\Users': dir,
    'C:\\Users\\me': dir,
  });
  assert.equal((await localGitRepository('C:\\work', windows(fs)))?.gitDir, 'C:\\work\\.git');
});

test('on this machine, refuses a repository naming a share that POSIX reads as local', real, async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'local-git-')));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  try {
    const repo = path.join(root, 'repo');
    git(root, 'init', '-q', repo);
    // `//<root>/repo/.git` is `<root>/repo/.git` to POSIX, and a share to Windows.
    const share = `/${path.join(repo, '.git')}`;
    const planted = (name, setup) => {
      const dir = path.join(root, name);
      mkdirSync(dir);
      setup(dir);
      return dir;
    };
    const dirs = [
      planted('gitfile', dir => writeFileSync(path.join(dir, '.git'), `gitdir: ${share}\n`)),
      planted('gitlink', dir => symlinkSync(share, path.join(dir, '.git'))),
    ];
    // git itself would answer for each: only the refusal stops it.
    for (const dir of dirs) assert.equal(git(dir, 'rev-parse', '--is-inside-work-tree').toString().trim(), 'true');
    const linked = path.join(root, 'linked');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one');
    git(repo, 'worktree', 'add', '-q', '-b', 'linked', linked);
    writeFileSync(path.join(repo, '.git', 'worktrees', 'linked', 'commondir'), `${share}\n`);
    dirs.push(linked);
    const excludes = planted('excludes', dir => git(dir, 'init', '-q'));
    git(excludes, 'config', 'core.excludesFile', `/${path.join(root, 'x')}`);
    dirs.push(excludes);
    const reached = [];
    const fs = {
      lstat: (p) => { reached.push(p); return lstat(p); },
      readlink: (p) => { reached.push(p); return readlink(p); },
      readFile: (p) => { reached.push(p); return readFile(p, 'utf8'); },
    };
    for (const dir of dirs) assert.equal(await localGitRepository(dir, { fs }), null, dir);
    assert.deepEqual(reached.filter(isShare), []);
    assert.equal((await localGitRepository(repo, { fs }))?.gitDir, path.join(repo, '.git'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gitConfigEntries decodes git config as git does', () => {
  assert.deepEqual(gitConfigEntries([
    '\uFEFF# comment',
    '[Core] ; a comment',
    '\tExcludesFile = "a b" c\\\\d ; trailing',
    '\tbare',
    '[remote "Origin"] url = x\\',
    'y',
    '[includeIf "gitdir:~/w/"]',
    'path = "//host/s"',
    '[section.Sub]',
    'key = "with # hash"\t',
  ].join('\r\n')), [
    { section: 'core', key: 'excludesfile', value: 'a b c\\d' },
    { section: 'core', key: 'bare', value: '' },
    { section: 'remote.Origin', key: 'url', value: 'xy' },
    { section: 'includeif.gitdir:~/w/', key: 'path', value: '//host/s' },
    { section: 'section.sub', key: 'key', value: 'with # hash' },
  ]);
  for (const text of ['[core\n', 'key = 1\n', '[core]\nkey = "open\n', '[core]\nkey = \\q\n', '[core]\n9key = 1\n', '[core]\nkey # x\n', '[a "b]\n']) {
    assert.equal(gitConfigEntries(text), null, text);
  }
});
