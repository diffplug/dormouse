import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalLocalDirectory } from './local-directory';

// POSIX cannot make a link to a real share, so each share link here names a
// directory that exists when read as POSIX would: only the refusal stops it.
describe.skipIf(process.platform === 'win32')('canonicalLocalDirectory', () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'local-directory-')));
    mkdirSync(join(root, 'real/sub'), { recursive: true });
    // `//<root>/real` is `<root>/real` to POSIX, and a share to Windows.
    symlinkSync(`/${join(root, 'real')}`, join(root, 'slashes'));
    // A relative name to POSIX, so a directory by that name makes it resolve.
    mkdirSync(join(root, '\\\\host\\share'));
    symlinkSync('\\\\host\\share', join(root, 'backslashes'));
    // A share link reached through an ordinary one.
    symlinkSync(join(root, 'slashes'), join(root, 'to-slashes'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('never follows a link whose target is a share or device path, wherever it sits', async () => {
    for (const path of ['slashes', 'slashes/sub', 'backslashes', 'to-slashes/sub']) {
      expect(await canonicalLocalDirectory(join(root, path)), path).toBeNull();
    }
  });

  it('resolves relative and absolute links, chained, to the canonical directory', async () => {
    symlinkSync('real', join(root, 'relative'));
    symlinkSync(join(root, 'relative'), join(root, 'absolute'));
    expect(await canonicalLocalDirectory(join(root, 'absolute/sub'))).toBe(join(root, 'real/sub'));
    expect(await canonicalLocalDirectory(join(root, 'absolute/sub/..'))).toBe(join(root, 'real'));
  });

  it('answers null for a link loop, a file, a missing path, and relative input', async () => {
    symlinkSync(join(root, 'loop-b'), join(root, 'loop-a'));
    symlinkSync(join(root, 'loop-a'), join(root, 'loop-b'));
    writeFileSync(join(root, 'file'), '');
    for (const path of [join(root, 'loop-a'), join(root, 'file'), join(root, 'missing'), 'real', null]) {
      expect(await canonicalLocalDirectory(path), String(path)).toBeNull();
    }
  });
});
