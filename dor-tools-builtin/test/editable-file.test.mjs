import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, writeFile, symlink, rename, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { readEditableFile, saveEditableFile } from '../dist/editable-file.js';
import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';
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

test('a save takes the file\'s majority line ending, whatever the editor sent', async () => {
  await writeFile(file, 'a\r\nb\r\nc\n');
  await saveEditableFile(file, 'x\ny\r\nz\n', (await readEditableFile(file)).version);
  assert.equal(await readFile(file, 'utf8'), 'x\r\ny\r\nz\r\n');
  await writeFile(file, 'a\nb\r\nc\n');
  await saveEditableFile(file, 'x\r\ny\n', (await readEditableFile(file)).version);
  assert.equal(await readFile(file, 'utf8'), 'x\ny\n');
  await writeFile(file, 'one line');
  await saveEditableFile(file, 'x\r\ny', (await readEditableFile(file)).version);
  assert.equal(await readFile(file, 'utf8'), 'x\r\ny');
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
  const source = await readEditableFile(file);
  await saveEditableFile(file, 'saved', source.version);
  assert.equal(await readFile(file, 'utf8'), 'saved');
  assert.equal(security(file), before);
  assert.deepEqual(await readdir(root), ["source' $literal.ts"]);
});

test('a replacement failure preserves prior bytes and permissions and retains the draft', async () => {
  await writeFile(file, 'original');
  const source = await readEditableFile(file);
  const before = process.platform === 'win32' ? security(file) : (await stat(file)).mode;
  await assert.rejects(saveEditableFile(file, 'new', source.version, {
    replace: async () => { throw new Error('replacement refused'); },
  }), /could not be confirmed/);
  assert.equal(await readFile(file, 'utf8'), 'original');
  assert.equal(process.platform === 'win32' ? security(file) : (await stat(file)).mode, before);
  assert.equal((await readdir(root)).filter(name => name.startsWith('.dor-save-')).length, 1);
});
