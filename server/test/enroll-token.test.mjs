/**
 * One-click enrollment (docs/specs/server.md, Configuration ->
 * `DORMOUSE_ENROLL_TOKEN_FILE`): `POST /api/host/enroll` redeeming the
 * installer's single-use offer file instead of the setup password.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { API_ROUTES, UNAUTHORIZED_ERROR } from 'server-lib-common';

import { redeemEnrollToken } from '../dist/enroll-token.js';
import { ORIGIN, PASSWORD, RP_ID, freshApp, post } from './helpers.mjs';

const TOKEN = 'a1b2c3d4'.repeat(8);
const DAY_MS = 24 * 60 * 60 * 1000;

/** An ISO stamp `ms` in the past; a negative `ms` dates the offer forward. */
function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function offer(overrides = {}) {
  return { origin: ORIGIN, token: TOKEN, mintedAt: ago(0), ...overrides };
}

/** A fresh temp path, holding `contents` unless it is `undefined`. */
async function offerPath(contents) {
  const dir = await mkdtemp(join(tmpdir(), 'dormouse-enroll-'));
  const path = join(dir, 'enroll-token.json');
  if (contents !== undefined) {
    await writeFile(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return path;
}

/** Run `fn` with `console.warn` captured, returning the lines it emitted. */
async function captureWarnings(fn) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

/**
 * An app whose `enrollTokenFile` points at a fresh temp path. `contents` is
 * written verbatim when it is a string, JSON-encoded when it is an object, and
 * `undefined` leaves the path with no file at all.
 */
async function appWithOffer(contents, options = {}) {
  const enrollTokenFile = await offerPath(contents);
  const created = await freshApp({ enrollTokenFile, ...options });
  return { ...created, enrollTokenFile };
}

function enroll(app, body) {
  return post(app, API_ROUTES.hostEnroll, body);
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
  assert.equal(existsSync(enrollTokenFile), false);
  // Redemption claims by rename before it unlinks; the happy path leaves the
  // directory empty rather than littered with a `.spent-*` file.
  assert.deepEqual(await readdir(dirname(enrollTokenFile)), []);
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
  assert.equal(existsSync(enrollTokenFile), true);
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

// The one test that measures the credential-failure delay, so it injects a wait
// big enough to see and small enough to pay: the constant's real 250ms is a
// policy choice, and asserting it here would only buy sleep.
const MEASURABLE_DELAY_MS = 60;
const measurableDelay = () => new Promise((resolve) => setTimeout(resolve, MEASURABLE_DELAY_MS));

test('a token that cannot be invalidated is not redeemed', CANNOT_DENY_UNLINK, async () => {
  const { app, enrollTokenFile, stateDir } = await appWithOffer(offer(), {
    credentialFailureDelay: measurableDelay,
  });
  await chmod(dirname(enrollTokenFile), 0o500);
  try {
    const started = Date.now();
    const res = await enroll(app, { enrollToken: TOKEN });
    assert.equal(res.status, 500);
    // Only a successful compare reaches this 500, so it waits out the same
    // credential-failure delay: a fast distinct answer would confirm a valid
    // token to a guesser without spending it.
    assert.equal(Date.now() - started >= MEASURABLE_DELAY_MS, true);
    // The point of the ordering: no host may exist against a token still on disk.
    assert.equal(existsSync(join(stateDir, 'hosts.json')), false);
  } finally {
    await chmod(dirname(enrollTokenFile), 0o700);
  }
});

test('an offer goes stale: a day-old or unparseable stamp is refused', async () => {
  for (const mintedAt of [ago(DAY_MS + 1_000), 'last Tuesday']) {
    const { app, enrollTokenFile } = await appWithOffer(offer({ mintedAt }));
    const res = await enroll(app, { enrollToken: TOKEN });
    assert.equal(res.status, 401, mintedAt);
    assert.deepEqual(await res.json(), { error: UNAUTHORIZED_ERROR }, mintedAt);
    // A stale offer is refused, not spent: the installer's next run rewrites it.
    assert.equal(existsSync(enrollTokenFile), true, mintedAt);
  }
});

test('a future-dated offer still redeems: clock skew must not brick the install', async () => {
  const { app } = await appWithOffer(offer({ mintedAt: ago(-DAY_MS) }));
  assert.equal((await enroll(app, { enrollToken: TOKEN })).status, 200);
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

test('exactly one counts presence, not type: a mistyped lone credential is a 401', async () => {
  const { app, enrollTokenFile } = await appWithOffer(offer());
  // Two keys present, one of them nonsense: still two credentials, still a 400.
  assert.equal((await enroll(app, { password: PASSWORD, enrollToken: 42 })).status, 400);
  // One key of the wrong type belongs to that credential's branch, which
  // answers like any other bad credential rather than blaming the shape.
  const loneToken = await enroll(app, { enrollToken: null });
  assert.equal(loneToken.status, 401);
  assert.deepEqual(await loneToken.json(), { error: UNAUTHORIZED_ERROR });
  assert.equal((await enroll(app, { password: 42 })).status, 401);
  assert.equal(existsSync(enrollTokenFile), true);
});

test('a token that is not 64 hex characters is refused, offer untouched', async () => {
  const { app, enrollTokenFile } = await appWithOffer(offer());
  const res = await enroll(app, { enrollToken: 'not a 64-hex token' });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: UNAUTHORIZED_ERROR });
  assert.equal(existsSync(enrollTokenFile), true);
});

test('the first password enrollment consumes the offer', async () => {
  const { app, enrollTokenFile } = await appWithOffer(offer());
  const res = await enroll(app, { password: PASSWORD });
  assert.equal(res.status, 200);
  assert.equal(typeof (await res.json()).hostToken, 'string');
  assert.equal(existsSync(enrollTokenFile), false);
  // Recreating the file cannot reopen bootstrap: hosts.json records that the
  // first enrollment already happened, and the stale file is cleaned up.
  await writeFile(enrollTokenFile, JSON.stringify(offer()));
  assert.equal((await enroll(app, { enrollToken: TOKEN })).status, 401);
  assert.equal(existsSync(enrollTokenFile), false);
});

test('a first password enrollment stops if the offer cannot be invalidated', CANNOT_DENY_UNLINK, async () => {
  const { app, enrollTokenFile, stateDir } = await appWithOffer(offer());
  await chmod(dirname(enrollTokenFile), 0o500);
  try {
    const res = await enroll(app, { password: PASSWORD });
    assert.equal(res.status, 500);
    assert.equal(existsSync(join(stateDir, 'hosts.json')), false);
  } finally {
    await chmod(dirname(enrollTokenFile), 0o700);
  }
});

// --- redeemEnrollToken directly: the claim race and the operator warning ---

test('concurrent redemptions of one offer have exactly one winner', async () => {
  const path = await offerPath(offer());
  // Every one of these presents the correct token, and they all read the offer
  // before any of them claims it. Only the rename can separate them: deleting
  // cannot, because two concurrent unlinks of one path both report success on
  // APFS, which would mint a Host enrollment per racer off a single-use offer.
  const results = await Promise.all(
    Array.from({ length: 8 }, () => redeemEnrollToken(path, TOKEN)),
  );
  const tally = (outcome) => results.filter((r) => r === outcome).length;
  assert.equal(tally('redeemed'), 1);
  // The seven losers are ordinary rejections, never `not-invalidated` — the 500
  // reserved for an offer that truly cannot be spent.
  assert.equal(tally('rejected'), 7);
  assert.equal(existsSync(path), false);
  assert.deepEqual(await readdir(dirname(path)), []);
});

test('an installer rerun between the read and the claim keeps its fresh offer', async () => {
  const path = await offerPath(offer());
  const fresh = offer({ token: 'f0e1d2c3'.repeat(8) });
  // The seam fires after the supplied token is verified against the file and
  // before the claim renames it — the one window where a redemption would
  // otherwise spend an offer it never read.
  const result = await redeemEnrollToken(path, TOKEN, () => writeFile(path, JSON.stringify(fresh)));
  assert.equal(result, 'rejected');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), fresh);
  assert.deepEqual(await readdir(dirname(path)), ['enroll-token.json']);
  // Restored, not merely present: the operator's new offer still redeems.
  assert.equal(await redeemEnrollToken(path, fresh.token), 'redeemed');
});

test('releasing a claim never clobbers a still-newer installer offer', async () => {
  const path = await offerPath(offer());
  const fresh = offer({ token: 'f0e1d2c3'.repeat(8) });
  const newest = offer({ token: '01234567'.repeat(8) });
  const result = await redeemEnrollToken(
    path,
    TOKEN,
    () => writeFile(path, JSON.stringify(fresh)),
    // Runs after `fresh` has been claimed and found not to match the original,
    // exactly where a second atomic installer publication can land.
    () => writeFile(path, JSON.stringify(newest)),
  );
  assert.equal(result, 'rejected');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), newest);
  assert.equal(await redeemEnrollToken(path, newest.token), 'redeemed');
});

