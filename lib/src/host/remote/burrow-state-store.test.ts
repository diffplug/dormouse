import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Watches the two filesystem steps a save is made of, so a test can see whether
 * two saves interleave. Only the temp writes are timed — the tests' own
 * `writeFile` calls go straight through.
 */
const fsProbe = vi.hoisted(() => ({
  steps: [] as string[],
  tmpWriteDelayMs: 0,
  /** Stand in for a filesystem with no POSIX modes. */
  chmodFails: false,
  /** Stand in for a read that fails for a reason other than "no file yet". */
  readFileError: null as (Error & { code?: string }) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    chmod: async (path: string, mode: number) => {
      if (fsProbe.chmodFails) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return real.chmod(path, mode);
    },
    readFile: async (path: string, options: never) => {
      if (fsProbe.readFileError) throw fsProbe.readFileError;
      return real.readFile(path, options);
    },
    writeFile: async (path: string, data: never, options: never) => {
      if (String(path).endsWith('.tmp')) {
        fsProbe.steps.push('write');
        if (fsProbe.tmpWriteDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, fsProbe.tmpWriteDelayMs));
        }
      }
      return real.writeFile(path, data, options);
    },
    rename: async (from: string, to: string) => {
      fsProbe.steps.push('rename');
      return real.rename(from, to);
    },
  };
});
import { toBase64Url, type BurrowAclRecord } from 'remote-lib-common';
import type { BurrowEnrollment } from '../../remote/burrow/enrollment';
import {
  createEphemeralBurrowStateStore,
  FileBurrowStateStore,
  forgetRetiredState,
} from './burrow-state-store';

const ENROLLMENT: BurrowEnrollment = {
  relayUrl: 'https://relay.example',
  burrowId: 'S6kyjjqOS7mw3l8ye89U3g',
  burrowToken: 'tok',
  origin: 'https://relay.example',
  rpId: 'relay.example',
  // The Burrow's Noise static rides with the enrollment, so this store is where
  // its private half lives
  // (`docs/specs/remote-security-model.md` → Burrow identity). Shapes, not real
  // keys — `isEnrollment` checks
  // the encoding and the decoded lengths on the way back in.
  noiseStaticPrivateKey: toBase64Url(new Uint8Array(48)),
  noiseStaticPublicKey: toBase64Url(new Uint8Array(32)),
};

/**
 * Base64url of exactly 32 bytes is 43 characters, and `isBurrowAclRecord` checks
 * both E2E fields for that length exactly — the records here go back through it
 * on every load, so a shorter fixture would simply vanish.
 */
function id32(name: string): string {
  return name.padEnd(43, '0');
}

function aclRecord(burrowId: string, client: string): BurrowAclRecord {
  return {
    burrowId,
    accountId: 'owner',
    passkeyCredentialId: 'cred',
    passkeyPublicKeyHash: 'hash',
    clientStaticPublicKey: id32(`static-${client}`),
    deliveryId: id32(`delivery-${client}`),
    approvedAt: 1,
    approvedBy: 'burrow-user',
    label: 'iPhone',
    revokedAt: null,
  };
}

