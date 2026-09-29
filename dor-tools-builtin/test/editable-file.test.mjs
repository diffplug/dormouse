import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, writeFile, symlink, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { readEditableFile, saveEditableFile } from '../dist/editable-file.js';
let root, file;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'dor-edit-'))); file = join(root, 'source.ts'); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test('saves the opened UTF-8 file, preserving its BOM, line endings and permissions', async () => {
  await writeFile(file, '\uFEFFone\r\ntwo\r\n', { mode: 0o640 });
  const source = await readEditableFile(file);
  assert.equal(source.text, 'one\r\ntwo\r\n');
  const saved = await saveEditableFile(file, 'changed\r\n', source.version);
  assert.equal(await readFile(file, 'utf8'), '\uFEFFchanged\r\n');
  assert.equal((await readEditableFile(file)).version, saved.version);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o640);
});
test('rejects a stale save after another editor changes or replaces the file', async () => {
  await writeFile(file, 'original');
  const source = await readEditableFile(file);
  await writeFile(file, 'external');
  await assert.rejects(saveEditableFile(file, 'ours', source.version), { status: 409 });
  assert.equal(await readFile(file, 'utf8'), 'external');
  await writeFile(join(root, 'replacement'), 'replacement');
  await rename(join(root, 'replacement'), file);
  await assert.rejects(saveEditableFile(file, 'ours', source.version), { status: 409 });
  assert.equal((await readEditableFile(file)).text, 'replacement');
});
test('refuses a substituted symlink and invalid UTF-8 without changing either file', { skip: process.platform === 'win32' }, async () => {
  await writeFile(file, 'original');
  const source = await readEditableFile(file);
  const other = join(root, 'other');
  await writeFile(other, 'private');
  await rm(file); await symlink(other, file);
  await assert.rejects(saveEditableFile(file, 'ours', source.version), { status: 409 });
  assert.equal(await readFile(other, 'utf8'), 'private');
  await rm(file); await writeFile(file, Buffer.from([255, 254, 0]));
  await assert.rejects(readEditableFile(file), { status: 415 });
});
