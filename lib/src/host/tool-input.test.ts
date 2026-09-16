import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveToolInput } from './tool-input';
import { parseToolFile } from './tool-registry';

const context = { cwd: '/repo', projectRoot: '/repo', args: [] as string[] };
const entry = { name: 'viewer', run: ['viewer', '$ARGS'], dedupeTemplate: null };

describe('Tool argv safety', () => {
  it.each([...Array.from({ length: 32 }, (_, code) => code), 127])('rejects terminal control byte %i before quoting', async code => {
    await expect(resolveToolInput(entry, { ...context, args: [`file${String.fromCharCode(code)}name`] }))
      .rejects.toThrow('terminal control characters');
  });

  it('rejects controls introduced by directory substitutions', async () => {
    await expect(resolveToolInput({ ...entry, run: ['viewer', '$CWD'] }, { ...context, cwd: '/repo/\x15printf unwanted\n#' }))
      .rejects.toThrow('terminal control characters');
    await expect(resolveToolInput({ ...entry, run: ['viewer', '$PROJECT_ROOT'] }, { ...context, projectRoot: '/repo/\x1b[2J' }))
      .rejects.toThrow('terminal control characters');
  });

  it('rejects control-bearing argument-list configuration but preserves literal shell scripts', () => {
    const parse = (run: string | string[]) => parseToolFile(JSON.stringify({ tools: { viewer: { run } } }), { path: '/repo/dormouse.yml', dir: '/repo', scope: 'repo' });
    expect(() => parse(['viewer', 'first\nsecond'])).toThrow('terminal control characters');
    expect(parse('echo first\necho second').tools.get('viewer')?.run).toBe('echo first\necho second');
  });

  it('rejects controls in file inputs and their resolving directory', async () => {
    const targetEntry = { ...entry, run: ['viewer', '$TARGET'] };
    await expect(resolveToolInput(targetEntry, { ...context, args: ['\x15printf unwanted\n#'] })).rejects.toThrow('terminal control characters');
    await expect(resolveToolInput(targetEntry, { ...context, cwd: '/repo/\tpath', args: ['file.txt'] })).rejects.toThrow('terminal control characters');
  });

  it.skipIf(process.platform === 'win32')('rejects controls hidden behind an ordinary symlink name', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'dor-input-controls-')));
    try {
      const target = join(dir, '\x15printf unwanted\n#');
      await writeFile(target, 'ordinary document');
      await symlink(target, join(dir, 'safe-name.txt'));
      await expect(resolveToolInput({ ...entry, run: ['viewer', '$TARGET'] }, { ...context, cwd: dir, args: ['safe-name.txt'] }))
        .rejects.toThrow('terminal control characters');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
