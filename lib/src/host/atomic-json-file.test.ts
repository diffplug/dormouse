import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const probe = vi.hoisted(() => ({ failures: 0, attempts: 0, code: 'EPERM' }));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      probe.attempts++;
      if (probe.failures-- > 0) throw Object.assign(new Error('rename refused'), { code: probe.code });
      return real.rename(from, to);
    },
  };
});
import { writeJsonAtomic } from './atomic-json-file';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dor-atomic-json-'));
  probe.failures = 0; probe.attempts = 0; probe.code = 'EPERM';
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

it('retries brief Windows sharing failures without exposing partial JSON', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  const file = join(dir, 'state.json');
  await writeFile(file, 'old');
  probe.failures = 2;
  await writeJsonAtomic(dir, file, { committed: true });
  expect(probe.attempts).toBe(3);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ committed: true });
  expect(await readdir(dir)).toEqual(['state.json']);
});

it('bounds persistent Windows sharing failure, preserves prior bytes, and removes the temporary secret', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  const file = join(dir, 'state.json');
  await writeFile(file, 'old');
  probe.failures = Infinity;
  await expect(writeJsonAtomic(dir, file, { secret: true })).rejects.toMatchObject({ code: 'EPERM' });
  expect(probe.attempts).toBe(11);
  expect(await readFile(file, 'utf8')).toBe('old');
  expect(await readdir(dir)).toEqual(['state.json']);
});

for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'EIO']]) {
  it(`does not retry ${platform} ${code}`, async () => {
    vi.stubGlobal('process', { ...process, platform });
    const file = join(dir, 'state.json');
    await writeFile(file, 'old');
    probe.failures = 1; probe.code = code;
    await expect(writeJsonAtomic(dir, file, { secret: true })).rejects.toMatchObject({ code });
    expect(probe.attempts).toBe(1);
    expect(await readFile(file, 'utf8')).toBe('old');
    expect(await readdir(dir)).toEqual(['state.json']);
  });
}