test('an offer deleted mid-redemption rejects, whichever half lost', async () => {
  const path = await offerPath(offer());
  const redemption = redeemEnrollToken(path, TOKEN);
  await unlink(path);
  assert.equal(await redemption, 'rejected');
});

test('a file that exists but is not an offer warns the operator, naming it', async () => {
  for (const contents of ['not json at all', offer({ token: TOKEN.slice(0, 32) })]) {
    const path = await offerPath(contents);
    const warnings = await captureWarnings(async () => {
      assert.equal(await redeemEnrollToken(path, TOKEN), 'rejected');
    });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].includes(path), true, warnings[0]);
  }
});

test('a spent offer is silent: an absent file is the ordinary state', async () => {
  const path = await offerPath(undefined);
  const warnings = await captureWarnings(async () => {
    assert.equal(await redeemEnrollToken(path, TOKEN), 'rejected');
  });
  assert.deepEqual(warnings, []);
});

test('a junk-format token is refused without reading the file', async () => {
  // Point the config at a directory, so any read of it fails — and a failed
  // read warns. No warning is the proof that no read happened.
  const dir = dirname(await offerPath(offer()));
  const skipped = await captureWarnings(async () => {
    assert.equal(await redeemEnrollToken(dir, 'not-hex'), 'rejected');
  });
  assert.deepEqual(skipped, []);
  const attempted = await captureWarnings(async () => {
    assert.equal(await redeemEnrollToken(dir, TOKEN), 'rejected');
  });
  assert.equal(attempted.length, 1);
});
