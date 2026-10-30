import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitConfigEntries, indexBase, localGitRepository } from '../dist/git.js';
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

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
/** An index with no entries and these `[signature, data]` extensions. */
const indexWith = (...extensions) => Buffer.concat([
  Buffer.from('DIRC'), u32(2), u32(0),
  ...extensions.flatMap(([signature, data]) => [Buffer.from(signature, 'latin1'), u32(data.length), data]),
  Buffer.alloc(20),
]);
const SHARED = 'ab'.repeat(20);
const splitIndex = indexWith(['link', Buffer.concat([Buffer.from(SHARED, 'hex'), Buffer.alloc(8)])]);

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
    'the shared index a split index names linked to a share': { 'C:\\work\\.git\\index': file(splitIndex), [`C:\\work\\.git\\sharedindex.${SHARED}`]: link('\\\\host\\share\\x') },
    'a sparse index': { 'C:\\work\\.git\\index': file(indexWith(['sdir', Buffer.alloc(0)])) },
    'an index extension git must understand': { 'C:\\work\\.git\\index': file(indexWith(['zzzz', Buffer.alloc(0)])) },
    'an alternate on a share': { 'C:\\work\\.git\\objects\\info': dir, 'C:\\work\\.git\\objects\\info\\alternates': file('# shared\n\\\\host\\share\\objects\n') },
    'an alternates file linked to a share': { 'C:\\work\\.git\\objects\\info': dir, 'C:\\work\\.git\\objects\\info\\alternates': link('//host/share/alternates') },
    'an alternate whose own alternate is a share': {
      'C:\\work\\.git\\objects\\info': dir,
      'C:\\work\\.git\\objects\\info\\alternates': file('../../../other/objects\n'),
      'C:\\other': dir, 'C:\\other\\objects': dir, 'C:\\other\\objects\\info': dir,
      'C:\\other\\objects\\info\\alternates': file('//host/share/objects\n'),
    },
    'the branch HEAD names linked to a share': { 'C:\\work\\.git\\refs\\heads': dir, 'C:\\work\\.git\\refs\\heads\\main': link('\\\\host\\share\\main') },
    'a ref a symbolic branch names linked to a share': {
      'C:\\work\\.git\\refs\\heads': dir,
      'C:\\work\\.git\\refs\\heads\\main': file('ref: refs/heads/other\n'),
      'C:\\work\\.git\\refs\\heads\\other': link('\\\\host\\share\\other'),
    },
    'a reftable table linked to a share': { 'C:\\work\\.git\\reftable': dir, 'C:\\work\\.git\\reftable\\tables.list': link('\\\\host\\share\\tables.list') },
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

test('reads the index only for a query that opens it', async () => {
  const fs = windowsRepo({ 'C:\\work\\.git\\index': file(indexWith(['sdir', Buffer.alloc(0)])) });
  assert.equal(await localGitRepository('C:\\work', windows(fs)), null);
  assert.equal((await localGitRepository('C:\\work', { ...windows(fs), index: false }))?.gitDir, 'C:\\work\\.git');
});

test('with Windows semantics, accepts a split index, alternates, and symbolic refs that stay local', async () => {
  const fs = windowsRepo({
    'C:\\work\\.git\\index': file(splitIndex),
    [`C:\\work\\.git\\sharedindex.${SHARED}`]: file(indexWith(['TREE', Buffer.alloc(3)])),
    'C:\\work\\.git\\objects\\info': dir,
    'C:\\work\\.git\\objects\\info\\alternates': file('C:/other/objects\n'),
    'C:\\other': dir,
    'C:\\other\\objects': dir,
    'C:\\work\\.git\\refs\\heads': dir,
    'C:\\work\\.git\\refs\\heads\\main': file('ref: refs/heads/other\n'),
    'C:\\work\\.git\\refs\\heads\\other': file(`${'1'.repeat(40)}\n`),
  });
  assert.equal((await localGitRepository('C:\\work', windows(fs)))?.gitDir, 'C:\\work\\.git');
  assert.ok(fs.reached.includes(`C:\\work\\.git\\sharedindex.${SHARED}`) && fs.reached.includes('C:\\other\\objects\\info'));
});

