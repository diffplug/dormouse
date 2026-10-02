import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensurePrivateDirectory, ensurePrivateDirectorySync, ensurePrivateFileSync } from './private-path';
import { readAcl, runAclScript, seedEveryoneRead } from './private-path.test-utils';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'dormouse-private-path-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('private recovery paths', () => {
  it.skipIf(process.platform === 'win32')('tightens existing directory and file modes without changing the parent', () => {
    fs.chmodSync(dir, 0o755);
    const nested = join(dir, 'owned');
    fs.mkdirSync(nested, { mode: 0o755 });
    ensurePrivateDirectorySync(nested);
    const file = join(nested, 'recovery.json');
    fs.writeFileSync(file, 'secret', { mode: 0o644 });
    ensurePrivateFileSync(file);
    expect(fs.statSync(nested).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
  });

  it.skipIf(process.platform !== 'win32')('replaces inherited and explicit foreign grants with the current user alone', () => {
    // Quotes, $, and backticks must remain literal stdin data, not script code.
    const nested = join(dir, "literal $ ' ` owned");
    fs.mkdirSync(nested);
    seedEveryoneRead(nested);
    const legacy = join(nested, 'legacy.json');
    fs.writeFileSync(legacy, 'secret');
    seedEveryoneRead(legacy);
    expect(readAcl(legacy).rules.some(({ sid }) => sid === 'S-1-1-0')).toBe(true);
    ensurePrivateDirectorySync(nested);
    ensurePrivateFileSync(legacy);
    const fresh = join(nested, 'fresh.tmp');
    fs.writeFileSync(fresh, 'secret', { mode: 0o600 });
    for (const [target, inheritance] of [[nested, 3], [legacy, 0], [fresh, 0]] as const) {
      const acl = readAcl(target);
      expect(acl.owner).toBe(acl.currentUser);
      expect(acl.rules).toEqual([{ sid: acl.currentUser, rights: 0x001F01FF, allow: true, inheritance }]);
      if (target !== fresh) expect(acl.protected).toBe(true);
    }
  }, 10_000);

  it('rejects directories masquerading as recovery files', () => {
    expect(() => ensurePrivateFileSync(dir)).toThrow('plain file');
  });

  it.skipIf(process.platform === 'win32')('rejects symlinks without tightening the linked path', () => {
    const real = join(dir, 'real');
    fs.mkdirSync(real, { mode: 0o755 });
    const link = join(dir, 'link');
    fs.symlinkSync(real, link);
    expect(() => ensurePrivateDirectorySync(link)).toThrow('plain directory');
    expect(fs.statSync(real).mode & 0o777).toBe(0o755);
  });
});

it.skipIf(process.platform !== 'win32')('can migrate an administrator-owned legacy directory when Windows authorizes it', async (context) => {
  const nested = join(dir, 'elevated-legacy');
  fs.mkdirSync(nested);
  try {
    runAclScript(`$acl=Get-Acl -LiteralPath $p;
      $acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'));
      Set-Acl -LiteralPath $p -AclObject $acl`, nested);
  } catch (error) {
    // Unelevated Windows CI tokens cannot assign the administrators group owner.
    // Do not turn a real ACL setup failure into a platform skip.
    if (/privilege|not allowed|UnauthorizedAccess|IdentityNotMapped/.test(String(error))) {
      context.skip();
      return;
    }
    throw error;
  }
  expect(readAcl(nested).owner).toBe('S-1-5-32-544');
  await ensurePrivateDirectory(nested);
  const acl = readAcl(nested);
  expect(acl.owner).toBe(acl.currentUser);
  expect(acl.protected).toBe(true);
  expect(acl.rules).toEqual([{ sid: acl.currentUser, rights: 0x001F01FF, allow: true, inheritance: 3 }]);
}, 10_000);