let dir: string;
const file = (): string => join(dir, 'burrow.json');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dormouse-burrow-state-'));
  fsProbe.steps.length = 0;
  fsProbe.tmpWriteDelayMs = 0;
  fsProbe.chmodFails = false;
  fsProbe.readFileError = null;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileBurrowStateStore', () => {
  it('round-trips the enrollment and the ACL across instances', async () => {
    const store = new FileBurrowStateStore(dir);
    await store.saveEnrollment(ENROLLMENT);
    await store.saveAcl('burrow-1', [aclRecord('burrow-1', 'client-1')]);

    const reopened = new FileBurrowStateStore(dir);
    const loaded = await reopened.loadEnrollment();
    expect(loaded).toEqual(ENROLLMENT);
    // Including the Noise static: nothing else persists it, and a Burrow that
    // came back without it would be a different party to every paired Client.
    expect(loaded?.noiseStaticPrivateKey).toBe(ENROLLMENT.noiseStaticPrivateKey);
    expect(loaded?.noiseStaticPublicKey).toBe(ENROLLMENT.noiseStaticPublicKey);
    expect(await reopened.loadAcl('burrow-1')).toHaveLength(1);
  });

  it('answers empty before anything was written', async () => {
    const store = new FileBurrowStateStore(dir);
    expect(await store.loadEnrollment()).toBeNull();
    expect(await store.loadAcl('burrow-1')).toEqual([]);
  });

  it('keeps ACLs apart by burrowId', async () => {
    const store = new FileBurrowStateStore(dir);
    await store.saveAcl('burrow-1', [aclRecord('burrow-1', 'client-1')]);
    await store.saveAcl('burrow-2', [aclRecord('burrow-2', 'client-2')]);
    expect(await store.loadAcl('burrow-1')).toEqual([aclRecord('burrow-1', 'client-1')]);
    // A record filed under the wrong burrow is dropped rather than failing the
    // whole load — `BurrowAcl.fromRecords` would reject the mismatch.
    await writeFile(
      file(),
      JSON.stringify({ version: 1, enrollment: null, acl: { 'burrow-1': [aclRecord('other', 'x')] } }),
    );
    expect(await new FileBurrowStateStore(dir).loadAcl('burrow-1')).toEqual([]);
  });

  it('clearing the enrollment leaves the records alone', async () => {
    const store = new FileBurrowStateStore(dir);
    await store.saveEnrollment(ENROLLMENT);
    await store.saveAcl('burrow-1', [aclRecord('burrow-1', 'client-1')]);
    await store.clearEnrollment();

    const reopened = new FileBurrowStateStore(dir);
    expect(await reopened.loadEnrollment()).toBeNull();
    expect(await reopened.loadAcl('burrow-1')).toHaveLength(1);
  });

  // Skipped on Windows for the same reason as the directory test below, and it
  // has always failed there — CI runs this suite only on ubuntu, so nothing
  // caught it. A Unix mode is a silent no-op on Windows: `stat().mode` reports
  // a synthesized value that has nothing to do with what the ACL permits, so
  // the assertion tests neither the intent nor the outcome. What actually
  // protects this file on Windows is the owner-only DACL that
  // `burrow_state_dir` applies to the directory before the sidecar starts,
  // asserted by `restrict_to_owner_leaves_one_owner_only_ace` in
  // `standalone/src-tauri/src/lib.rs`.
  it.runIf(process.platform !== 'win32')(
    'writes the file 0600 and creates its directory 0700',
    async () => {
      // The enrollment carries `burrowToken`, a bearer credential.
      const nested = join(dir, 'nested');
      const store = new FileBurrowStateStore(nested);
      await store.saveEnrollment(ENROLLMENT);

      expect((await stat(join(nested, 'burrow.json'))).mode & 0o777).toBe(0o600);
      expect((await stat(nested)).mode & 0o777).toBe(0o700);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'tightens a state directory the burrow created first',
    async () => {
      // Production Tauri creates app_data_dir before spawning the sidecar, so
      // mkdir's creation mode alone cannot make this directory private.
      await chmod(dir, 0o755);
      const store = new FileBurrowStateStore(dir);
      await store.saveEnrollment(ENROLLMENT);

      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    },
  );

  it('still saves where the directory mode cannot be set', async () => {
    // A filesystem with no POSIX modes (a mounted share, some containers). The
    // 0600 on the file is the protection that matters, so failing the whole save
    // over the directory would lose the Burrow to no benefit.
    fsProbe.chmodFails = true;
    const store = new FileBurrowStateStore(dir);

    await expect(store.saveEnrollment(ENROLLMENT)).resolves.toBeUndefined();
    expect(await new FileBurrowStateStore(dir).loadEnrollment()).toEqual(ENROLLMENT);
  });

  it('leaves no temp file behind, and overwrites in place', async () => {
    const store = new FileBurrowStateStore(dir);
    await store.saveEnrollment(ENROLLMENT);
    await store.saveEnrollment({ ...ENROLLMENT, burrowId: 'LnExjA-KKeADf221aLlYyw' });

    const { readdir } = await import('node:fs/promises');
    expect(await readdir(dir)).toEqual(['burrow.json']);
    const parsed = JSON.parse(await readFile(file(), 'utf8')) as { enrollment: BurrowEnrollment };
    expect(parsed.enrollment.burrowId).toBe('LnExjA-KKeADf221aLlYyw');
  });

  it('serializes concurrent saves instead of interleaving their writes', async () => {
    // Two saves in flight at once is the normal case — the ACL is written in
    // the background while a command writes the enrollment. Overlapping them
    // used to share one temp path per process, so the first rename moved the
    // file out from under the second, which then failed with ENOENT.
    fsProbe.tmpWriteDelayMs = 30;
    const store = new FileBurrowStateStore(dir);

    await Promise.all([
      store.saveAcl('burrow-1', [aclRecord('burrow-1', 'client-1')]),
      store.saveEnrollment(ENROLLMENT),
    ]);

    expect(fsProbe.steps).toEqual(['write', 'rename', 'write', 'rename']);
    // And the file the last one left is whole, with both changes in it.
    const parsed = JSON.parse(await readFile(file(), 'utf8')) as {
      enrollment: BurrowEnrollment;
      acl: Record<string, BurrowAclRecord[]>;
    };
    expect(parsed.enrollment).toEqual(ENROLLMENT);
    expect(parsed.acl['burrow-1']).toHaveLength(1);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(dir)).toEqual(['burrow.json']);
  });

  it('keeps saving after one write fails', async () => {
    // The chain must not wedge on a single unwritable moment, and the caller
    // still has to see the failure.
    const store = new FileBurrowStateStore(dir);
    // Read the (absent) file first, so what fails below is the write: a read
    // that fails for a reason other than ENOENT refuses to save at all, which
    // is the case above rather than this one.
    expect(await store.loadEnrollment()).toBeNull();
    await rm(dir, { recursive: true, force: true });
    const blocker = join(dir);
    await writeFile(blocker, 'not a directory');

    await expect(store.saveEnrollment(ENROLLMENT)).rejects.toBeTruthy();
    // A failed flush is not a successful in-memory save: a change reaches later
    // reads only once its atomic rename has succeeded.
    expect(await store.loadEnrollment()).toBeNull();
    await rm(blocker, { force: true });
    await expect(store.saveEnrollment(ENROLLMENT)).resolves.toBeUndefined();
    expect(await store.loadEnrollment()).toEqual(ENROLLMENT);
  });

  it('refuses to answer — or to write — from a read it could not explain', async () => {
    // EACCES/EIO says nothing about what the file holds. Answering empty would
    // be memoized, and the next save is a read-modify-write of the whole file:
    // it would durably overwrite the enrollment and every ACL record with the
    // nothing we invented, de-pairing every device for good.
    const seeded = new FileBurrowStateStore(dir);
    await seeded.saveEnrollment(ENROLLMENT);
    await seeded.saveAcl('burrow-1', [aclRecord('burrow-1', 'client-1')]);
    const before = await readFile(file(), 'utf8');

    const store = new FileBurrowStateStore(dir);
    fsProbe.readFileError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    await expect(store.loadEnrollment()).rejects.toMatchObject({ code: 'EACCES' });
    await expect(store.loadAcl('burrow-1')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(store.saveEnrollment({ ...ENROLLMENT, burrowId: 'LnExjA-KKeADf221aLlYyw' })).rejects.toMatchObject({
      code: 'EACCES',
    });
    await expect(store.clearEnrollment()).rejects.toMatchObject({ code: 'EACCES' });

    // Nothing reached the disk while the state could not be read.
    fsProbe.readFileError = null;
    expect(await readFile(file(), 'utf8')).toBe(before);
    // And the failure was not memoized: the same store recovers on the next read.
    expect(await store.loadEnrollment()).toEqual(ENROLLMENT);
    expect(await store.loadAcl('burrow-1')).toHaveLength(1);
  });

  it('starts empty and warns on a malformed file', async () => {
    // Fail closed but loudly: an empty ACL silently de-pairs every device.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeFile(file(), '{ not json');

    const store = new FileBurrowStateStore(dir);
    expect(await store.loadEnrollment()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not warn about a file that simply is not there yet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await new FileBurrowStateStore(dir).loadEnrollment();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ignores an enrollment that does not have the shape', async () => {
    await writeFile(file(), JSON.stringify({ version: 1, enrollment: { burrowId: 'x' }, acl: {} }));
    expect(await new FileBurrowStateStore(dir).loadEnrollment()).toBeNull();
  });
});

