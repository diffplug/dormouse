import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecoveryStore, RECOVERY_MAX_AGE_MS } from './recovery-store';
import * as privatePaths from './private-path';
import { readAcl, seedEveryoneRead } from './private-path.test-utils';

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, unlinkSync: vi.fn(real.unlinkSync) };
});

let dir: string;
const messages: string[] = [];
const log = {
  info: (message: string) => messages.push(`info ${message}`),
  error: (message: string) => messages.push(`error ${message}`),
};

const file = () => join(dir, 'recovery.json');
const read = () => JSON.parse(fs.readFileSync(file(), 'utf8')) as { createdAt: number; commands: Record<string, string> };
const write = (payload: unknown) => fs.writeFileSync(file(), JSON.stringify(payload), 'utf8');

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'dormouse-recovery-'));
  messages.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('recovery store', () => {
  describe('capture', () => {
    it('replaces the previous record on the first beginCapture and merges after', () => {
      write({ createdAt: Date.now(), commands: { old: 'claude --continue' } });

      const store = createRecoveryStore(dir, { log });
      store.beginCapture();
      // The stale record is gone before anything can be detected, so a teardown
      // that captures nothing cannot carry it forward.
      expect(fs.existsSync(file())).toBe(false);

      store.record('a', 'claude --resume A');
      expect(read().commands).toEqual({ a: 'claude --resume A' });

      // A second capture in the same process (another window) merges.
      store.beginCapture();
      store.record('b', 'codex resume B');
      expect(read().commands).toEqual({ a: 'claude --resume A', b: 'codex resume B' });
    });

    it('writes the record and its directory owner-only', () => {
      const store = createRecoveryStore(dir, { log });
      store.beginCapture();
      store.record('a', 'claude --continue');
      const mode = (path: string) => fs.statSync(path).mode & 0o777;
      if (process.platform === 'win32') {
        const acl = readAcl(file());
        expect(acl.rules).toEqual([{ sid: acl.currentUser, rights: 0x001F01FF, allow: true, inheritance: 0 }]);
      } else {
        expect(mode(dir)).toBe(0o700);
        expect(mode(file())).toBe(0o600);
      }
      // The temp sibling is renamed over the target, so nothing torn is left.
      expect(fs.readdirSync(dir)).toEqual(['recovery.json']);
    });

    it('does not throw when the record cannot be written', () => {
      // A file where the state directory should be: `mkdirSync` cannot make it.
      const blocked = join(dir, 'blocked');
      fs.writeFileSync(blocked, 'not a directory', 'utf8');
      const store = createRecoveryStore(blocked, { log });
      store.beginCapture();
      expect(() => store.record('a', 'claude --continue')).not.toThrow();
      expect(messages.some((message) => message.startsWith('error [recovery] write failed'))).toBe(true);
      // Nothing was captured, so nothing can be claimed either.
      expect(store.take(['a'])).toEqual({});
    });

    it('leaves no temp behind when the rename onto the record fails', () => {
      // A directory where the record should be: the temp is written, the rename
      // over it cannot succeed. A fixed `recovery.json.tmp` would sit there for
      // the next run — and for any other host sharing this directory — to rename
      // over the record half-written.
      fs.mkdirSync(file());

      const store = createRecoveryStore(dir, { log });
      store.beginCapture();
      expect(() => store.record('a', 'claude --continue')).not.toThrow();

      expect(messages.some((message) => message.startsWith('error [recovery] write failed'))).toBe(true);
      expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
  });

  describe('take', () => {
    it('never hands out commands when removing the durable record fails', () => {
      write({ createdAt: Date.now(), commands: { a: 'claude --continue' } });
      const store = createRecoveryStore(dir, { log });
      vi.mocked(fs.unlinkSync).mockImplementationOnce(() => { throw new Error('unlink refused'); });
      expect(store.take(['a'])).toEqual({});
      expect(store.take(['a'])).toEqual({});
      expect(read().commands).toEqual({ a: 'claude --continue' });
      expect(messages.some((message) => message.includes('could not clear record; ignoring it'))).toBe(true);
    });

    it.skipIf(process.platform !== 'win32')('tightens explicit legacy file grants before claiming the record', () => {
      write({ createdAt: Date.now(), commands: { a: 'claude --continue' } });
      seedEveryoneRead(file());
      const store = createRecoveryStore(dir, { log });
      const original = privatePaths.ensurePrivateFileSync;
      // Observe permissions immediately before the actual read and unlink.
      const protect = vi.spyOn(privatePaths, 'ensurePrivateFileSync').mockImplementation((target) => {
        original(target);
        const acl = readAcl(target);
        expect(acl.protected).toBe(true);
        expect(acl.rules).toEqual([{ sid: acl.currentUser, rights: 0x001F01FF, allow: true, inheritance: 0 }]);
      });
      expect(store.take(['a'])).toEqual({ a: 'claude --continue' });
      expect(protect).toHaveBeenCalledWith(file());
      protect.mockRestore();
      expect(fs.existsSync(file())).toBe(false);
    });

    it('does not read or unlink a record whose private file setup fails', () => {
      write({ createdAt: Date.now(), commands: { a: 'claude --continue' } });
      const store = createRecoveryStore(dir, { log });
      const protect = vi.spyOn(privatePaths, 'ensurePrivateFileSync').mockImplementation(() => { throw new Error('ACL failed'); });
      expect(store.take(['a'])).toEqual({});
      expect(read().commands).toEqual({ a: 'claude --continue' });
      protect.mockRestore();
      expect(store.take(['a'])).toEqual({ a: 'claude --continue' });
    });

    it('unlinks on the first call and hands out each id exactly once', () => {
      write({ createdAt: Date.now(), commands: { a: 'claude --resume A', b: 'codex resume B' } });
      const store = createRecoveryStore(dir, { log });

      expect(store.take(['a'])).toEqual({ a: 'claude --resume A' });
      // The durable copy is gone before anything can act on it, so a failed start
      // cannot replay it.
      expect(fs.existsSync(file())).toBe(false);

      // A second container claims its share of the same read; the first id is
      // spent.
      expect(store.take(['a', 'b'])).toEqual({ b: 'codex resume B' });
      expect(store.take(['b'])).toEqual({});
    });

    it('returns nothing when there is no record', () => {
      expect(createRecoveryStore(dir, { log }).take(['a'])).toEqual({});
    });

    it('is destructive even on a record it cannot parse', () => {
      fs.writeFileSync(file(), '{ torn', 'utf8');
      const store = createRecoveryStore(dir, { log });
      expect(store.take(['a'])).toEqual({});
      expect(fs.existsSync(file())).toBe(false);
    });

    it('discards a record past its expiry, having removed it', () => {
      write({ createdAt: Date.now() - RECOVERY_MAX_AGE_MS - 1, commands: { a: 'claude --continue' } });
      const store = createRecoveryStore(dir, { log });
      expect(store.take(['a'])).toEqual({});
      expect(fs.existsSync(file())).toBe(false);
    });

    it('drops a non-string entry rather than handing it on', () => {
      write({ createdAt: Date.now(), commands: { a: 'claude --continue', b: { evil: true } } });
      const store = createRecoveryStore(dir, { log });
      expect(store.take(['a', 'b'])).toEqual({ a: 'claude --continue' });
    });

    it('cannot be tricked by an id that names an Object prototype member', () => {
      write({ createdAt: Date.now(), commands: { constructor: 'claude --continue' } });
      const store = createRecoveryStore(dir, { log });
      // A plain literal would answer `toString` with an inherited function.
      expect(store.take(['toString'])).toEqual({});
      expect(store.take(['constructor'])).toEqual({ constructor: 'claude --continue' });
    });
  });

  it('never retries a failed startup helper during capture, then recovers on a cold-start claim', () => {
    write({ createdAt: Date.now(), commands: { old: 'claude --continue' } });
    const protect = vi.spyOn(privatePaths, 'ensurePrivateDirectorySync').mockImplementation(() => { throw new Error('helper timed out'); });
    const store = createRecoveryStore(dir, { log });
    expect(protect).toHaveBeenCalledTimes(1);
    store.beginCapture();
    store.record('a', 'codex resume A');
    store.beginCapture();
    store.record('b', 'codex resume B');
    expect(protect).toHaveBeenCalledTimes(1);
    expect(read().commands).toEqual({ old: 'claude --continue' });
    expect(fs.readdirSync(dir)).toEqual(['recovery.json']);
    expect(store.take([])).toEqual({});
    expect(protect).toHaveBeenCalledTimes(2);
    protect.mockRestore();
    // Only startup/claim retries expensive preparation. Captured invocations
    // remain in memory and later writes merge after successful preparation.
    expect(store.take([])).toEqual({});
    store.beginCapture();
    store.record('c', 'codex resume C');
    expect(read().commands).toEqual({ a: 'codex resume A', b: 'codex resume B', c: 'codex resume C' });
  });

  it('prepares a successful directory once across multiple captures and writes', () => {
    const protect = vi.spyOn(privatePaths, 'ensurePrivateDirectorySync');
    const store = createRecoveryStore(dir, { log });
    store.beginCapture();
    store.record('a', 'claude --continue');
    store.beginCapture();
    store.record('b', 'codex resume B');
    expect(protect).toHaveBeenCalledTimes(1);
    expect(read().commands).toEqual({ a: 'claude --continue', b: 'codex resume B' });
  });

  describe('without a state directory', () => {
    it('keeps the record in memory and says so once', () => {
      const store = createRecoveryStore(undefined, { log });
      expect(store.persistent).toBe(false);
      expect(messages.filter((message) => message.includes('no state directory'))).toHaveLength(1);

      store.beginCapture();
      store.record('a', 'claude --continue');
      expect(store.take(['a'])).toEqual({ a: 'claude --continue' });
      expect(store.take(['a'])).toEqual({});
    });
  });
});
