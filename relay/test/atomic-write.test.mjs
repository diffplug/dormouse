/**
 * The Relay's state files hold bearer tokens and are replaced by rename. A
 * rename that fails must leave neither a temp copy nor a damaged file, and on
 * Windows a destination held for a moment must not fail the write.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { replaceAtomically } from '../dist/atomic-write.js';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
afterEach(() => Object.defineProperty(process, 'platform', realPlatform));
const onPlatform = (platform) => Object.defineProperty(process, 'platform', { ...realPlatform, value: platform });

const errno = (code) => Object.assign(new Error(code), { code });

/** A rename that fails with `code` the first `failures` times. */
function flakyRename(code, failures) {
  const calls = { count: 0 };
  const renameFile = async (from, to) => {
    calls.count += 1;
    if (calls.count <= failures) throw errno(code);
    await rename(from, to);
  };
  return { calls, renameFile };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'relay-atomic-'));
  const file = join(dir, 'burrows.json');
  await writeFile(file, 'old\n');
  return { dir, file };
}

test('a rename that fails leaves the old file and no temp copy', async () => {
  const { dir, file } = await fixture();
  const { renameFile } = flakyRename('EIO', Infinity);
  await assert.rejects(replaceAtomically(file, (tmp) => writeFile(tmp, 'new\n'), renameFile), { code: 'EIO' });
  assert.equal(await readFile(file, 'utf8'), 'old\n');
  assert.deepEqual(await readdir(dir), ['burrows.json']);
});

test('on Windows a destination held for a moment is retried until the rename lands', async () => {
  onPlatform('win32');
  for (const code of ['EPERM', 'EBUSY']) {
    const { dir, file } = await fixture();
    const { calls, renameFile } = flakyRename(code, 2);
    await replaceAtomically(file, (tmp) => writeFile(tmp, 'new\n'), renameFile);
    assert.equal(calls.count, 3);
    assert.equal(await readFile(file, 'utf8'), 'new\n');
    assert.deepEqual(await readdir(dir), ['burrows.json']);
  }
});

test('on Windows a destination held for good fails after eleven tries, leaving no temp', async () => {
  onPlatform('win32');
  const { dir, file } = await fixture();
  const { calls, renameFile } = flakyRename('EPERM', Infinity);
  await assert.rejects(replaceAtomically(file, (tmp) => writeFile(tmp, 'new\n'), renameFile), { code: 'EPERM' });
  assert.equal(calls.count, 11);
  assert.deepEqual(await readdir(dir), ['burrows.json']);
});

test('elsewhere an EPERM is not retried', async () => {
  onPlatform('linux');
  const { file } = await fixture();
  const { calls, renameFile } = flakyRename('EPERM', 1);
  await assert.rejects(replaceAtomically(file, (tmp) => writeFile(tmp, 'new\n'), renameFile), { code: 'EPERM' });
  assert.equal(calls.count, 1);
});