describe('createEphemeralBurrowStateStore', () => {
  it('keeps the Burrow for the session, and says once that it goes no further', async () => {
    // Reads that answered empty would de-pair every device the moment it was
    // approved: the ACL this Burrow authorizes with is the one it just wrote.
    const warnings: string[] = [];
    const store = createEphemeralBurrowStateStore((message) => warnings.push(message));

    await store.saveEnrollment(ENROLLMENT);
    await store.saveAcl('burrow-1', [aclRecord('burrow-1', 'client-1')]);
    expect(await store.loadEnrollment()).toEqual(ENROLLMENT);
    expect(await store.loadAcl('burrow-1')).toHaveLength(1);
    expect(warnings).toHaveLength(1);

    await store.clearEnrollment();
    expect(await store.loadEnrollment()).toBeNull();
  });

  it('says out loud whether a write survives the process', () => {
    // The two stores have to disagree here: the dev harness holds the Burrow in
    // memory only, and a store read as durable when it is not would let a
    // caller believe an enrollment outlives a restart.
    expect(createEphemeralBurrowStateStore(() => {}).persistent).toBe(false);
    expect(new FileBurrowStateStore(dir).persistent).toBe(true);
  });

  it('files records under their own burrow, like the real store', async () => {
    const store = createEphemeralBurrowStateStore(() => {});
    await store.saveAcl('burrow-1', [aclRecord('other', 'client-1')]);
    expect(await store.loadAcl('burrow-1')).toEqual([]);
  });
});

describe('forgetting the retired state file', () => {
  it('deletes the pre-rename file unread, and leaves the live one alone', async () => {
    // It carries a `burrowToken` this build can no longer revoke
    // (`docs/specs/security-remote.md` -> "Credentials at rest").
    const retired = join(dir, 'remote-host.json');
    await writeFile(retired, JSON.stringify({ enrollment: { burrowToken: 'secret' } }));
    const store = new FileBurrowStateStore(dir);
    await store.saveEnrollment(ENROLLMENT);

    await forgetRetiredState(dir);

    await expect(readFile(retired, 'utf8')).rejects.toThrow(/ENOENT/);
    expect(await store.loadEnrollment()).toEqual(ENROLLMENT);
  });

  it('is quiet on a directory that never held one', async () => {
    const warnings: unknown[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => void warnings.push(args));
    try {
      await expect(forgetRetiredState(dir)).resolves.toBeUndefined();
      expect(warnings).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
