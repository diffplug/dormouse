// @vitest-environment node
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBinaryPath, spawnAndCapture } from 'dor-lib-common';
import { browserLaunchEnv, browserShellInvocation } from './browser-launch-env';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
describe.skipIf(!existsSync('/bin/zsh'))('fresh browser shell', () => {
  async function fixture(startup: string) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dor launch ' "));
    roots.push(dir);
    const cli = path.join(dir, 'helper.cjs');
    await writeFile(cli, `delete process.env.ELECTRON_RUN_AS_NODE; process.stdout.write('\\n' + process.argv[3] + ':' + Buffer.from(JSON.stringify(process.env)).toString('base64') + '\\n');`);
    await writeFile(path.join(dir, '.zshrc'), startup);
    return { dir, runtime: { shell: '/bin/zsh', node: process.execPath, cli }, env: { HOME: dir, ZDOTDIR: dir, PATH: '/usr/bin:/bin' } };
  }
  it('loads interactive startup in the source cwd and supplies PATH to shebang CLIs', async () => {
    const f = await fixture('echo startup-chatter\nexport PATH="$HOME:$PATH"\nexport BROWSER_START_CWD="$PWD"\nexport BROWSER_TEST_SECRET=private-value\n');
    await symlink(process.execPath, path.join(f.dir, 'node'));
    const binary = path.join(f.dir, 'agent-browser');
    await writeFile(binary, '#!/usr/bin/env node\nprocess.stdout.write(process.env.BROWSER_START_CWD);');
    await chmod(binary, 0o755);
    const env = await browserLaunchEnv(f.dir, f.runtime, f.env);
    expect(env.BROWSER_TEST_SECRET).toBe('private-value');
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(resolveBinaryPath('agent-browser', f.env)).toBeUndefined();
    expect(resolveBinaryPath('agent-browser', env)).toBe(binary);
    expect(await spawnAndCapture(binary, [], { cwd: f.dir, env })).toMatchObject({ ok: true, exitCode: 0, stdout: env.BROWSER_START_CWD });
    expect(env.BROWSER_START_CWD).toContain("dor launch ' ");
  });
  it('reports startup failure without disclosing shell output', async () => {
    const f = await fixture('echo secret-on-stdout\necho secret-on-stderr >&2\nexit 2\n');
    await expect(browserLaunchEnv(f.dir, f.runtime, f.env)).rejects.toThrow(/^Browser launch shell failed \(\/bin\/zsh\); check its startup configuration$/);
  });
  it('rejects a shell which exits without running the helper', async () => {
    const f = await fixture('exit 0\n');
    await expect(browserLaunchEnv(f.dir, f.runtime, f.env)).rejects.toThrow('did not return its environment');
  });
});

describe('configured browser launch shells', () => {
  const runtime = { node: 'C:\\node.exe', cli: 'C:\\dor.js' };
  const argv = [runtime.node, runtime.cli, '__launch-env', 'marker'];
  it('uses a native Windows shell for a WSL selection', () => {
    const result = browserShellInvocation({ ...runtime, shell: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'] }, argv, { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' }, 'win32');
    expect(result.shell).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(result.args).not.toContain('Ubuntu');
    expect(result.args.slice(0, 2)).toEqual(['/s', '/c']);
  });
  it('runs Developer Command Prompt initialization before the helper and exits', () => {
    const result = browserShellInvocation({ ...runtime, shell: 'cmd.exe', args: ['/k', 'C:\\Program Files\\VS\\VsDevCmd.bat'] }, argv, {}, 'win32');
    expect(result.args).toEqual(['/s', '/c', '"call "C:\\Program Files\\VS\\VsDevCmd.bat" && "C:\\node.exe" "C:\\dor.js" "__launch-env" "marker""']);
  });
  it('preserves Developer PowerShell initialization without NoExit', () => {
    const setup = '& { Import-Module "C:\\Program Files\\VS\\Launch-VsDevShell.ps1" }';
    const result = browserShellInvocation({ ...runtime, shell: 'pwsh.exe', args: ['-NoExit', '-Command', setup] }, argv, {}, 'win32');
    expect(result.args).toEqual(['-NonInteractive', '-Command', `${setup}; if ($?) { C:\\node.exe C:\\dor.js __launch-env marker }`]);
  });
  it('preserves POSIX initialization flags', () => {
    const result = browserShellInvocation({ ...runtime, shell: '/bin/bash', args: ['--login', '-i'] }, ['/node', '/dor.js', '__launch-env', 'marker'], {}, 'linux');
    expect(result.args).toEqual(['--login', '-i', '-c', '/node /dor.js __launch-env marker']);
  });
});

// Real cmd.exe and PowerShell cold starts on CI runners exceed Vitest's 5 s default.
describe.skipIf(process.platform !== 'win32')('native Windows browser shell', { timeout: 30_000 }, () => {
  async function fixture() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dor launch spaces & '));
    roots.push(dir);
    const cli = path.join(dir, 'helper.cjs');
    await writeFile(cli, `delete process.env.ELECTRON_RUN_AS_NODE; process.stdout.write('\\n' + process.argv[3] + ':' + Buffer.from(JSON.stringify(process.env)).toString('base64') + '\\n');`);
    return { dir, runtime: { node: process.execPath, cli } };
  }
  it('runs the helper through actual cmd.exe with quoted paths', async () => {
    const f = await fixture();
    const env = await browserLaunchEnv(f.dir, f.runtime, { ...process.env, DOR_SHELL_TEST: 'native-cmd' });
    expect(env.DOR_SHELL_TEST).toBe('native-cmd');
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
  it('runs Developer Command Prompt initialization before the helper', async () => {
    const f = await fixture();
    const setup = path.join(f.dir, 'developer setup.cmd');
    await writeFile(setup, '@echo off\r\necho startup chatter\r\nset "DOR_SHELL_TEST=developer-cmd"\r\n');
    const env = await browserLaunchEnv(f.dir, { ...f.runtime, args: ['/k', setup] });
    expect(env.DOR_SHELL_TEST).toBe('developer-cmd');
  });
  it('runs native PowerShell startup code and exits', async () => {
    const f = await fixture();
    const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const env = await browserLaunchEnv(f.dir, { ...f.runtime, shell, args: ['-NoProfile', '-NoExit', '-Command', "$env:DOR_SHELL_TEST = 'developer-powershell'"] });
    expect(env.DOR_SHELL_TEST).toBe('developer-powershell');
  });
});
