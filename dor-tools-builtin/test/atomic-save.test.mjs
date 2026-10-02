import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { beforeEach, afterEach, test } from 'node:test';
import { saveFileOperations, windowsReplaceCommand } from '../dist/atomic-save.js';
import { readEditableFile, saveEditableFile } from '../dist/editable-file.js';
let root, file;
beforeEach(async () => { root=await realpath(await mkdtemp(join(tmpdir(),'dor-save-platform-'))); file=join(root,'source.txt'); await writeFile(file,'original'); });
afterEach(async () => { await rm(root,{recursive:true,force:true}); });

test('the Windows replacement passes paths as environment data, never script text', () => {
  const [temporary,target,backup]=["C:\\d\\.dor-save-1.tmp","C:\\d\\it's $(calc).txt","C:\\d\\.dor-save-1.orig"];
  const command=windowsReplaceCommand(temporary,target,backup);
  assert.match(command.file,/System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.deepEqual(command.args.slice(0,4),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand']);
  const script=Buffer.from(command.args[4],'base64').toString('utf16le');
  assert.match(script,/\[IO\.File\]::Replace\(\$env:DORMOUSE_SAVE_SIBLING, \$env:DORMOUSE_SAVE_TARGET, \$env:DORMOUSE_SAVE_BACKUP, \$false\)$/);
  assert.ok(!script.includes('calc'));
  assert.equal(command.env.DORMOUSE_SAVE_SIBLING,temporary);
  assert.equal(command.env.DORMOUSE_SAVE_TARGET,target);
  assert.equal(command.env.DORMOUSE_SAVE_BACKUP,backup);
});

const saveFiles=async()=>(await readdir(root)).filter(name=>name.startsWith('.dor-save-'));

test('a native replacement sharing failure preserves the old file and retains the draft', { skip:process.platform!=='win32', timeout:15000 }, async () => {
  const source=await readEditableFile(file);
  const script='$ErrorActionPreference="Stop"; $f=[IO.File]::Open($env:DORMOUSE_LOCK_TEST_TARGET,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); [Console]::Out.WriteLine("ready"); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $f.Dispose()';
  const binary=win32.join(process.env.SystemRoot||process.env.SYSTEMROOT||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const child=spawn(binary,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,DORMOUSE_LOCK_TEST_TARGET:file},stdio:['pipe','pipe','pipe'],windowsHide:true});
  const exited=once(child,'exit');
  try {
    await Promise.race([once(child.stdout,'data'),exited.then(()=>{throw new Error('lock helper exited');})]);
    await assert.rejects(saveEditableFile(file,'new',source.version), /could not be confirmed/);
    assert.equal(await readFile(file,'utf8'),'original');
    const drafts=(await saveFiles()).filter(name=>name.endsWith('.tmp'));
    assert.equal(drafts.length,1);
    assert.equal(await readFile(join(root,drafts[0]),'utf8'),'new');
  } finally { child.stdin.end('\n'); await exited; }
});

for (const partial of ['target-missing', 'committed-without-confirmation']) {
  test('retains both versions after a native-like ' + partial + ' replacement outcome', async () => {
    const source=await readEditableFile(file);
    let draft, original;
    await assert.rejects(saveEditableFile(file,'new',source.version,{
      async replace(temporary,target,backup) {
        draft=temporary; original=backup;
        await rename(target,backup);
        if (partial==='committed-without-confirmation') await rename(temporary,target);
        throw new Error('native partial replacement or lost completion');
      },
    }),error=>error.status===500&&error.message.includes(draft));
    assert.equal(await readFile(original,'utf8'),'original');
    if (partial==='target-missing') {
      await assert.rejects(readFile(file),{code:'ENOENT'});
      assert.equal(await readFile(draft,'utf8'),'new');
    } else assert.equal(await readFile(file,'utf8'),'new');
    assert.equal((await saveFiles()).length,partial==='target-missing'?2:1);
  });
}

test('a confirmed replacement removes the draft and the backup', async () => {
  const source=await readEditableFile(file);
  await saveEditableFile(file,'new',source.version,{
    async replace(temporary,target,backup) { await rename(target,backup); await rename(temporary,target); },
  });
  assert.equal(await readFile(file,'utf8'),'new');
  assert.deepEqual(await saveFiles(),[]);
});
