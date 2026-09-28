// @vitest-environment node
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBinaryPath, spawnAndCapture } from 'dor-lib-common';
import { browserLaunchEnv } from './browser-launch-env';
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
