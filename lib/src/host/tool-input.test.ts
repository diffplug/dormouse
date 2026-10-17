import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveLocalToolTarget, resolveToolInput } from './tool-input';
import { parseToolFile } from './tool-registry';

const hostname = vi.hoisted(() => vi.fn(() => 'Dev-Box.local'));
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), hostname }));

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

  it('rejects control-bearing argument-list configuration', () => {
    const parse = (run: string | string[]) => parseToolFile(JSON.stringify({ tools: { viewer: { run } } }), { path: '/repo/dormouse.yml', dir: '/repo', scope: 'repo' });
    expect(() => parse(['viewer', 'first\nsecond'])).toThrow('terminal control characters');
    expect(() => parse(['viewer', 'a\u009b31m'])).toThrow('terminal control characters');
  });

  // A location, not text a repo wrote: the trust prompt shows its format
  // characters escaped, and a Persian folder name needs U+200C.
  it('keeps a format character an argument or a substituted path carries', async () => {
    expect((await resolveToolInput(entry, { ...context, args: ['file\u202ename'] })).run).toEqual(['viewer', 'file\u202ename']);
    expect((await resolveToolInput({ ...entry, run: ['viewer', '$CWD'] }, { ...context, cwd: '/\u067e\u0631\u0648\u0698\u0647\u200c\u0647\u0627' })).run)
      .toEqual(['viewer', '/\u067e\u0631\u0648\u0698\u0647\u200c\u0647\u0627']);
  });

  it('rejects controls in file inputs and their resolving directory', async () => {
    const targetEntry = { ...entry, run: ['viewer', '$TARGET'] };
    await expect(resolveToolInput(targetEntry, { ...context, args: ['\x15printf unwanted\n#'] })).rejects.toThrow('terminal control characters');
    await expect(resolveToolInput(targetEntry, { ...context, cwd: '/repo/\tpath', args: ['file.txt'] })).rejects.toThrow('terminal control characters');
    await expect(resolveToolInput(targetEntry, { ...context, args: ['a\u0085b.txt'] })).rejects.toThrow('terminal control characters');
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

describe('local targets', () => {
  it.skipIf(process.platform === 'win32')('accepts a regular file or a folder, canonically, and rejects every other kind', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'dor-input-kinds-')));
    try {
      await writeFile(join(dir, 'file.txt'), 'hi');
      await mkdir(join(dir, 'folder'));
      await symlink(join(dir, 'folder'), join(dir, 'alias'));
      execFileSync('mkfifo', [join(dir, 'pipe')]);
      expect(await resolveLocalToolTarget('file.txt', dir)).toEqual({ path: join(dir, 'file.txt'), directory: false });
      expect(await resolveLocalToolTarget('alias', dir)).toEqual({ path: join(dir, 'folder'), directory: true });
      await expect(resolveLocalToolTarget('pipe', dir)).rejects.toThrow('not a regular file or folder: pipe');
      await expect(resolveToolInput({ ...entry, run: ['viewer', '$TARGET'] }, { ...context, cwd: dir, args: ['alias'] }))
        .resolves.toMatchObject({ run: ['viewer', join(dir, 'folder')] });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('local file URLs', () => {
  let dir: string;
  let target: string;
  /** Resolve the `file:` URL a terminal link carries for `target`, naming `host`. */
  const openLink = (host: string) => resolveLocalToolTarget(`file://${host}${pathToFileURL(target).pathname}`, dir);
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'dor-input-urls-')));
    target = join(dir, 'my notes.md');
    await writeFile(target, 'hi');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it.each(['', 'localhost', 'dev-box.local', 'DEV-BOX.LOCAL', 'dev-box'])('resolves the decoded path of a file URL on host %j', async host => {
    expect(await openLink(host)).toEqual({ path: target, directory: false });
  });

  it('accepts this machine\'s full name when it reports only the short one', async () => {
    hostname.mockReturnValueOnce('dev-box');
    expect(await openLink('dev-box.local')).toEqual({ path: target, directory: false });
  });

  it.each(['elsewhere.example', 'dev-box.example', '127.0.0.1'])('refuses a file URL on host %j', async host => {
    await expect(openLink(host)).rejects.toThrow('not a file on this machine');
  });

  it.each(['https://dev-box.local/x', 'surface:3'])('refuses %s, which is not a file URL', async input => {
    await expect(resolveLocalToolTarget(input, dir)).rejects.toThrow('expected a local path or file: URL');
  });

  it.each([
    ['whose error would echo it', `${'x'.repeat(300)}%1b]0;pwn%07`],
    ['that does not exist', 'notes%1b[2J.md'],
    ['with an encoded NUL', 'notes%00.md'],
  ])('refuses a file URL decoding to terminal controls, %s', async (_, name) => {
    const error = await resolveLocalToolTarget(`${pathToFileURL(dir).href}/${name}`, dir).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('local paths cannot contain terminal control characters');
  });
});
