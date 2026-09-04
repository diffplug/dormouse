/** Server-owned setup-password generation and persistence. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateSetupPassword, isSetupPassword } from '../dist/setup-password.js';
import { SetupPasswordStore } from '../dist/state.js';
import { PASSWORD } from './fixtures.mjs';

test('the setup password is minted once and persisted owner-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dormouse-setup-password-'));
  const stateDir = join(root, 'state');
  const store = new SetupPasswordStore(stateDir, () => 1_700_000_000_000);

  assert.equal(await store.loadOrCreate(() => PASSWORD), PASSWORD);
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'setup-password.json'), 'utf8')), {
    password: PASSWORD,
    createdAt: 1_700_000_000_000,
  });
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(stateDir, 'setup-password.json'))).mode & 0o777, 0o600);

  assert.equal(
    await new SetupPasswordStore(stateDir).loadOrCreate(() => {
      throw new Error('must not regenerate an existing credential');
    }),
    PASSWORD,
  );
});

test('the production generator returns exactly 32 bytes as lowercase hex', () => {
  const first = generateSetupPassword();
  const second = generateSetupPassword();
  assert.equal(isSetupPassword(first), true);
  assert.equal(isSetupPassword(second), true);
  assert.notEqual(first, second);
});

test('malformed persisted credentials are refused, never silently replaced', async () => {
  for (const contents of [
    'null\n',
    `${JSON.stringify({ password: 'password', createdAt: Date.now() })}\n`,
  ]) {
    const stateDir = await mkdtemp(join(tmpdir(), 'dormouse-setup-password-'));
    await writeFile(join(stateDir, 'setup-password.json'), contents);
    await assert.rejects(
      new SetupPasswordStore(stateDir).loadOrCreate(() => PASSWORD),
      /setup-password\.json does not contain a valid setup password/,
    );
  }
});

test('an invalid generator result is refused without creating state', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dormouse-setup-password-'));
  await assert.rejects(
    new SetupPasswordStore(stateDir).loadOrCreate(() => 'not-random'),
    /the generated setup password is not valid/,
  );
  await assert.rejects(readFile(join(stateDir, 'setup-password.json')), /ENOENT/);
});
