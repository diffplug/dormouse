/**
 * The one sweep of what the Host→Burrow rename stranded
 * (`docs/specs/security-remote.md` → "Credentials at rest"). What matters is
 * that every retired name is reached by *name* — `SecretStorage` cannot be
 * enumerated, so a key this misses is a credential nothing can ever remove.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { forgetRetiredState } from '../src/retired-state';
import { removeDir, tempStorageDir } from './helpers';

const RETIRED_ENROLLMENT_KEY = 'dormouse.remote-host.enrollment';
const RETIRED_TOKEN_FILE = 'remote-host.peer-token';
const SWEPT_KEY = 'dormouse.burrow.retiredStateForgotten';

function fakeContext(dir: string) {
  const secrets = new Map<string, string>();
  const global = new Map<string, unknown>();
  const deletedSecrets: string[] = [];
  return {
    deletedSecrets,
    secrets,
    global,
    context: {
      globalStorageUri: { fsPath: dir },
      secrets: {
        delete: (key: string) => {
          deletedSecrets.push(key);
          secrets.delete(key);
          return Promise.resolve();
        },
      },
      globalState: {
        keys: () => [...global.keys()],
        get: (key: string) => global.get(key),
        update: (key: string, value: unknown) => {
          if (value === undefined) global.delete(key);
          else global.set(key, value);
          return Promise.resolve();
        },
      },
    },
  };
}

type FakeContext = ReturnType<typeof fakeContext>;

let dir: string;
let world: FakeContext;

beforeEach(async () => {
  dir = await tempStorageDir();
  world = fakeContext(dir);
});

afterEach(async () => {
  await removeDir(dir);
});

describe('forgetting the retired remote-host state', () => {
  it('deletes every retired name, then marks itself done', async () => {
    world.secrets.set(RETIRED_ENROLLMENT_KEY, JSON.stringify({ burrowToken: 'secret' }));
    world.global.set('dormouse.remote-host.acl.burrow-1', '[]');
    world.global.set('dormouse.remote-host.acl.burrow-2', '[]');
    // A live key sharing the prefix's first two segments must survive.
    world.global.set('dormouse.burrow.acl.burrow-3', '["keep"]');
    const token = join(dir, RETIRED_TOKEN_FILE);
    await writeFile(token, 'shared-secret', { mode: 0o600 });

    await forgetRetiredState(world.context as never);

    expect(world.deletedSecrets).toEqual([RETIRED_ENROLLMENT_KEY]);
    expect([...world.global.keys()]).toEqual(['dormouse.burrow.acl.burrow-3', SWEPT_KEY]);
    await expect(readFile(token, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('runs once, so no later launch pays for the keychain again', async () => {
    await forgetRetiredState(world.context as never);
    expect(world.deletedSecrets).toHaveLength(1);

    await forgetRetiredState(world.context as never);
    expect(world.deletedSecrets).toHaveLength(1);
  });

  it('leaves itself un-swept when a store refuses, so the next launch retries', async () => {
    // A locked keyring is the real case: the credential is still there, so the
    // sweep must not record success.
    const failing = {
      ...world.context,
      secrets: {
        delete: () => Promise.reject(new Error('keyring is locked')),
      },
    };

    await forgetRetiredState(failing as never);

    expect(world.global.get(SWEPT_KEY)).toBeUndefined();
  });
});