test('on this machine, reads the shared index from every index git writes, and refuses one linked to a share', real, async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'local-git-')));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' }).toString();
  const sharedOf = (repo) => readdirSync(path.join(repo, '.git')).find(name => name.startsWith('sharedindex.'))?.slice('sharedindex.'.length);
  try {
    for (const [format, version] of [['sha1', 2], ['sha1', 3], ['sha1', 4], ['sha256', 4]]) {
      const repo = path.join(root, `${format}-${version}`);
      git(root, 'init', '-q', '-b', 'main', `--object-format=${format}`, repo);
      mkdirSync(path.join(repo, 'a', 'b'), { recursive: true });
      for (const name of ['x', 'a/y', 'a/b/z', `a/${'n'.repeat(200)}`]) writeFileSync(path.join(repo, name), name);
      git(repo, 'add', '.');
      if (version > 2) {
        // An intent-to-add entry carries the extended flags, which version 2 cannot.
        writeFileSync(path.join(repo, 'later'), '');
        git(repo, 'add', '-N', 'later');
      }
      git(repo, 'update-index', '--index-version', String(version));
      git(repo, 'update-index', '--split-index');
      // The split index names the base, which holds the entries; each must parse.
      assert.equal(indexBase(readFileSync(path.join(repo, '.git', 'index')), format === 'sha256' ? 32 : 20), sharedOf(repo), repo);
      assert.equal(indexBase(readFileSync(path.join(repo, '.git', `sharedindex.${sharedOf(repo)}`)), format === 'sha256' ? 32 : 20), null, repo);
      assert.equal((await localGitRepository(repo))?.gitDir, path.join(repo, '.git'), repo);
    }
    const repo = path.join(root, 'sha1-2');
    const shared = path.join(repo, '.git', `sharedindex.${sharedOf(repo)}`);
    renameSync(shared, path.join(root, 'outside'));
    // `//<root>/outside` is `<root>/outside` to POSIX, and a share to Windows.
    symlinkSync(`/${path.join(root, 'outside')}`, shared);
    // git reads through it: only the refusal stops it.
    assert.match(git(repo, '-c', 'core.fsmonitor=false', 'ls-files'), /a\/b\/z/);
    const reached = [];
    const fs = {
      lstat: (p) => { reached.push(p); return lstat(p); },
      readlink: (p) => { reached.push(p); return readlink(p); },
      readFile: (p) => { reached.push(p); return readFile(p); },
    };
    assert.equal(await localGitRepository(repo, { fs }), null);
    assert.deepEqual(reached.filter(isShare), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('on this machine, refuses a sparse index, and alternates or the branch HEAD names on a share', real, async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'local-git-')));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' }).toString();
  try {
    const repo = path.join(root, 'repo');
    git(root, 'init', '-q', '-b', 'main', repo);
    mkdirSync(path.join(repo, 'in'));
    mkdirSync(path.join(repo, 'out'));
    writeFileSync(path.join(repo, 'in', 'a'), 'a');
    writeFileSync(path.join(repo, 'out', 'b'), 'b');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'one');
    const clone = path.join(root, 'clone');
    git(root, 'clone', '-q', '--shared', repo, clone);
    assert.equal((await localGitRepository(clone))?.gitDir, path.join(clone, '.git'));
    writeFileSync(path.join(clone, '.git', 'objects', 'info', 'alternates'), `/${path.join(repo, '.git', 'objects')}\n`);
    // git reads its objects through the share spelling.
    git(clone, 'cat-file', '-e', 'HEAD');
    assert.equal(await localGitRepository(clone), null);

    const branch = path.join(repo, '.git', 'refs', 'heads', 'main');
    renameSync(branch, path.join(root, 'main'));
    symlinkSync(`/${path.join(root, 'main')}`, branch);
    assert.equal(git(repo, 'rev-parse', 'HEAD').length, 41);
    assert.equal(await localGitRepository(repo), null);
    rmSync(branch);
    renameSync(path.join(root, 'main'), branch);

    assert.equal((await localGitRepository(repo))?.gitDir, path.join(repo, '.git'));
    git(repo, 'sparse-checkout', 'set', '--cone', '--sparse-index', 'in');
    assert.match(git(repo, 'ls-files', '--sparse'), /^out\/$/m);
    assert.equal(await localGitRepository(repo), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
      readFile: (p) => { reached.push(p); return readFile(p); },
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
