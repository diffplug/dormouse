import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, writeFile, symlink, rename, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { editorStore } from '../dist/editor-store.js';
import { readText, saveText } from '../dist/editor-routes.js';
import { IMAGE_BOUND } from '../dist/image-format.js';
import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';
let root, file;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'dor-edit-'))); file = join(root, 'source.ts'); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test('saves the opened UTF-8 file, preserving its BOM, line endings and permissions', async () => {
  await writeFile(file, '\uFEFFone\r\ntwo\r\n', { mode: 0o640 });
  const source = await readText(editorStore(root), file);
  assert.equal(source.text, 'one\r\ntwo\r\n');
  const saved = await saveText(editorStore(root), file, 'changed\r\n', source.version);
  assert.equal(await readFile(file, 'utf8'), '\uFEFFchanged\r\n');
  assert.equal((await readText(editorStore(root), file)).version, saved.version);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o640);
});

test('a save takes the file\'s majority line ending, whatever the editor sent', async () => {
  await writeFile(file, 'a\r\nb\r\nc\n');
  await saveText(editorStore(root), file, 'x\ny\r\nz\n', (await readText(editorStore(root), file)).version);
  assert.equal(await readFile(file, 'utf8'), 'x\r\ny\r\nz\r\n');
  await writeFile(file, 'a\nb\r\nc\n');
  await saveText(editorStore(root), file, 'x\r\ny\n', (await readText(editorStore(root), file)).version);
  assert.equal(await readFile(file, 'utf8'), 'x\ny\n');
  await writeFile(file, 'one line');
  await saveText(editorStore(root), file, 'x\r\ny', (await readText(editorStore(root), file)).version);
  assert.equal(await readFile(file, 'utf8'), 'x\r\ny');
});

test('rejects a stale save after another editor changes or replaces the file', async () => {
  await writeFile(file, 'original');
  const source = await readText(editorStore(root), file);
  await writeFile(file, 'external');
  await assert.rejects(saveText(editorStore(root), file, 'ours', source.version), { status: 409 });
  assert.equal(await readFile(file, 'utf8'), 'external');
  await writeFile(join(root, 'replacement'), 'replacement');
  await rename(join(root, 'replacement'), file);
  await assert.rejects(saveText(editorStore(root), file, 'ours', source.version), { status: 409 });
  assert.equal((await readText(editorStore(root), file)).text, 'replacement');
});
test('refuses a substituted symlink and invalid UTF-8 without changing either file', { skip: process.platform === 'win32' }, async () => {
  await writeFile(file, 'original');
  const source = await readText(editorStore(root), file);
  const other = join(root, 'other');
  await writeFile(other, 'private');
  await rm(file); await symlink(other, file);
  await assert.rejects(saveText(editorStore(root), file, 'ours', source.version), { status: 409 });
  assert.equal(await readFile(other, 'utf8'), 'private');
  await rm(file); await writeFile(file, Buffer.from([255, 254, 0]));
  await assert.rejects(readText(editorStore(root), file), { status: 415 });
});

test('refuses a file substituted by a link to a share without following it', { skip: process.platform === 'win32' }, async () => {
  await writeFile(file, 'original');
  const source = await readText(editorStore(root), file);
  // POSIX reads `//<root>/missing` as a missing local file: following it would fail
  // with ENOENT, not the refusal.
  await rm(file); await symlink(`/${join(root, 'missing')}`, file);
  await assert.rejects(readText(editorStore(root), file), { status: 409 });
  await assert.rejects(saveText(editorStore(root), file, 'ours', source.version), { status: 409 });
});


