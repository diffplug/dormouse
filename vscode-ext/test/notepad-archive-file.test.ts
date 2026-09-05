import { fork } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import ts from 'typescript';
import { ARCHIVE_FILE, withArchiveFile } from '../src/notepad-archive-file';

let dir: string;
let worker: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'notepad-process-'));
  // Run the shipped transaction implementation in independent Node processes.
  const source = await readFile(new URL('../src/notepad-archive-file.ts', import.meta.url), 'utf8');
  await writeFile(join(dir, 'store.mjs'), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText);
  worker = join(dir, 'worker.mjs');
  await writeFile(worker, `
    import { withArchiveFile } from './store.mjs';
    process.on('message', async ({ dir, kind, revision, value }) => {
      try {
        const result = await withArchiveFile(dir, () => undefined, async (store) => {
          if (kind === 'crash') process.exit(0);
          if (kind === 'load') return { raw: store.raw, revision: store.revision };
          if (kind === 'save' && revision !== store.revision) return 'conflict';
          const next = kind === 'append' ? [...JSON.parse(store.raw ?? '[]'), value] : value;
          await new Promise(resolve => setTimeout(resolve, 40));
          await store.write(JSON.stringify(next));
          return 'ok';
        });
        process.send({ result });
      } catch (error) { process.send({ error: String(error) }); }
    });
  `);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function request(kind: string, value?: unknown, revision?: string | null): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = fork(worker, { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    let response: any;
    child.on('error', reject);
    child.on('message', (message) => { response = message; child.disconnect(); });
    child.on('exit', (code) => {
      if (code !== 0 || response?.error) reject(new Error(response?.error ?? `exit ${code}`));
      else resolve(response?.result);
    });
    child.send({ dir, kind, value, revision });
  });
}

it('rejects a stale save from an independent extension host', async () => {
  const [a, b] = await Promise.all([request('load'), request('load')]);
  expect(a.revision).toBe(b.revision);
  const outcomes = await Promise.all([
    request('save', ['a'], a.revision), request('save', ['b'], b.revision),
  ]);
  expect(outcomes.sort()).toEqual(['conflict', 'ok']);
  expect(JSON.parse((await request('load')).raw)).toHaveLength(1);
});

it('preserves concurrent teardown mutations from independent extension hosts', async () => {
  await Promise.all([request('append', 'a'), request('append', 'b'), request('append', 'c')]);
  expect(JSON.parse((await request('load')).raw).sort()).toEqual(['a', 'b', 'c']);
  if (process.platform !== 'win32') expect((await stat(join(dir, ARCHIVE_FILE))).mode & 0o777).toBe(0o600);
});

it('recovers a lock left by a terminated extension host', async () => {
  await request('crash');
  expect(await request('append', 'after-crash')).toBe('ok');
});

it('imports legacy data once and never resurrects a stale cache after recovery', async () => {
  await withArchiveFile(dir, () => 'legacy', async (storage) => {
    expect(storage.raw).toBe('legacy');
    await storage.reset();
  });
  await withArchiveFile(dir, () => 'stale legacy', async (storage) => {
    expect(storage.raw).toBeUndefined();
  });
});
