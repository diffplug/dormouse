import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalLocalDirectory, localRealpath, localRealpathIfExists, NonLocalPathError } from '../dist/local-path.js';
import { dir, fakeFs, file, isShare, link } from './fake-fs.mjs';

const win32 = path.win32;
const SHARES = ['\\\\host\\share\\x', '//host/share/x', '\\/host/share', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', '//?/C:/x'];

test('refuses a share or device path before any filesystem call', async () => {
  for (const paths of [win32, path.posix]) {
    const fs = fakeFs({});
    for (const input of SHARES) {
      await assert.rejects(localRealpath(input, { fs, path: paths }), NonLocalPathError, input);
      assert.equal(await canonicalLocalDirectory(input, { fs, path: paths }), null, input);
    }
    assert.deepEqual(fs.reached, []);
  }
});

test('refuses a relative path, which would resolve against an unknown cwd', async () => {
  const fs = fakeFs({});
  for (const input of ['x', 'C:x', '.\\x']) await assert.rejects(localRealpath(input, { fs, path: win32 }), NonLocalPathError, input);
  assert.deepEqual(fs.reached, []);
});

test('with Windows semantics, never follows a link to a share, wherever in the path it sits', async () => {
  const fs = fakeFs({
    'C:\\': dir,
    'C:\\work': dir,
    'C:\\work\\unc': link('\\\\host\\share'),
    'C:\\work\\slashes': link('//host/share/repo'),
    'C:\\work\\device': link('\\\\?\\UNC\\host\\share'),
    'C:\\work\\to-unc': link('unc'),
  });
  for (const input of ['C:\\work\\unc', 'C:\\work\\unc\\deeper\\file.png', 'C:\\work\\slashes', 'C:\\work\\device', 'C:\\work\\to-unc\\x']) {
    await assert.rejects(localRealpath(input, { fs, path: win32 }), NonLocalPathError, input);
    await assert.rejects(localRealpathIfExists(input, { fs, path: win32 }), NonLocalPathError, input);
  }
  assert.equal(fs.reached.filter(isShare).length, 0);
});

test('with Windows semantics, resolves relative and absolute links to the canonical path and its own stats', async () => {
  const fs = fakeFs({
    'C:\\': dir,
    'C:\\work': dir,
    'C:\\work\\real': dir,
    'C:\\work\\real\\doc.md': file('# doc'),
    'C:\\work\\relative': link('real'),
    'C:\\work\\absolute': link('C:\\work\\relative'),
    'D:\\': dir,
    'D:\\docs': link('C:\\work\\real'),
  });
  const doc = await localRealpath('C:\\work\\absolute\\doc.md', { fs, path: win32 });
  assert.equal(doc.path, 'C:\\work\\real\\doc.md');
  assert.equal(doc.stats.isFile(), true);
  assert.equal((await localRealpath('D:\\docs\\..\\docs', { fs, path: win32 })).path, 'C:\\work\\real');
  assert.equal(await canonicalLocalDirectory('C:/work/relative', { fs, path: win32 }), 'C:\\work\\real');
  assert.equal(await canonicalLocalDirectory('C:\\work\\real\\doc.md', { fs, path: win32 }), null);
  assert.equal(await localRealpathIfExists('C:\\work\\missing\\x', { fs, path: win32 }), null);
});

// POSIX cannot make a link to a real share, so each share link here names a
// path that exists when read as POSIX would: only the refusal stops it.
test('on this machine, refuses a link to a share that POSIX would read as a local path', { skip: process.platform === 'win32' }, async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'local-path-')));
  try {
    mkdirSync(path.join(root, 'real'));
    writeFileSync(path.join(root, 'real', 'doc.md'), '');
    // `//<root>/real` is `<root>/real` to POSIX, and a share to Windows.
    symlinkSync(`/${path.join(root, 'real')}`, path.join(root, 'share'));
    symlinkSync(path.join(root, 'share', 'doc.md'), path.join(root, 'through-share'));
    symlinkSync('real/doc.md', path.join(root, 'local'));
    for (const name of ['share', 'share/doc.md', 'through-share']) {
      await assert.rejects(localRealpath(path.join(root, name)), NonLocalPathError, name);
    }
    assert.equal((await localRealpath(path.join(root, 'local'))).path, path.join(root, 'real', 'doc.md'));
    await assert.rejects(localRealpath(path.join(root, 'missing')), { code: 'ENOENT' });
    assert.equal(await localRealpathIfExists(path.join(root, 'missing')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('takes only the stored case from the native realpath, run once no link is left', async () => {
  const stored = { 'Z:\\docs': '\\\\server\\share\\docs', 'C:\\PROGRA~1': 'C:\\Program Files', 'C:\\NOTES': 'C:\\Notes' };
  const fs = { ...fakeFs({ 'Z:\\': dir, 'Z:\\docs': dir, 'C:\\': dir, 'C:\\PROGRA~1': dir, 'C:\\NOTES': dir }), realpath: async (path) => stored[path] ?? path };
  // A mapped drive's share, or an 8.3 name, keeps the spelling the walk resolved.
  assert.equal((await localRealpath('Z:\\docs', { fs, path: win32 })).path, 'Z:\\docs');
  assert.equal((await localRealpath('C:\\PROGRA~1', { fs, path: win32 })).path, 'C:\\PROGRA~1');
  assert.equal((await localRealpath('C:\\NOTES', { fs, path: win32 })).path, 'C:\\Notes');
});

test('on a case-insensitive volume, answers the stored case as realpath does', async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'local-path-case-')));
  try {
    writeFileSync(path.join(root, 'Doc.md'), '');
    if (!existsSync(path.join(root, 'doc.md'))) return t.skip('case-sensitive volume');
    assert.equal((await localRealpath(path.join(root, 'doc.md'))).path, path.join(root, 'Doc.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gives up on a link loop', async () => {
  const fs = fakeFs({ 'C:\\': dir, 'C:\\a': link('C:\\b'), 'C:\\b': link('C:\\a') });
  await assert.rejects(localRealpath('C:\\a', { fs, path: win32 }), { code: 'ELOOP' });
});
