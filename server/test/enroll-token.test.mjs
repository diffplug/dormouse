/**
 * One-click enrollment (docs/specs/server.md, Configuration ->
 * `DORMOUSE_ENROLL_TOKEN_FILE`): `POST /api/host/enroll` redeeming the
 * installer's single-use offer file instead of the setup password.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { API_ROUTES, UNAUTHORIZED_ERROR } from 'server-lib-common';

import { ORIGIN, PASSWORD, RP_ID, freshApp, post } from './helpers.mjs';

const TOKEN = 'a1b2c3d4'.repeat(8);

function offer(overrides = {}) {
  return { origin: ORIGIN, token: TOKEN, mintedAt: '2026-08-31T12:00:00.000Z', ...overrides };
}

/**
 * An app whose `enrollTokenFile` points at a fresh temp path. `contents` is
 * written verbatim when it is a string, JSON-encoded when it is an object, and
 * `undefined` leaves the path with no file at all.
 */
async function appWithOffer(contents) {
  const dir = await mkdtemp(join(tmpdir(), 'dormouse-enroll-'));
  const enrollTokenFile = join(dir, 'enroll-token.json');
  if (contents !== undefined) {
    const text = typeof contents === 'string' ? contents : JSON.stringify(contents);
    await writeFile(enrollTokenFile, text);
  }
  const created = await freshApp({ enrollTokenFile });
  return { ...created, enrollTokenFile };
}

function enroll(app, body) {
  return post(app, API_ROUTES.hostEnroll, { label: 'This Machine', ...body });
}

/** True when nothing is at `path`. */
async function fileGone(path) {
  return readFile(path, 'utf8').then(
    () => false,
    () => true,
  );
}

test('a valid enroll token enrolls the host and consumes the offer', async () => {
  const { app, enrollTokenFile } = await appWithOffer(offer());
  const res = await enroll(app, { enrollToken: TOKEN });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.hostId, 'string');
  assert.equal(typeof body.hostToken, 'string');
  assert.notEqual(body.hostId, body.hostToken);
  assert.equal(body.origin, ORIGIN);
  assert.equal(body.rpId, RP_ID);
  assert.equal(await fileGone(enrollTokenFile), true);
});

test('the offer is single-use: a second redemption is refused', async () => {
  const { app } = await appWithOffer(offer());
  assert.equal((await enroll(app, { enrollToken: TOKEN })).status, 200);
  const second = await enroll(app, { enrollToken: TOKEN });
  assert.equal(second.status, 401);
  assert.deepEqual(await second.json(), { error: UNAUTHORIZED_ERROR });
});

test('a wrong token is refused and leaves the offer intact', async () => {
  const { app, enrollTokenFile } = await appWithOffer(offer());
  const res = await enroll(app, { enrollToken: 'f'.repeat(64) });
  assert.equal(res.status, 401);
  // A guess must not burn the operator's offer — that would be a denial of
  // service on the install's one-click path.
  assert.equal(await fileGone(enrollTokenFile), false);
});

test('every unusable offer is refused the same way, telling the caller nothing', async () => {
  const cases = {
    'no file at the configured path': undefined,
    'not JSON': 'not json at all',
    'a 32-hex token fails the shape guard': offer({ token: TOKEN.slice(0, 32) }),
    'a URL where an origin belongs': offer({ origin: `${ORIGIN}/enroll` }),
    'a missing mintedAt': { origin: ORIGIN, token: TOKEN },
  };
  for (const [name, contents] of Object.entries(cases)) {
    const { app } = await appWithOffer(contents);
    const res = await enroll(app, { enrollToken: TOKEN });
    assert.equal(res.status, 401, name);
    assert.deepEqual(await res.json(), { error: UNAUTHORIZED_ERROR }, name);
  }

  // Including the case where one-click enrollment was never configured: the
  // answer must not distinguish "off here" from "wrong token".
  const { app } = await freshApp();
  const res = await enroll(app, { enrollToken: TOKEN });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: UNAUTHORIZED_ERROR });
});

// Root ignores the directory mode, and Windows does not model it this way.
const CANNOT_DENY_UNLINK = {
  skip:
    process.platform === 'win32' || process.getuid?.() === 0
      ? 'needs a non-root POSIX user to make a directory unwritable'
      : false,
};

test('a token that cannot be invalidated is not redeemed', CANNOT_DENY_UNLINK, async () => {
  const { app, enrollTokenFile, stateDir } = await appWithOffer(offer());
  await chmod(dirname(enrollTokenFile), 0o500);
  try {
    const res = await enroll(app, { enrollToken: TOKEN });
    assert.equal(res.status, 500);
    // The point of the ordering: no host may exist against a token still on disk.
    assert.equal(await fileGone(join(stateDir, 'hosts.json')), true);
  } finally {
    await chmod(dirname(enrollTokenFile), 0o700);
  }
});

test('exactly one credential: both or neither is a 400', async () => {
  const { app } = await appWithOffer(offer());
  const both = await enroll(app, { password: PASSWORD, enrollToken: TOKEN });
  assert.equal(both.status, 400);
  const neither = await enroll(app, {});
  assert.equal(neither.status, 400);
  // Neither request may enroll anything, nor spend the offer.
  const good = await enroll(app, { enrollToken: TOKEN });
  assert.equal(good.status, 200);
});

test('the password path still enrolls with an offer file configured', async () => {
  const { app, enrollTokenFile } = await appWithOffer(offer());
  const res = await enroll(app, { password: PASSWORD });
  assert.equal(res.status, 200);
  assert.equal(typeof (await res.json()).hostToken, 'string');
  // The offer belongs to the token path; a password enrollment leaves it.
  assert.equal(await fileGone(enrollTokenFile), false);
});

test('a wrong password is still refused when an offer file is configured', async () => {
  const { app } = await appWithOffer(offer());
  const res = await enroll(app, { password: 'wrong' });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'invalid setup password' });
});
