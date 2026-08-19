import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostAclRecord } from 'server-lib-common';
import type { HostEnrollment } from '../../remote/host/enrollment';
import { createEphemeralHostStateStore, FileHostStateStore } from './host-state-store';

const ENROLLMENT: HostEnrollment = {
  serverUrl: 'https://relay.example',
  hostId: 'host-1',
  hostToken: 'tok',
  origin: 'https://relay.example',
  rpId: 'relay.example',
};

function aclRecord(hostId: string, devicePublicKey: string): HostAclRecord {
  return {
    hostId,
    accountId: 'owner',
    passkeyCredentialId: 'cred',
    passkeyPublicKeyHash: 'hash',
    devicePublicKey,
    approvedAt: 1,
    approvedBy: 'host-user',
    label: 'iPhone',
    revokedAt: null,
  };
}

let dir: string;
const file = (): string => join(dir, 'remote-host.json');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dormouse-host-state-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileHostStateStore', () => {
  it('round-trips the enrollment and the ACL across instances', async () => {
    const store = new FileHostStateStore(dir);
    await store.saveEnrollment(ENROLLMENT);
    await store.saveAcl('host-1', [aclRecord('host-1', 'device-1')]);

    const reopened = new FileHostStateStore(dir);
    expect(await reopened.loadEnrollment()).toEqual(ENROLLMENT);
    expect(await reopened.loadAcl('host-1')).toHaveLength(1);
  });

  it('answers empty before anything was written', async () => {
    const store = new FileHostStateStore(dir);
    expect(await store.loadEnrollment()).toBeNull();
    expect(await store.loadAcl('host-1')).toEqual([]);
  });

  it('keeps ACLs apart by hostId', async () => {
    const store = new FileHostStateStore(dir);
    await store.saveAcl('host-1', [aclRecord('host-1', 'device-1')]);
    await store.saveAcl('host-2', [aclRecord('host-2', 'device-2')]);
    expect(await store.loadAcl('host-1')).toEqual([aclRecord('host-1', 'device-1')]);
    // A record filed under the wrong host is dropped rather than failing the
    // whole load — `HostAcl.fromRecords` would reject the mismatch.
    await writeFile(
      file(),
      JSON.stringify({ version: 1, enrollment: null, acl: { 'host-1': [aclRecord('other', 'x')] } }),
    );
    expect(await new FileHostStateStore(dir).loadAcl('host-1')).toEqual([]);
  });

  it('clearing the enrollment leaves the records alone', async () => {
    const store = new FileHostStateStore(dir);
    await store.saveEnrollment(ENROLLMENT);
    await store.saveAcl('host-1', [aclRecord('host-1', 'device-1')]);
    await store.clearEnrollment();

    const reopened = new FileHostStateStore(dir);
    expect(await reopened.loadEnrollment()).toBeNull();
    expect(await reopened.loadAcl('host-1')).toHaveLength(1);
  });

  it('writes the file 0600 and creates its directory 0700', async () => {
    // The enrollment carries `hostToken`, a bearer credential.
    const nested = join(dir, 'nested');
    const store = new FileHostStateStore(nested);
    await store.saveEnrollment(ENROLLMENT);

    expect((await stat(join(nested, 'remote-host.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
  });

  it('leaves no temp file behind, and overwrites in place', async () => {
    const store = new FileHostStateStore(dir);
    await store.saveEnrollment(ENROLLMENT);
    await store.saveEnrollment({ ...ENROLLMENT, hostId: 'host-2' });

    const { readdir } = await import('node:fs/promises');
    expect(await readdir(dir)).toEqual(['remote-host.json']);
    const parsed = JSON.parse(await readFile(file(), 'utf8')) as { enrollment: HostEnrollment };
    expect(parsed.enrollment.hostId).toBe('host-2');
  });

  it('starts empty and warns on a malformed file', async () => {
    // Fail closed but loudly: an empty ACL silently de-pairs every device.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeFile(file(), '{ not json');

    const store = new FileHostStateStore(dir);
    expect(await store.loadEnrollment()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not warn about a file that simply is not there yet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await new FileHostStateStore(dir).loadEnrollment();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ignores an enrollment that does not have the shape', async () => {
    await writeFile(file(), JSON.stringify({ version: 1, enrollment: { hostId: 'x' }, acl: {} }));
    expect(await new FileHostStateStore(dir).loadEnrollment()).toBeNull();
  });
});

describe('createEphemeralHostStateStore', () => {
  it('reads empty, drops writes, and says so once', async () => {
    const warnings: string[] = [];
    const store = createEphemeralHostStateStore((message) => warnings.push(message));

    await store.saveEnrollment(ENROLLMENT);
    await store.saveAcl('host-1', [aclRecord('host-1', 'device-1')]);
    expect(await store.loadEnrollment()).toBeNull();
    expect(await store.loadAcl('host-1')).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
