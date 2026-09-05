/** Shared archive transactions; globalState is only the legacy migration source. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const ARCHIVE_FILE = 'notepad-archive.json';

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * Publish a NONEMPTY directory atomically to acquire the lock. Every owner has
 * a unique filename; releasing/reaping unlinks only that filename then rmdirs
 * an empty directory. A delayed reaper cannot remove a replacement owner's
 * nonempty directory. Never evict a live process on a timer (a paused host may
 * still complete its write). PID reuse can delay recovery, never split the lock.
 */
async function acquire(dir: string): Promise<() => Promise<void>> {
  const lock = join(dir, `${ARCHIVE_FILE}.lock`);
  const owner = `${process.pid}-${randomUUID()}`;
  const candidate = join(dir, `${ARCHIVE_FILE}.lock-${owner}`);
  await mkdir(candidate, { mode: 0o700 });
  await writeFile(join(candidate, owner), '', { mode: 0o600 });
  const deadline = Date.now() + 2_000;
  try {
    for (;;) {
      try {
        await rename(candidate, lock);
        return async () => {
          await unlink(join(lock, owner));
          await rmdir(lock).catch((error) => {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code(error) ?? '')) throw error;
          });
        };
      } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'].includes(code(error) ?? '')) throw error;
      }
      const owners = await readdir(lock).catch((error) => {
        if (code(error) === 'ENOENT') return [];
        throw error;
      });
      for (const name of owners) {
        const match = /^(\d+)-[a-f0-9-]+$/.exec(name);
        if (!match) continue;
        try { process.kill(Number(match[1]), 0); } catch (error) {
          if (code(error) !== 'ESRCH') continue;
          await unlink(join(lock, name)).catch((error) => {
            if (code(error) !== 'ENOENT') throw error;
          });
        }
      }
      await rmdir(lock).catch((error) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code(error) ?? '')) throw error;
      });
      if (Date.now() >= deadline) throw new Error('The notepad archive is busy. Try again.');
      await delay(20);
    }
  } finally {
    await unlink(join(candidate, owner)).catch((error) => {
      if (code(error) !== 'ENOENT') throw error;
    });
    await rmdir(candidate).catch((error) => {
      if (code(error) !== 'ENOENT') throw error;
    });
  }
}

async function atomicWrite(path: string, bytes: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (code(error) !== 'ENOENT') throw error;
    });
  }
}

export interface ArchiveStorage {
  raw: string | undefined;
  revision: string | null;
  write(raw: string): Promise<void>;
  reset(): Promise<void>;
}

export async function withArchiveFile<T>(
  dir: string,
  legacy: () => string | undefined,
  operation: (storage: ArchiveStorage) => Promise<T>,
): Promise<T> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const release = await acquire(dir);
  try {
    const path = join(dir, ARCHIVE_FILE);
    const encode = (raw: string | undefined) => JSON.stringify({ revision: randomUUID(), raw: raw ?? null });
    let bytes: string;
    try { bytes = await readFile(path, 'utf8'); } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
      // Even an absent legacy entry becomes a tombstone, so a stale globalState
      // cache cannot resurrect it after a recovery in another extension host.
      bytes = encode(legacy());
      await atomicWrite(path, bytes);
    }
    let raw: string | undefined = bytes;
    try {
      const envelope = JSON.parse(bytes);
      if (envelope && typeof envelope.revision === 'string'
        && (typeof envelope.raw === 'string' || envelope.raw === null)
        && Object.keys(envelope).length === 2) raw = envelope.raw ?? undefined;
    } catch { /* Expose corrupt storage to the ordinary unreadable recovery UI. */ }
    return await operation({
      raw,
      revision: raw === undefined ? null : createHash('sha256').update(bytes).digest('hex'),
      write: (next) => atomicWrite(path, encode(next)),
      reset: async () => {
        await atomicWrite(`${path}.unreadable-${randomUUID()}`, bytes);
        await atomicWrite(path, encode(undefined));
      },
    });
  } finally {
    await release();
  }
}
