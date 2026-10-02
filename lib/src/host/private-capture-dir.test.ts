import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateCaptureDir, type PrivateCaptureDir } from './private-capture-dir';
import * as privatePaths from './private-path';
import { readAcl, seedEveryoneRead } from './private-path.test-utils';

let parent: string;
let capture: PrivateCaptureDir;
beforeEach(() => {
  parent = fs.mkdtempSync(join(tmpdir(), 'dormouse-capture-test-'));
  // A nested prefix creates a child of this per-test temp directory without
  // changing process-wide TEMP/TMP.
  capture = privateCaptureDir(join(basename(parent), 'capture-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await capture.remove();
  fs.rmSync(parent, { recursive: true, force: true });
});

describe('private browser capture directory', () => {
  it('prepares one owner-only directory and creates a fresh one after removal', async () => {
    const prepare = vi.spyOn(privatePaths, 'ensurePrivateDirectory');
    const [first, shared] = await Promise.all([capture.get(), capture.get()]);
    expect(shared).toBe(first);
    expect(prepare).toHaveBeenCalledTimes(1);
    await capture.remove();
    expect(fs.existsSync(first)).toBe(false);
    const next = await capture.get();
    expect(next).not.toBe(first);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('removes a directory whose permission setup failed, then retries without exposing a path', async () => {
    const prepare = vi.spyOn(privatePaths, 'ensurePrivateDirectory').mockRejectedValue(new Error('ACL failed'));
    await expect(capture.get()).rejects.toThrow('ACL failed');
    expect(fs.readdirSync(parent)).toEqual([]);
    prepare.mockRestore();
    const dir = await capture.get();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('does not publish a removed pending path or evict its replacement from the cache', async () => {
    const original = privatePaths.ensurePrivateDirectory;
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const paused = new Promise<void>((resolve) => { finish = resolve; });
    let discarded!: string;
    const prepare = vi.spyOn(privatePaths, 'ensurePrivateDirectory').mockImplementationOnce(async (dir) => {
      discarded = dir;
      entered();
      await paused;
      await original(dir);
    });
    const first = capture.get();
    const refused = expect(first).rejects.toThrow('removed during setup');
    await started;
    const removing = capture.remove();
    const replacement = await capture.get();
    finish();
    await refused;
    await removing;
    expect(fs.existsSync(discarded)).toBe(false);
    expect(fs.existsSync(replacement)).toBe(true);
    expect(await capture.get()).toBe(replacement);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform !== 'win32')('removes inherited foreign access before the first screenshot can be written', async () => {
    seedEveryoneRead(parent);
    const dir = await capture.get();
    const file = join(dir, 'capture.png');
    fs.writeFileSync(file, 'private screenshot');
    for (const [target, inheritance] of [[dir, 3], [file, 0]] as const) {
      const acl = readAcl(target);
      expect(acl.owner).toBe(acl.currentUser);
      expect(acl.rules).toEqual([{ sid: acl.currentUser, rights: 0x001F01FF, allow: true, inheritance }]);
      if (target === dir) expect(acl.protected).toBe(true);
    }
  }, 10_000);

  it.skipIf(process.platform === 'win32')('restricts the directory and its screenshots without changing the parent', async () => {
    fs.chmodSync(parent, 0o755);
    const dir = await capture.get();
    const file = join(dir, 'capture.png');
    fs.writeFileSync(file, 'private screenshot');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(parent).mode & 0o777).toBe(0o755);
  });
});