test('saves exact bytes, with no text handling, under the caller\'s bound', async () => {
  // A BOM-less body after a BOM, and CRLF after LF: text saves would rewrite both.
  file = join(root, 'shot.png');
  await writeFile(file, Buffer.from('\uFEFFa\nb\n'));
  const source = await editorStore(root).read(file, IMAGE_BOUND);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
  const saved = await editorStore(root).replace(file, source.version, IMAGE_BOUND, () => bytes);
  assert.ok((await readFile(file)).equals(bytes));
  assert.equal((await editorStore(root).read(file, IMAGE_BOUND)).version, saved.version);
  await assert.rejects(editorStore(root).replace(file, source.version, IMAGE_BOUND, () => bytes), { status: 409 });
  await assert.rejects(editorStore(root).replace(file, saved.version, { limit: 8, message: 'small' }, () => Buffer.alloc(9)), { status: 413, message: 'small' });
  assert.ok((await readFile(file)).equals(bytes));
});

test('reads an image up to 32 MiB, where text stops at 8', async () => {
  await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(readText(editorStore(root), file), { status: 413 });
  assert.equal((await editorStore(root).read(file, IMAGE_BOUND)).bytes.length, 8 * 1024 * 1024 + 1);
  await writeFile(file, Buffer.alloc(IMAGE_BOUND.limit + 1));
  await assert.rejects(editorStore(root).read(file, IMAGE_BOUND), { status: 413 });
});

function powershell(script, target) {
  const binary = win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return execFileSync(binary, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('$ErrorActionPreference="Stop"; $ProgressPreference="SilentlyContinue"; ' + script, 'utf16le').toString('base64')], {
    env: { ...process.env, DORMOUSE_PERMISSION_TEST_TARGET: target }, encoding: 'utf8', windowsHide: true, timeout: 10_000,
  }).trim();
}
// Compare protection and ACEs; Windows may reserialize the cosmetic AI flag.
const security = target => powershell('$acl=[IO.File]::GetAccessControl($env:DORMOUSE_PERMISSION_TEST_TARGET); [pscustomobject]@{ protected=$acl.AreAccessRulesProtected; rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{ sid=$_.IdentityReference.Value; rights=[int]$_.FileSystemRights; type=[int]$_.AccessControlType; inherited=$_.IsInherited; inheritance=[int]$_.InheritanceFlags; propagation=[int]$_.PropagationFlags } }) } | ConvertTo-Json -Depth 4 -Compress', target);

for (const broad of [false, true]) test('Windows saves preserve ' + (broad ? 'shared' : 'owner-only') + ' document permissions', { skip: process.platform !== 'win32' }, async () => {
  file = join(root, "source' $literal.ts");
  await writeFile(file, 'original');
  powershell('$p=$env:DORMOUSE_PERMISSION_TEST_TARGET; $acl=[IO.File]::GetAccessControl($p); $acl.SetAccessRuleProtection($true,$false); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,"FullControl","Allow")); [IO.File]::SetAccessControl($p,$acl)', file);
  if (broad) powershell('$p=$env:DORMOUSE_PERMISSION_TEST_TARGET; $acl=[IO.File]::GetAccessControl($p); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new("S-1-1-0"),"Read","Allow")); [IO.File]::SetAccessControl($p,$acl)', file);
  const before = security(file);
  const source = await readText(editorStore(root), file);
  await saveText(editorStore(root), file, 'saved', source.version);
  assert.equal(await readFile(file, 'utf8'), 'saved');
  assert.equal(security(file), before);
  assert.deepEqual(await readdir(root), ["source' $literal.ts"]);
});

test('a replacement failure preserves prior bytes and permissions and retains the draft', async () => {
  await writeFile(file, 'original');
  const source = await readText(editorStore(root), file);
  const before = process.platform === 'win32' ? security(file) : (await stat(file)).mode;
  await assert.rejects(saveText(editorStore(root, {
    replace: async () => { throw new Error('replacement refused'); },
  }), file, 'new', source.version), /could not be confirmed/);
  assert.equal(await readFile(file, 'utf8'), 'original');
  assert.equal(process.platform === 'win32' ? security(file) : (await stat(file)).mode, before);
  assert.equal((await readdir(root)).filter(name => name.startsWith('.dor-save-')).length, 1);
});
