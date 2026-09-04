/**
 * The singleton state records — `vapid.json` and `account.json` — and the
 * shared rule they hold with `setup-password.json`
 * (`setup-password-store.test.mjs`): a file that is present but not a valid
 * record stops the read instead of reading as first boot.
 *
 * The case that matters is a whole-file `null`. JSON can encode it, absence
 * cannot be encoded at all, and a reader that collapses the two mints a
 * replacement *over* whatever the file actually held.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountStore, CorruptStateError, VapidStore } from '../dist/state.js';

const KEYS = { publicKey: 'BPublicKey', privateKey: 'APrivateKey' };

async function stateDir() {
  return mkdtemp(join(tmpdir(), 'dormouse-state-records-'));
}

test('the VAPID keypair is minted once and never regenerated over an existing one', async () => {
  const dir = await stateDir();
  const store = new VapidStore(dir, () => 1_700_000_000_000);

  assert.deepEqual(await store.loadOrCreate(() => KEYS), { ...KEYS, createdAt: 1_700_000_000_000 });
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'vapid.json'), 'utf8')), {
    ...KEYS,
    createdAt: 1_700_000_000_000,
  });

  const reopened = await new VapidStore(dir).loadOrCreate(() => {
    throw new Error('must not regenerate an existing keypair');
  });
  assert.equal(reopened.privateKey, KEYS.privateKey);
});

test('a corrupt vapid.json stops the read rather than costing every push subscription', async () => {
  // `null` is the whole point: it is what a truncated or half-finished write
  // leaves, and reading it as first boot silently mints a new keypair, which
  // invalidates every phone's subscription with no error anywhere.
  for (const contents of ['null\n', '0\n', '""\n', '{}\n', '{"publicKey":"a"}\n', '[]\n']) {
    const dir = await stateDir();
    await writeFile(join(dir, 'vapid.json'), contents);
    await assert.rejects(
      new VapidStore(dir).loadOrCreate(() => KEYS),
      (err) =>
        err instanceof CorruptStateError && /vapid\.json does not contain a valid VAPID keypair/.test(err.message),
      contents,
    );
    // The refused read must not have written over what was there.
    assert.equal(await readFile(join(dir, 'vapid.json'), 'utf8'), contents);
  }
});

test('a generator that returns an unusable keypair writes nothing', async () => {
  const dir = await stateDir();
  await assert.rejects(
    new VapidStore(dir).loadOrCreate(() => ({ publicKey: '', privateKey: '' })),
    /the generated VAPID keypair is not valid/,
  );
  await assert.rejects(readFile(join(dir, 'vapid.json')), /ENOENT/);
});

test('an absent account.json is first boot; a corrupt one is not', async () => {
  const dir = await stateDir();
  assert.equal(await new AccountStore(dir).load(), null);

  // The hazard this pins: read as first boot, `appendPasskey` would start a
  // fresh account and register into it, over whatever the file had held.
  for (const contents of ['null\n', '{}\n', '{"accountId":"owner"}\n', '[]\n']) {
    await writeFile(join(dir, 'account.json'), contents);
    await assert.rejects(
      new AccountStore(dir).load(),
      (err) =>
        err instanceof CorruptStateError && /account\.json does not contain a valid account record/.test(err.message),
      contents,
    );
    await assert.rejects(
      new AccountStore(dir).appendPasskey({
        credentialId: 'cred',
        publicKey: 'spki',
        label: 'laptop',
      }),
      CorruptStateError,
      contents,
    );
    assert.equal(await readFile(join(dir, 'account.json'), 'utf8'), contents);
  }
});

test('passkey rows are left as they are found — the envelope is what is checked', async () => {
  // Deleting a row is the documented revocation mechanism, so a row this
  // version does not recognise must not make the whole file unreadable.
  const dir = await stateDir();
  const account = { accountId: 'owner', passkeys: [{ credentialId: 'only-an-id' }] };
  await writeFile(join(dir, 'account.json'), JSON.stringify(account));
  assert.deepEqual(await new AccountStore(dir).load(), account);

  await writeFile(join(dir, 'account.json'), JSON.stringify({ accountId: 'owner', passkeys: [] }));
  const appended = await new AccountStore(dir, () => 1_700_000_000_000).appendPasskey({
    credentialId: 'cred',
    publicKey: 'spki',
    label: 'laptop',
  });
  assert.deepEqual(appended.passkeys, [
    { credentialId: 'cred', publicKey: 'spki', label: 'laptop', createdAt: 1_700_000_000_000 },
  ]);
});
