
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { beforeEach, afterEach, test } from 'node:test';
import { saveFileOperations } from '../dist/atomic-save.js';
import { readEditableFile, saveEditableFile } from '../dist/editable-file.js';
let root, file;
beforeEach(async () => { root=await realpath(await mkdtemp(join(tmpdir(),'dor-save-platform-'))); file=join(root,'source.txt'); await writeFile(file,'original'); });
afterEach(async () => { await rm(root,{recursive:true,force:true}); });

test('a native staging collision leaves the existing object intact', { skip:process.platform!=='win32' }, async () => {
  const stage=join(root,'stage'); await writeFile(stage,'existing');
  await assert.rejects(saveFileOperations.createSibling(file,stage), /Unable to prepare/);
  assert.equal(await readFile(stage,'utf8'),'existing');
  assert.equal(await readFile(file,'utf8'),'original');
});

test('a native setup error after exclusive stage creation removes only that owned stage', { skip:process.platform!=='win32' }, async () => {
  await assert.rejects(saveFileOperations.createSibling(join(root,'missing'),join(root,'stage')), /Unable to prepare/);
  assert.deepEqual(await readdir(root),['source.txt']);
  assert.equal(await readFile(file,'utf8'),'original');
});

test('a native replacement sharing failure preserves the old file and retains its private recovery stage', { skip:process.platform!=='win32', timeout:15000 }, async () => {
  const source=await readEditableFile(file);
  const script='$ErrorActionPreference="Stop"; $f=[IO.File]::Open($env:DORMOUSE_LOCK_TEST_TARGET,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); [Console]::Out.WriteLine("ready"); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $f.Dispose()';
  const binary=win32.join(process.env.SystemRoot||process.env.SYSTEMROOT||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const child=spawn(binary,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,DORMOUSE_LOCK_TEST_TARGET:file},stdio:['pipe','pipe','pipe'],windowsHide:true});
  const exited=once(child,'exit');
  try {
    await Promise.race([once(child.stdout,'data'),exited.then(()=>{throw new Error('lock helper exited');})]);
    await assert.rejects(saveEditableFile(file,'new',source.version), /could not be confirmed/);
    assert.equal(await readFile(file,'utf8'),'original');
    const stages=(await readdir(root)).filter(name=>name.startsWith('.dor-save-'));
    assert.equal(stages.length,1);
    assert.equal(await readFile(join(root,stages[0],'content'),'utf8'),'new');
  } finally { child.stdin.end('\n'); await exited; }
});


for (const partial of ['target-missing', 'committed-without-confirmation']) {
  test('retains both versions after a native-like ' + partial + ' replacement outcome', { skip:process.platform!=='win32' }, async () => {
    const source=await readEditableFile(file);
    let stage;
    await assert.rejects(saveEditableFile(file,'new',source.version,{
      ...saveFileOperations,
      async replace(temporary,target) {
        stage=dirname(temporary);
        await rename(target,join(stage,'original'));
        if (partial==='committed-without-confirmation') await rename(temporary,target);
        throw new Error('native partial replacement or lost completion');
      },
    }),error=>error.status===500&&error.message.includes(stage));
    assert.equal(await readFile(join(stage,'original'),'utf8'),'original');
    if (partial==='target-missing') {
      await assert.rejects(readFile(file),{code:'ENOENT'});
      assert.equal(await readFile(join(stage,'content'),'utf8'),'new');
    } else assert.equal(await readFile(file,'utf8'),'new');
    assert.ok((await readdir(root)).includes(stage.split(/[\\/]/).at(-1)));
  });
}
