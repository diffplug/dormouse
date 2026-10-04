import { test, expect } from "vitest";
import { createDecipheriv, createECDH, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { digest } from "@pgstencil/auth/security";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { createTestContext } from "pgstencil/testing";
import { queryDatabase, withClient } from "pgstencil/postgres";
import {
  API_ROUTES,
  MAX_ENROLLED_BURROWS,
  MAX_PENDING_REAUTH_NONCES_PER_SESSION,
  MAX_PUSH_QUERY_DELIVERY_IDS,
  MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT,
  MAX_PUSH_SUBSCRIPTIONS_PER_BURROW,
  MAX_TOKENS_PER_BURROW,
  NOT_ENTITLED_ERROR,
  SETUP_TOKEN_INVALID_ERROR,
  UNAUTHORIZED_ERROR,
  enrollUserCode,
  fromBase64Url,
  generateNoiseKeyPair,
  openPush,
  pushSubscriptionDeletePath,
  sealPush,
  utf8Encode,
  isEnrollUserCode,
  isManagedVoiceToken,
  isRelayBearer,
  toBase64Url,
  verifyPresenceProof,
  type PresenceBinding,
} from "remote-lib-common";
import {
  SimAuthenticator,
  randomRoutingId,
  randomSecret,
  registrationClientData,
} from "../../../remote-lib-common/test/harness/actors.mjs";
import { ADMIN_EMAIL } from "../entitlement";
import { migrations } from "../migrations";
import { ENROLLMENT_TTL_MS } from "../policy-constants";
import {
  ENROLLMENT_POLL_INTERVAL_S,
  MAX_PASSKEYS_PER_ACCOUNT,
  MAX_SESSIONS_PER_ACCOUNT,
  MAX_SETUP_CHALLENGES_PER_BURROW,
  SESSIONS,
  admit,
  restoreSetupToken,
} from "../relay-api";
import type { Client } from "../relay-auth";
import { upsertSubscription } from "../relay-push";
import { workerDatabases } from "./worker-roles";
import {
  ENTRIES,
  ORIGINS,
  TEST_ENROLL_SECRET,
  bundleWorker,
  miniflareOptions,
  testVapidKeys,
} from "./bundle";
import { limitOf, untilLimited } from "./rate-limit";

// The Hosted Relay's routes (`docs/specs/hosted.md` -> "Relay") in real
// workerd against real Postgres, driven the way Pocket and a Burrow drive the
// self-host Relay: `SimAuthenticator` produces real WebAuthn, and each
// presence proof is checked with the Burrow's own verifier.

const origin = ORIGINS.relay;
const rpId = new URL(origin).hostname;
const script = bundleWorker(ENTRIES.relay);

type Authenticator = Awaited<ReturnType<typeof SimAuthenticator.create>>;

/** One request the relay sent a push service. */
interface Pushed {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

async function fixture({ bindings = {} }: { bindings?: Record<string, string | undefined> } = {}) {
  const context = await createTestContext({ migrations });
  const databases = await workerDatabases(context.database.url);
  // The push services: every request is recorded, then answered by `answer`.
  const pushed: Pushed[] = [];
  let answer: (url: URL) => WorkerResponse | Promise<WorkerResponse> = () =>
    new WorkerResponse(null, { status: 201 });
  const relay = new Miniflare(
    miniflareOptions("relay", (await script).outputFiles[0].text, {
      bindings: Object.fromEntries(
        Object.entries({
          APP_ORIGIN: origin,
          ACCOUNT_ORIGIN: ORIGINS.account,
          RELAY_ENROLL_SECRET: TEST_ENROLL_SECRET,
          ...testVapidKeys(),
          ...bindings,
        }).filter(([, value]) => value !== undefined),
      ) as Record<string, string>,
      hyperdrives: { HYPERDRIVE: databases.relay },
      serviceBindings: {
        ASSETS: () =>
          new WorkerResponse("<!doctype html>", {
            headers: { "content-type": "text/html" },
          }),
      },
      async outboundService(request) {
        pushed.push({
          url: request.url,
          headers: Object.fromEntries(request.headers),
          body: Buffer.from(await request.arrayBuffer()),
        });
        return answer(new URL(request.url));
      },
    }),
  );
  try {
    await relay.ready;
  } catch (error) {
    await relay.dispose();
    await context.close();
    throw error;
  }
  const sql = <Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ) => queryDatabase<Row>(context.database.url, text, values);
  let addresses = 0;

  /** One request; each from its own address unless `ip` names one. */
  async function call(
    method: string,
    path: string,
    { body, bearer, ip }: { body?: unknown; bearer?: string; ip?: string } = {},
  ) {
    const response = await relay.dispatchFetch(origin + path, {
      method,
      headers: {
        "cf-connecting-ip": ip ?? `198.51.100.${++addresses % 250}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      json: (text ? JSON.parse(text) : null) as Record<string, any> | null,
    };
  }

  /** A user row; entitled while its verified email is `ADMIN_EMAIL`. */
  async function account(email = `${randomUUID()}@example.test`, emailVerified = true) {
    const id = randomUUID();
    await sql(
      `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, $4)`,
      [id, email, email, emailVerified],
    );
    return id;
  }

  /**
   * Makes `userId` the one entitled account: `ADMIN_EMAIL` is unique, so
   * whoever held it gets another address first.
   */
  async function entitle(userId: string) {
    await sql(`UPDATE "user" SET email = id || '@example.test' WHERE email = $1`, [ADMIN_EMAIL]);
    await sql(`UPDATE "user" SET email = $2, "emailVerified" = true WHERE id = $1`, [
      userId,
      ADMIN_EMAIL,
    ]);
  }

  /** An enrolled Burrow, as the device-code poll writes one. */
  async function burrow(userId: string) {
    const burrowId = randomRoutingId();
    const token = randomSecret();
    await sql(
      `INSERT INTO dormouse_relay_burrows ("burrowId", "userId", "tokenHash") VALUES ($1, $2, $3)`,
      [burrowId, userId, digest(token)],
    );
    return { burrowId, token };
  }

  const mint = (burrowToken: string) =>
    call("POST", API_ROUTES.burrowSetupToken, { bearer: burrowToken });

  async function setupToken(burrowToken: string) {
    const minted = await mint(burrowToken);
    expect(minted.status).toBe(200);
    return minted.json!.token as string;
  }

  /** begin → finish registration, as Pocket's `setup` sends it. */
  async function register(
    authenticator: Authenticator,
    token: string,
    { finishWith = token, clientOrigin = origin, label = "Phone" } = {},
  ) {
    const begin = await call("POST", API_ROUTES.setupBegin, { body: { setupToken: token } });
    if (begin.status !== 200) return begin;
    return finish(authenticator, finishWith, begin.json!.challenge, { clientOrigin, label });
  }

  const finish = (
    authenticator: Authenticator,
    token: string,
    challenge: string,
    { clientOrigin = origin, label = "Phone" } = {},
  ) =>
    call("POST", API_ROUTES.setupFinish, {
      body: {
        setupToken: token,
        credentialId: authenticator.credentialId,
        publicKey: authenticator.publicKey,
        clientDataJSON: registrationClientData({ challenge, origin: clientOrigin }),
        label,
      },
    });

  async function signin(authenticator: Authenticator, ip?: string) {
    const begin = await call("POST", API_ROUTES.signinBegin, { ip });
    expect(begin.status).toBe(200);
    expect(begin.json!.rpId).toBe(rpId);
    const assertion = await authenticator.assert({ challenge: begin.json!.challenge, origin });
    return call("POST", API_ROUTES.signinFinish, { body: { assertion } });
  }

  async function session(authenticator: Authenticator) {
    const signed = await signin(authenticator);
    expect(signed.status).toBe(200);
    return signed.json as { sessionToken: string; accountId: string; expiresAt: number };
  }

  const pairing = (burrowId: string, authenticator: Authenticator): PresenceBinding => ({
    kind: "pairing",
    burrowId,
    handshakeHash: randomSecret(),
    passkeyCredentialId: authenticator.credentialId,
  });

  /** One presence proof through `/api/reauth/*`, as Pocket's `#provePresence` builds it. */
  async function prove(
    sessionToken: string,
    accountId: string,
    authenticator: Authenticator,
    binding: PresenceBinding,
  ) {
    const begin = await call("POST", API_ROUTES.reauthBegin, {
      bearer: sessionToken,
      body: { binding },
    });
    expect(begin.status).toBe(200);
    expect(begin.json!.allowCredentials).toEqual([binding.passkeyCredentialId]);
    const assertion = await authenticator.assert({ challenge: begin.json!.challenge, origin });
    const finished = await call("POST", API_ROUTES.reauthFinish, {
      bearer: sessionToken,
      body: { relayNonce: begin.json!.relayNonce, assertion },
    });
    return {
      finished,
      proof: {
        binding,
        relayNonce: begin.json!.relayNonce as string,
        accountId,
        passkeyCredentialId: binding.passkeyCredentialId,
        passkeyPublicKey: authenticator.publicKey,
        assertion,
      },
    };
  }

  /** A device-code enrollment begun as the Burrow begins one. */
  async function begin() {
    const begun = await call("POST", API_ROUTES.burrowEnrollBegin, { body: { origin } });
    expect(begun.status).toBe(200);
    return begun.json as {
      deviceCode: string;
      userCode: string;
      verificationUrl: string;
      expiresAt: number;
      interval: number;
    };
  }

  const poll = (deviceCode: unknown) =>
    call("POST", API_ROUTES.burrowEnrollPoll, { body: { deviceCode } });

  /** What the account Worker's approval writes (`hosted/server/relay-account.ts`). */
  const approve = (userCode: string, userId: string) =>
    sql(
      `INSERT INTO dormouse_relay_enrollment_approvals ("userCode", "userId", "expiresAt")
      VALUES ($1, $2, now() + interval '10 minutes')`,
      [userCode, userId],
    );

  /** The relay's Cron Trigger, as Cloudflare fires it. */
  async function cron() {
    // Without @cloudflare/workers-types, the Fetcher's scheduled() is untyped.
    const worker = (await relay.getWorker()) as unknown as {
      scheduled(options: { cron: string }): Promise<{ outcome: string }>;
    };
    expect((await worker.scheduled({ cron: "0 * * * *" })).outcome).toBe("ok");
  }

  return {
    sql,
    cron,
    pushed,
    answerPushes: (respond: typeof answer) => {
      answer = respond;
    },
    entitle,
    /** The database as the relay Worker's role, for its code called directly. */
    url: databases.relay,
    /** The database as the migration role, for the account Worker's writes. */
    ownerUrl: context.database.url,
    call,
    account,
    burrow,
    begin,
    poll,
    approve,
    mint,
    setupToken,
    register,
    finish,
    signin,
    session,
    pairing,
    prove,
    close: async () => {
      await relay.dispose();
      await context.close();
    },
  };
}

// Typed by hand: the harness is plain JavaScript, its options inferred from a `{}` default.
const createAuthenticator = SimAuthenticator.create as unknown as (options: {
  rpId: string;
  userVerification?: boolean;
}) => ReturnType<typeof SimAuthenticator.create>;
const newAuthenticator = () => createAuthenticator({ rpId, userVerification: false });

test("setup, sign-in, and a presence proof end to end, scoped to the account that owns the Burrow", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const owner = await f.account(ADMIN_EMAIL);
  const laptop = await f.burrow(owner);
  const phone = await newAuthenticator();

  const token = await f.setupToken(laptop.token);
  const registered = await f.register(phone, token);
  expect(registered.status).toBe(200);
  // The account's immutable id where the self-host Relay answers 'owner'.
  expect(registered.json).toEqual({ accountId: owner, credentialId: phone.credentialId });
  expect(await f.sql(`SELECT "userId", label FROM dormouse_relay_passkeys`)).toEqual([
    { userId: owner, label: "Phone" },
  ]);
  // Spent: the code cannot register a second passkey.
  expect((await f.register(await newAuthenticator(), token)).json).toEqual({
    error: SETUP_TOKEN_INVALID_ERROR,
  });

  const signed = await f.signin(phone);
  expect(signed.status).toBe(200);
  expect(signed.json).toMatchObject({ accountId: owner, passkeyPublicKey: phone.publicKey });
  const { sessionToken, expiresAt } = signed.json!;
  expect(Math.abs(expiresAt - (Date.now() + 12 * 3600_000))).toBeLessThan(60_000);
  // Counted after the response, as a number and nothing else (docs/specs/hosted.md -> "Metrics").
  await expect.poll(() => f.sql(`SELECT event, label, count::int FROM dormouse_metrics_daily`)).toEqual([
    { event: "pocket.signin", label: "", count: 1 },
  ]);

  expect(
    (await f.call("GET", API_ROUTES.burrows, { bearer: sessionToken })).json,
  ).toEqual({ burrows: [{ burrowId: laptop.burrowId, online: false }] });

  const binding = f.pairing(laptop.burrowId, phone);
  const { finished, proof } = await f.prove(sessionToken, owner, phone, binding);
  expect(finished.status).toBe(200);
  expect(typeof finished.json!.verifiedAt).toBe("number");
  // What the Burrow checks: the proof verifies against the binding it built.
  expect(await verifyPresenceProof(proof, binding, { origin, rpId })).toMatchObject({ ok: true });
  // One use: the same nonce never proves presence twice.
  expect(
    (
      await f.call("POST", API_ROUTES.reauthFinish, {
        bearer: sessionToken,
        body: { relayNonce: proof.relayNonce, assertion: proof.assertion },
      })
    ).json,
  ).toEqual({ error: "unrecognized or expired nonce" });

  // A signed-in phone retires a scanned code without registering anything.
  const scanned = await f.setupToken(laptop.token);
  expect(
    (await f.call("POST", API_ROUTES.setupRetire, { bearer: sessionToken, body: { setupToken: scanned } }))
      .status,
  ).toBe(204);
  expect(
    (await f.call("POST", API_ROUTES.setupBegin, { body: { setupToken: scanned } })).json,
  ).toEqual({ error: SETUP_TOKEN_INVALID_ERROR });

  // Every bearer secret is at rest only as its SHA-256.
  const fresh = await f.setupToken(laptop.token);
  expect(await f.sql(`SELECT "tokenHash" FROM dormouse_relay_sessions`)).toEqual([
    { tokenHash: digest(sessionToken) },
  ]);
  expect(await f.sql(`SELECT "tokenHash" FROM dormouse_relay_setup_tokens`)).toEqual([
    { tokenHash: digest(fresh) },
  ]);
  expect(await f.sql(`SELECT "tokenHash" FROM dormouse_relay_burrows`)).toEqual([
    { tokenHash: digest(laptop.token) },
  ]);

  // An account's rows die with it.
  await f.sql(`DELETE FROM "user" WHERE id = $1`, [owner]);
  for (const table of ["burrows", "passkeys", "sessions", "setup_tokens", "challenges", "presence_nonces"])
    expect(await f.sql(`SELECT * FROM dormouse_relay_${table}`), table).toEqual([]);
});

test("one setup token registers once, however many finishes race it", async ({ onTestFinished }) => {
  const f = await fixture();
  onTestFinished(f.close);
  const laptop = await f.burrow(await f.account(ADMIN_EMAIL));
  const token = await f.setupToken(laptop.token);
  // `begin` peeks, so both racers hold a live challenge.
  const challenges = await Promise.all(
    [0, 1].map(async () =>
      (await f.call("POST", API_ROUTES.setupBegin, { body: { setupToken: token } })).json!
        .challenge as string,
    ),
  );
  const [first, second] = [await newAuthenticator(), await newAuthenticator()];
  const results = await Promise.all([
    f.finish(first, token, challenges[0]),
    f.finish(second, token, challenges[1]),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
  expect(await f.sql(`SELECT count(*)::int AS n FROM dormouse_relay_passkeys`)).toEqual([{ n: 1 }]);

  // A sign-in assertion is single-use too.
  const phone = results[0].status === 200 ? first : second;
  const begin = await f.call("POST", API_ROUTES.signinBegin);
  const assertion = await phone.assert({ challenge: begin.json!.challenge, origin });
  const signins = await Promise.all(
    [0, 1].map(() => f.call("POST", API_ROUTES.signinFinish, { body: { assertion } })),
  );
  expect(signins.map((result) => result.status).sort()).toEqual([200, 400]);
});

test("a refused finish puts the token back on its own expiry; a removed Burrow's tokens die with it", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const laptop = await f.burrow(await f.account(ADMIN_EMAIL));
  const phone = await newAuthenticator();
  const token = await f.setupToken(laptop.token);
  const expiry = await f.sql(`SELECT "expiresAt" FROM dormouse_relay_setup_tokens`);
  const refused = await f.register(phone, token, { clientOrigin: "https://evil.example" });
  expect(refused).toMatchObject({ status: 400, json: { error: "origin mismatch" } });
  expect(await f.sql(`SELECT "expiresAt" FROM dormouse_relay_setup_tokens`)).toEqual(expiry);
  for (const [field, value, error] of [
    ["publicKey", "AAAA", "unimportable public key"],
    ["credentialId", "not base64url!", "malformed credentialId"],
  ]) {
    const begin = await f.call("POST", API_ROUTES.setupBegin, { body: { setupToken: token } });
    const response = await f.call("POST", API_ROUTES.setupFinish, {
      body: {
        setupToken: token,
        credentialId: phone.credentialId,
        publicKey: phone.publicKey,
        label: "x",
        clientDataJSON: registrationClientData({ challenge: begin.json!.challenge, origin }),
        [field]: value,
      },
    });
    expect(response).toMatchObject({ status: 400, json: { error } });
  }
  expect((await f.register(phone, token)).status).toBe(200);
  // The same credential cannot be registered twice.
  expect(await f.register(phone, await f.setupToken(laptop.token))).toMatchObject({
    status: 409,
    json: { error: "credential already registered" },
  });

  const pending = await f.setupToken(laptop.token);
  await f.call("POST", API_ROUTES.setupBegin, { body: { setupToken: pending } });
  // Removal deletes the row, its setup tokens and setup challenges with it.
  await f.sql(`DELETE FROM dormouse_relay_burrows`);
  for (const table of ["setup_tokens", "challenges"])
    expect(await f.sql(`SELECT count(*)::int AS n FROM dormouse_relay_${table} WHERE "burrowId" IS NOT NULL`), table).toEqual([
      { n: 0 },
    ]);
  expect((await f.call("POST", API_ROUTES.setupBegin, { body: { setupToken: pending } })).json).toEqual({
    error: SETUP_TOKEN_INVALID_ERROR,
  });
  expect(await f.mint(laptop.token)).toMatchObject({ status: 401, json: { error: UNAUTHORIZED_ERROR } });
});

test("a setup challenge redeems only with its own Burrow's tokens", async ({ onTestFinished }) => {
  const f = await fixture();
  onTestFinished(f.close);
  const owner = await f.account(ADMIN_EMAIL);
  const [laptop, desktop] = [await f.burrow(owner), await f.burrow(owner)];
  const phone = await newAuthenticator();
  const token = await f.setupToken(laptop.token);
  const other = await f.setupToken(desktop.token);
  const begin = await f.call("POST", API_ROUTES.setupBegin, { body: { setupToken: token } });
  expect(await f.finish(phone, other, begin.json!.challenge)).toMatchObject({
    status: 400,
    json: { error: "unrecognized or expired challenge" },
  });
  // Nor does a sign-in challenge register.
  const signinChallenge = (await f.call("POST", API_ROUTES.signinBegin)).json!.challenge;
  expect((await f.finish(phone, token, signinChallenge)).json).toEqual({
    error: "unrecognized or expired challenge",
  });
  // Both codes survive the refusals, and the challenge is still its own Burrow's.
  expect((await f.finish(phone, token, begin.json!.challenge)).status).toBe(200);
  const otherBegin = await f.call("POST", API_ROUTES.setupBegin, { body: { setupToken: other } });
  expect(otherBegin.status).toBe(200);
  // A setup challenge never signs in, even for a registered credential.
  const assertion = await phone.assert({ challenge: otherBegin.json!.challenge, origin });
  expect((await f.call("POST", API_ROUTES.signinFinish, { body: { assertion } })).json).toEqual({
    error: "unrecognized or expired challenge",
  });
});

test("another account's session sees, proves with, and retires none of this account's rows", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const a = await f.account(ADMIN_EMAIL);
  const b = await f.account();
  const [laptopA, laptopB] = [await f.burrow(a), await f.burrow(b)];
  const [phoneA, phoneB] = [await newAuthenticator(), await newAuthenticator()];
  expect((await f.register(phoneA, await f.setupToken(laptopA.token))).status).toBe(200);
  // B's passkey, written as a registration off B's own Burrow would write it.
  await f.sql(
    `INSERT INTO dormouse_relay_passkeys ("credentialId", "userId", "publicKey", label) VALUES ($1, $2, $3, '')`,
    [phoneB.credentialId, b, phoneB.publicKey],
  );
  // One account is entitled at a time, and each request rechecks it: each
  // account acts while it holds `ADMIN_EMAIL`.
  const sessionA = await f.session(phoneA);
  await f.entitle(b);
  const sessionB = await f.session(phoneB);
  expect([sessionA.accountId, sessionB.accountId]).toEqual([a, b]);

  expect((await f.call("GET", API_ROUTES.burrows, { bearer: sessionB.sessionToken })).json).toEqual({
    burrows: [{ burrowId: laptopB.burrowId, online: false }],
  });
  // B cannot ask for a proof with A's credential…
  expect(
    await f.call("POST", API_ROUTES.reauthBegin, {
      bearer: sessionB.sessionToken,
      body: { binding: f.pairing(laptopA.burrowId, phoneA) },
    }),
  ).toMatchObject({ status: 404, json: { error: "unknown credential" } });
  // …nor spend A's nonce, which A still redeems.
  await f.entitle(a);
  const binding = f.pairing(laptopA.burrowId, phoneA);
  const begin = await f.call("POST", API_ROUTES.reauthBegin, {
    bearer: sessionA.sessionToken,
    body: { binding },
  });
  const assertion = await phoneA.assert({ challenge: begin.json!.challenge, origin });
  const finish = (bearer: string) =>
    f.call("POST", API_ROUTES.reauthFinish, {
      bearer,
      body: { relayNonce: begin.json!.relayNonce, assertion },
    });
  const code = await f.setupToken(laptopA.token);
  await f.entitle(b);
  expect(await finish(sessionB.sessionToken)).toMatchObject({
    status: 400,
    json: { error: "unrecognized or expired nonce" },
  });
  // B cannot retire A's code, which still registers for A.
  expect(
    await f.call("POST", API_ROUTES.setupRetire, { bearer: sessionB.sessionToken, body: { setupToken: code } }),
  ).toMatchObject({ status: 401, json: { error: SETUP_TOKEN_INVALID_ERROR } });
  await f.entitle(a);
  expect((await finish(sessionA.sessionToken)).status).toBe(200);
  const begun = await f.call("POST", API_ROUTES.setupBegin, { body: { setupToken: code } });
  // Only A's own credentials are excluded, never B's.
  expect(begun.json).toMatchObject({ accountId: a, existingCredentialIds: [phoneA.credentialId] });

  // B's Burrow mints nothing for an account that is not entitled.
  expect(await f.mint(laptopB.token)).toMatchObject({ status: 403, json: { error: NOT_ENTITLED_ERROR } });
});

test("the entitlement is rechecked on every Burrow request and every setup redemption", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const owner = await f.account(ADMIN_EMAIL);
  const laptop = await f.burrow(owner);
  const token = await f.setupToken(laptop.token);
  const begun = await f.call("POST", API_ROUTES.setupBegin, { body: { setupToken: token } });
  await f.sql(`UPDATE "user" SET "emailVerified" = false`);
  expect(await f.mint(laptop.token)).toMatchObject({ status: 403, json: { error: NOT_ENTITLED_ERROR } });
  expect((await f.call("POST", API_ROUTES.setupBegin, { body: { setupToken: token } })).json).toEqual({
    error: SETUP_TOKEN_INVALID_ERROR,
  });
  // A registration already begun is refused at finish too.
  expect((await f.finish(await newAuthenticator(), token, begun.json!.challenge)).json).toEqual({
    error: SETUP_TOKEN_INVALID_ERROR,
  });
  await f.sql(`UPDATE "user" SET "emailVerified" = true`);
  const next = await f.setupToken(laptop.token);
  expect((await f.call("POST", API_ROUTES.setupBegin, { body: { setupToken: next } })).status).toBe(200);
  await f.sql(`UPDATE "user" SET email = 'someone@example.test'`);
  expect((await f.mint(laptop.token)).status).toBe(403);
});

test("every table a caller grows is capped by whoever grows it, and expired rows are refused and pruned", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const owner = await f.account(ADMIN_EMAIL);
  const laptop = await f.burrow(owner);
  const desktop = await f.burrow(owner);
  const count = async (table: string, where = "true", values: unknown[] = []) =>
    (await f.sql<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, values))[0].n;

  // Setup tokens: per Burrow, that Burrow's own oldest first.
  const other = await f.setupToken(desktop.token);
  const tokens = [];
  for (let i = 0; i <= MAX_TOKENS_PER_BURROW; i++) tokens.push(await f.setupToken(laptop.token));
  expect(await count("dormouse_relay_setup_tokens", `"burrowId" = $1`, [laptop.burrowId])).toBe(
    MAX_TOKENS_PER_BURROW,
  );
  expect((await f.call("POST", API_ROUTES.setupBegin, { body: { setupToken: tokens[0] } })).status).toBe(401);
  expect((await f.call("POST", API_ROUTES.setupBegin, { body: { setupToken: other } })).status).toBe(200);

  // Setup challenges: per Burrow.
  for (let i = 0; i <= MAX_SETUP_CHALLENGES_PER_BURROW; i++)
    await f.call("POST", API_ROUTES.setupBegin, { body: { setupToken: tokens.at(-1) } });
  expect(await count("dormouse_relay_challenges", `"burrowId" = $1`, [laptop.burrowId])).toBe(
    MAX_SETUP_CHALLENGES_PER_BURROW,
  );

  // Passkeys: per account, refused rather than evicted, the code kept.
  for (let i = 1; i < MAX_PASSKEYS_PER_ACCOUNT; i++)
    await f.sql(
      `INSERT INTO dormouse_relay_passkeys ("credentialId", "userId", "publicKey", label) VALUES ($1, $2, 'x', '')`,
      [randomRoutingId(), owner],
    );
  const phone = await newAuthenticator();
  expect((await f.register(phone, tokens.at(-1)!)).status).toBe(200);
  const full = tokens.at(-2)!;
  expect(await f.register(await newAuthenticator(), full)).toMatchObject({
    status: 409,
    json: { error: `this account already has ${MAX_PASSKEYS_PER_ACCOUNT} passkeys` },
  });
  expect((await f.call("POST", API_ROUTES.setupBegin, { body: { setupToken: full } })).status).toBe(200);

  // Sessions: per account, its own oldest first.
  const sessions = [];
  for (let i = 0; i <= MAX_SESSIONS_PER_ACCOUNT; i++)
    sessions.push((await f.session(phone)).sessionToken);
  expect(await count("dormouse_relay_sessions")).toBe(MAX_SESSIONS_PER_ACCOUNT);
  expect(await f.call("GET", API_ROUTES.burrows, { bearer: sessions[0] })).toMatchObject({
    status: 401,
    json: { error: UNAUTHORIZED_ERROR },
  });

  // Presence nonces: per session, its own oldest first.
  const current = sessions.at(-1)!;
  const nonces = [];
  for (let i = 0; i <= MAX_PENDING_REAUTH_NONCES_PER_SESSION; i++)
    nonces.push(
      (
        await f.call("POST", API_ROUTES.reauthBegin, {
          bearer: current,
          body: { binding: f.pairing(laptop.burrowId, phone) },
        })
      ).json!.relayNonce,
    );
  expect(await count("dormouse_relay_presence_nonces")).toBe(MAX_PENDING_REAUTH_NONCES_PER_SESSION);
  const sibling = sessions.at(-2)!;
  await f.call("POST", API_ROUTES.reauthBegin, {
    bearer: sibling,
    body: { binding: f.pairing(laptop.burrowId, phone) },
  });
  // Another session's nonce costs this one nothing.
  expect(await count("dormouse_relay_presence_nonces")).toBe(MAX_PENDING_REAUTH_NONCES_PER_SESSION + 1);

  // Expired rows are refused; a write prunes only its own key's, the Cron Trigger the rest.
  await f.sql(`UPDATE dormouse_relay_sessions SET "expiresAt" = now() - interval '1 second' WHERE "tokenHash" = $1`, [
    digest(sibling),
  ]);
  expect((await f.call("GET", API_ROUTES.burrows, { bearer: sibling })).json).toEqual({
    error: UNAUTHORIZED_ERROR,
  });
  await f.sql(`UPDATE dormouse_relay_presence_nonces SET "expiresAt" = now() - interval '1 second'`);
  const assertion = await phone.assert({ challenge: "AAAA", origin });
  expect(
    (
      await f.call("POST", API_ROUTES.reauthFinish, {
        bearer: current,
        body: { relayNonce: nonces.at(-1), assertion },
      })
    ).json,
  ).toEqual({ error: "unrecognized or expired nonce" });
  await f.sql(`UPDATE dormouse_relay_setup_tokens SET "expiresAt" = now() - interval '1 second'`);
  expect((await f.call("POST", API_ROUTES.setupBegin, { body: { setupToken: other } })).status).toBe(401);
  await f.sql(`UPDATE dormouse_relay_challenges SET "expiresAt" = now() - interval '1 second'`);
  await f.session(phone);
  await f.call("POST", API_ROUTES.reauthBegin, {
    bearer: current,
    body: { binding: f.pairing(laptop.burrowId, phone) },
  });
  await f.setupToken(laptop.token);
  const expired = `"expiresAt" <= now()`;
  // The account's expired session went with the new one (and its nonces with
  // it), the session's own nonces with the new nonce, the laptop's tokens with
  // its mint…
  expect(await count("dormouse_relay_sessions", expired)).toBe(0);
  expect(await count("dormouse_relay_presence_nonces", expired)).toBe(0);
  expect(await count("dormouse_relay_setup_tokens", `${expired} AND "burrowId" = $1`, [laptop.burrowId])).toBe(0);
  // …but never another key's: the desktop's token and every challenge wait.
  expect(await count("dormouse_relay_setup_tokens", `${expired} AND "burrowId" = $1`, [desktop.burrowId])).toBe(1);
  expect(await count("dormouse_relay_challenges", expired)).toBeGreaterThan(0);
  const live = {
    sessions: await count("dormouse_relay_sessions"),
    nonces: await count("dormouse_relay_presence_nonces"),
    tokens: await count("dormouse_relay_setup_tokens", `NOT ${expired}`),
  };
  await f.cron();
  for (const table of ["sessions", "presence_nonces", "setup_tokens", "challenges"])
    expect(await count(`dormouse_relay_${table}`, expired), table).toBe(0);
  // The sweep takes nothing live.
  expect({
    sessions: await count("dormouse_relay_sessions"),
    nonces: await count("dormouse_relay_presence_nonces"),
    tokens: await count("dormouse_relay_setup_tokens"),
  }).toEqual(live);
});

test("restoring a setup token that has since expired never evicts a live one", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const owner = await f.account(ADMIN_EMAIL);
  const laptop = await f.burrow(owner);
  const live: string[] = [];
  for (let i = 0; i < MAX_TOKENS_PER_BURROW; i++) live.push(digest(await f.setupToken(laptop.token)));
  const hashes = async () =>
    (await f.sql<{ tokenHash: string }>(`SELECT "tokenHash" FROM dormouse_relay_setup_tokens`))
      .map((row) => row.tokenHash)
      .sort();
  const restore = (token: string, expiresAt: Date) =>
    withClient(f.url, (db) =>
      restoreSetupToken(db, token, { burrowId: laptop.burrowId, userId: owner, expiresAt }),
    );
  await restore(randomSecret(), new Date(Date.now() - 1000));
  expect(await hashes()).toEqual([...live].sort());
  // A live one is restored within the cap: the Burrow's oldest makes room.
  const back = randomSecret();
  await restore(back, new Date(Date.now() + 60_000));
  const after = await hashes();
  expect(after).toHaveLength(MAX_TOKENS_PER_BURROW);
  expect(after).toContain(digest(back));
});

test("a setup token that expires while its restore waits on the lock is not restored", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const owner = await f.account(ADMIN_EMAIL);
  const laptop = await f.burrow(owner);
  const live: string[] = [];
  for (let i = 0; i < MAX_TOKENS_PER_BURROW; i++) live.push(digest(await f.setupToken(laptop.token)));
  const expiresAt = new Date(Date.now() + 1000);
  // Another write holds the Burrow's token lock across the restored token's expiry.
  await withClient(f.url, async (holder) => {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `dormouse-relay:dormouse_relay_setup_tokens:${laptop.burrowId}`,
    ]);
    const restoring = withClient(f.url, (db) =>
      restoreSetupToken(db, randomSecret(), { burrowId: laptop.burrowId, userId: owner, expiresAt }),
    );
    await new Promise((resolve) => setTimeout(resolve, expiresAt.getTime() - Date.now() + 500));
    await holder.query("COMMIT");
    await restoring;
  });
  const hashes = (await f.sql<{ tokenHash: string }>(`SELECT "tokenHash" FROM dormouse_relay_setup_tokens`))
    .map((row) => row.tokenHash)
    .sort();
  expect(hashes).toEqual([...live].sort());
});

test("a de-entitled account signs in to nothing, and its sessions answer as expired", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const owner = await f.account(ADMIN_EMAIL);
  const laptop = await f.burrow(owner);
  const phone = await newAuthenticator();
  expect((await f.register(phone, await f.setupToken(laptop.token))).status).toBe(200);
  const { sessionToken } = await f.session(phone);
  const binding = f.pairing(laptop.burrowId, phone);
  const begun = await f.call("POST", API_ROUTES.reauthBegin, { bearer: sessionToken, body: { binding } });
  const assertion = await phone.assert({ challenge: begun.json!.challenge, origin });
  const code = await f.setupToken(laptop.token);
  const gated: [string, string, unknown][] = [
    ["GET", API_ROUTES.burrows, undefined],
    ["POST", API_ROUTES.reauthBegin, { binding }],
    ["POST", API_ROUTES.reauthFinish, { relayNonce: begun.json!.relayNonce, assertion }],
    ["POST", API_ROUTES.setupRetire, { setupToken: code }],
  ];

  await f.sql(`UPDATE "user" SET "emailVerified" = false`);
  for (const [method, path, body] of gated)
    expect(await f.call(method, path, { bearer: sessionToken, body }), path).toMatchObject({
      status: 401,
      json: { error: UNAUTHORIZED_ERROR },
    });
  expect(await f.signin(phone)).toMatchObject({ status: 401, json: { error: NOT_ENTITLED_ERROR } });
  expect(await f.sql(`SELECT count(*)::int AS n FROM dormouse_relay_sessions`)).toEqual([{ n: 1 }]);

  // Entitled again, the same session acts: nothing above spent the nonce or the code.
  await f.sql(`UPDATE "user" SET "emailVerified" = true`);
  const [, , finish, retire] = gated;
  for (const [[method, path, body], status] of [[retire, 204], [finish, 200]] as const)
    expect((await f.call(method, path, { bearer: sessionToken, body })).status, path).toBe(status);
});

test("every unauthenticated route that reaches Postgres is rate limited per address", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  let addresses = 0;
  for (const [routes, binding, error] of [
    [[API_ROUTES.signinBegin, API_ROUTES.signinFinish], "RELAY_SIGNIN_LIMIT", "too many sign-in attempts"],
    [[API_ROUTES.setupBegin, API_ROUTES.setupFinish], "RELAY_SETUP_LIMIT", "too many setup attempts"],
  ] as const) {
    const limit = limitOf(binding);
    // A ceremony's two routes spend one budget: alternating between them from
    // one address, exactly `limit` are admitted before the 429. A run that
    // straddles a window boundary admits more, and of two runs at most one
    // straddles. Each order ends the budget on the other route.
    for (const order of [routes, [...routes].reverse()]) {
      let admitted = 0;
      for (let run = 0; run < 2 && admitted !== limit; run++) {
        const ip = `203.0.113.${++addresses}`;
        admitted = 0;
        const limited = await untilLimited(limit, async (i) => {
          const response = await f.call("POST", order[i % 2], { ip, body: {} });
          if (response.status !== 429) admitted++;
          return response;
        });
        expect(limited, order[admitted % 2]).toMatchObject({ json: { error } });
        expect(limited.headers.get("retry-after")).toBe("60");
      }
      expect(admitted, "admitted before the 429, in one of two runs").toBe(limit);
    }
    // Another address is another caller.
    expect((await f.call("POST", routes[0], { ip: `203.0.113.${++addresses}`, body: {} })).status).not.toBe(429);
  }
});

/** `deviceCode` with its expiry set to `expiresAtS`, the rest kept. */
function withExpiry(deviceCode: string, expiresAtS: number) {
  const bytes = fromBase64Url(deviceCode);
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(0, expiresAtS);
  return toBase64Url(bytes);
}

test("a device-code enrollment: begin stores nothing, pending until approved, then one Burrow owned by its approver, once", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const owner = await f.account(ADMIN_EMAIL);
  const begun = await f.begin();
  // The bearer shape, its expiry in its first four bytes, and the user code the
  // secret's HMAC of it.
  expect(isRelayBearer(begun.deviceCode)).toBe(true);
  const bytes = fromBase64Url(begun.deviceCode);
  expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0) * 1000).toBe(begun.expiresAt);
  expect(Math.abs(begun.expiresAt - (Date.now() + ENROLLMENT_TTL_MS))).toBeLessThan(60_000);
  expect(isEnrollUserCode(begun.userCode)).toBe(true);
  expect(begun.userCode).toBe(await enrollUserCode(TEST_ENROLL_SECRET, bytes));
  expect(begun.verificationUrl).toBe(`${ORIGINS.account}/enroll#${begun.userCode}`);
  expect(begun.interval).toBe(ENROLLMENT_POLL_INTERVAL_S);
  // Begin wrote nothing (`pocket.test.ts` begins with no database at all).
  expect(await f.sql(`SELECT count(*)::int AS n FROM dormouse_relay_enrollment_approvals`)).toEqual([{ n: 0 }]);

  expect(await f.poll(begun.deviceCode)).toMatchObject({ status: 200, json: { status: "pending" } });
  for (const unknown of ["short", undefined, withExpiry(begun.deviceCode, Math.floor(Date.now() / 1000) - 1)])
    expect(await f.poll(unknown)).toMatchObject({ status: 200, json: { status: "expired" } });

  await f.approve(begun.userCode, owner);
  const enrolled = await f.poll(begun.deviceCode);
  expect(enrolled.status).toBe(200);
  const { enrollment, voiceToken } = enrolled.json as {
    enrollment: Record<string, string>;
    voiceToken: string;
  };
  expect(enrolled.json).toEqual({
    status: "enrolled",
    enrollment: { burrowId: enrollment.burrowId, burrowToken: enrollment.burrowToken, origin, rpId },
    voiceToken,
  });
  expect(await f.sql(`SELECT "burrowId", "userId", "tokenHash" FROM dormouse_relay_burrows`)).toEqual([
    { burrowId: enrollment.burrowId, userId: owner, tokenHash: digest(enrollment.burrowToken) },
  ]);
  // The signed-in desktop's voice token, minted with the Burrow, stored as its hash.
  expect(isManagedVoiceToken(voiceToken)).toBe(true);
  expect(await f.sql(`SELECT "userId", hash, "burrowId", "revokedAt" FROM dormouse_voice_tokens`)).toEqual([
    { userId: owner, hash: digest(voiceToken), burrowId: enrollment.burrowId, revokedAt: null },
  ]);
  // Spent: the approval stays, marked with the Burrow it minted, so a poll
  // whose answer was lost learns it was redeemed; nothing redeems twice.
  expect(
    await f.sql(`SELECT "userId", "redeemedBurrowId", "redeemedAt" IS NOT NULL AS redeemed FROM dormouse_relay_enrollment_approvals`),
  ).toEqual([{ userId: owner, redeemedBurrowId: enrollment.burrowId, redeemed: true }]);
  // Naming the Burrow it minted, for the Burrow to tell the account to remove.
  expect((await f.poll(begun.deviceCode)).json).toEqual({ status: "redeemed", burrowId: enrollment.burrowId });
  expect((await f.mint(enrollment.burrowToken)).status).toBe(200);
  // Removing the Burrow never makes its approval redeemable again, and
  // revokes its voice token with it.
  await f.sql(`DELETE FROM dormouse_relay_burrows`);
  expect(await f.sql(`SELECT count(*)::int AS n FROM dormouse_voice_tokens`)).toEqual([{ n: 0 }]);
  expect((await f.poll(begun.deviceCode)).json).toEqual({ status: "redeemed", burrowId: enrollment.burrowId });
  expect(await f.sql(`SELECT count(*)::int AS n FROM dormouse_relay_burrows`)).toEqual([{ n: 0 }]);
  // Expired, the marker is swept with the rest.
  await f.sql(`UPDATE dormouse_relay_enrollment_approvals SET "expiresAt" = now() - interval '1 second'`);
  expect((await f.poll(begun.deviceCode)).json).toEqual({ status: "pending" });
  await f.cron();
  expect(await f.sql(`SELECT count(*)::int AS n FROM dormouse_relay_enrollment_approvals`)).toEqual([{ n: 0 }]);
});

test("an approval redeems only the device code its user code is derived from", async ({ onTestFinished }) => {
  const f = await fixture();
  onTestFinished(f.close);
  const owner = await f.account(ADMIN_EMAIL);
  const [a, b] = [await f.begin(), await f.begin()];
  await f.approve(a.userCode, owner);
  // Code A's approval never redeems device code B.
  expect((await f.poll(b.deviceCode)).json).toEqual({ status: "pending" });
  // A forged code of the minted shape: A with a later expiry, A with a flipped
  // random byte, and a code whose user code is A's under another secret.
  const flipped = fromBase64Url(a.deviceCode);
  flipped[31] ^= 1;
  const forged = [withExpiry(a.deviceCode, Math.floor(a.expiresAt / 1000) + 60), toBase64Url(flipped)];
  for (const deviceCode of forged) {
    expect(isRelayBearer(deviceCode)).toBe(true);
    expect((await f.poll(deviceCode)).json, deviceCode).toEqual({ status: "pending" });
  }
  const other = await f.begin();
  const underWrongSecret = await enrollUserCode(`${TEST_ENROLL_SECRET}-wrong`, fromBase64Url(other.deviceCode));
  await f.approve(underWrongSecret, owner);
  expect((await f.poll(other.deviceCode)).json).toEqual({ status: "pending" });
  expect(await f.sql(`SELECT count(*)::int AS n FROM dormouse_relay_burrows`)).toEqual([{ n: 0 }]);
  // A itself still redeems.
  expect((await f.poll(a.deviceCode)).json).toMatchObject({ status: "enrolled" });
});

test("two polls racing one approval mint one Burrow", async ({ onTestFinished }) => {
  const f = await fixture();
  onTestFinished(f.close);
  const owner = await f.account(ADMIN_EMAIL);
  for (let round = 0; round < 5; round++) {
    const begun = await f.begin();
    await f.approve(begun.userCode, owner);
    const answers = await Promise.all(Array.from({ length: 4 }, () => f.poll(begun.deviceCode)));
    const won = answers.filter(({ json }) => json!.status === "enrolled");
    expect(won).toHaveLength(1);
    // Every other poll learns the approval was spent, and on what, whether it
    // read it spent or lost the race at the lock.
    const { burrowId } = (won[0]!.json as { enrollment: { burrowId: string } }).enrollment;
    expect(answers.filter(({ json }) => json!.status === "redeemed").map(({ json }) => json)).toEqual(
      Array(3).fill({ status: "redeemed", burrowId }),
    );
  }
  expect(await f.sql(`SELECT count(*)::int AS n FROM dormouse_relay_burrows`)).toEqual([{ n: 5 }]);
});

test("an enrollment expires, is refused past its approver's entitlement, and waits on a full account", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const owner = await f.account(ADMIN_EMAIL);

  // An expired approval enrolls nothing, and the Cron Trigger sweeps it.
  const late = await f.begin();
  await f.approve(late.userCode, owner);
  await f.sql(`UPDATE dormouse_relay_enrollment_approvals SET "expiresAt" = now() - interval '1 second'`);
  expect((await f.poll(late.deviceCode)).json).toEqual({ status: "pending" });
  await f.cron();
  expect(await f.sql(`SELECT count(*)::int AS n FROM dormouse_relay_enrollment_approvals`)).toEqual([{ n: 0 }]);

  // The entitlement is rechecked at redemption; the approval survives the refusal.
  const begun = await f.begin();
  await f.approve(begun.userCode, owner);
  await f.sql(`UPDATE "user" SET "emailVerified" = false WHERE id = $1`, [owner]);
  expect(await f.poll(begun.deviceCode)).toMatchObject({ status: 403, json: { error: NOT_ENTITLED_ERROR } });
  await f.sql(`UPDATE "user" SET "emailVerified" = true WHERE id = $1`, [owner]);

  // A full account names the page that removes one, and keeps the approval.
  const enrolled = [];
  for (let i = 0; i < MAX_ENROLLED_BURROWS; i++) enrolled.push(await f.burrow(owner));
  expect(await f.poll(begun.deviceCode)).toMatchObject({
    status: 409,
    json: {
      error: `this account already has ${MAX_ENROLLED_BURROWS} computers enrolled; remove one at ${ORIGINS.account}/account first`,
    },
  });
  // A removed Burrow makes room.
  await f.sql(`DELETE FROM dormouse_relay_burrows WHERE "burrowId" = $1`, [enrolled[0].burrowId]);
  expect((await f.poll(begun.deviceCode)).json).toMatchObject({ status: "enrolled" });
  // Full again, a poll whose answer was lost still learns it was redeemed,
  // and so does one past its approver's entitlement.
  expect(await f.poll(begun.deviceCode)).toMatchObject({ status: 200, json: { status: "redeemed", burrowId: expect.any(String) } });
  await f.sql(`UPDATE "user" SET "emailVerified" = false WHERE id = $1`, [owner]);
  expect(await f.poll(begun.deviceCode)).toMatchObject({ status: 200, json: { status: "redeemed", burrowId: expect.any(String) } });
});

test("begin refuses another origin", async ({ onTestFinished }) => {
  const f = await fixture();
  onTestFinished(f.close);
  for (const claimed of [undefined, "https://relay.example.test", `${origin}.evil.test`])
    expect(await f.call("POST", API_ROUTES.burrowEnrollBegin, { body: { origin: claimed } })).toMatchObject({
      status: 409,
      json: { error: "origin mismatch", origin },
    });
  // A trailing slash is the same origin.
  expect((await f.call("POST", API_ROUTES.burrowEnrollBegin, { body: { origin: `${origin}/` } })).status).toBe(200);
});

// --- Web Push: the self-host Relay's push routes over account-scoped rows ---

const FCM = "https://fcm.googleapis.com/fcm/send/";

/** A live session for `userId`, as sign-in writes one. */
async function sessionFor(f: Awaited<ReturnType<typeof fixture>>, userId: string) {
  const token = randomSecret();
  await f.sql(
    `INSERT INTO dormouse_relay_sessions ("tokenHash", "userId", "expiresAt")
    VALUES ($1, $2, now() + interval '1 hour')`,
    [digest(token), userId],
  );
  return token;
}

/** A subscription a browser holds: a P-256 keypair from Node and an auth secret. */
function browserSubscription(endpoint = FCM + randomSecret()) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    ecdh,
    subscription: {
      endpoint,
      keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
    },
  };
}

/** RFC 8291 decryption on Node's `crypto`, independent of the sender under test. */
function decryptPush(body: Buffer, { ecdh, subscription }: ReturnType<typeof browserSubscription>) {
  const salt = body.subarray(0, 16);
  const senderPublic = body.subarray(21, 21 + body[20]);
  const record = body.subarray(21 + body[20]);
  const uaPublic = Buffer.from(subscription.keys.p256dh, "base64url");
  const ikm = Buffer.from(
    hkdfSync(
      "sha256",
      ecdh.computeSecret(senderPublic),
      Buffer.from(subscription.keys.auth, "base64url"),
      Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, senderPublic]),
      32,
    ),
  );
  const derive = (info: string, length: number) =>
    Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info), length));
  const decipher = createDecipheriv(
    "aes-128-gcm",
    derive("Content-Encoding: aes128gcm\0", 16),
    derive("Content-Encoding: nonce\0", 12),
  );
  decipher.setAuthTag(record.subarray(-16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, -16)), decipher.final()]);
  expect(padded.at(-1)).toBe(2);
  return JSON.parse(padded.subarray(0, -1).toString("utf8"));
}

/** A well-formed sealed envelope with no key behind it: the Relay checks shape alone. */
const fakeSealed = () => ({ v: 1, salt: randomSecret(), ct: randomSecret() + randomSecret() });
const to = (...deliveryIds: string[]) => ({
  recipients: deliveryIds.map((deliveryId) => ({ deliveryId, sealed: fakeSealed() })),
});

/** An entitled account with one Burrow and a session, and the push calls Pocket and the Burrow make. */
async function pushFixture(options?: Parameters<typeof fixture>[0]) {
  const f = await fixture(options);
  const owner = await f.account(ADMIN_EMAIL);
  const laptop = await f.burrow(owner);
  const session = await sessionFor(f, owner);
  const subscribe = (
    deliveryId: string,
    subscription = browserSubscription().subscription,
    { burrowId = laptop.burrowId, bearer = session } = {},
  ) =>
    f.call("POST", API_ROUTES.pushSubscribe, {
      bearer,
      body: { burrowId, deliveryId, subscription },
    });
  const query = (deliveryIds: string[], bearer = session) =>
    f.call("POST", API_ROUTES.pushSubscriptionsQuery, { bearer, body: { deliveryIds } });
  const devices = (bearer = laptop.token) => f.call("GET", API_ROUTES.pushDevices, { bearer });
  const send = (body: unknown, bearer = laptop.token) =>
    f.call("POST", API_ROUTES.pushSend, { bearer, body });
  const rows = () =>
    f.sql<{ burrowId: string; deliveryId: string; endpoint: string }>(
      `SELECT "burrowId", "deliveryId", endpoint FROM dormouse_relay_push_subscriptions
      ORDER BY "subscribedAt", "burrowId", "deliveryId"`,
    );
  return { ...f, owner, laptop, sessionToken: session, subscribe, query, devices, send, rows };
}

test("push end to end: a Burrow's sealed envelope reaches the push service encrypted to the phone, and nothing else", async ({
  onTestFinished,
}) => {
  const f = await pushFixture();
  onTestFinished(f.close);
  const keys = testVapidKeys();
  expect((await f.call("GET", API_ROUTES.pushConfig)).json).toEqual({
    applicationServerKey: keys.RELAY_VAPID_PUBLIC_KEY,
  });
  const phone = browserSubscription();
  const deliveryId = randomSecret();
  const subscribed = await f.subscribe(deliveryId, phone.subscription);
  expect(subscribed.status).toBe(200);
  expect(subscribed.json).toEqual({ subscribedAt: expect.any(Number), burrowIds: [f.laptop.burrowId] });
  expect((await f.devices()).json).toEqual({
    devices: [{ deliveryId, subscribedAt: subscribed.json!.subscribedAt }],
  });
  expect((await f.query([deliveryId, randomSecret()])).json).toEqual({
    registered: [{ burrowId: f.laptop.burrowId, deliveryId }],
  });

  const burrowStatic = await generateNoiseKeyPair();
  const clientStatic = await generateNoiseKeyPair();
  const notification = utf8Encode(JSON.stringify({ title: "build finished", body: "zsh", tag: "pty-1" }));
  const sealed = await sealPush({
    burrowStaticPrivateKey: burrowStatic.privateKey,
    clientStaticPublicKey: clientStatic.publicKey,
    plaintext: notification,
  });
  // Extra fields ride along on the envelope; none reaches the phone, the
  // `burrowId` least of all.
  const sent = await f.send({
    recipients: [{ deliveryId, sealed: { ...sealed, burrowId: randomRoutingId(), title: "leak" } }],
  });
  expect(sent.json).toEqual({ delivered: 1, expired: 0, unknown: 0, failed: 0 });
  expect(f.pushed).toHaveLength(1);
  await expect
    .poll(() => f.sql(`SELECT count::int FROM dormouse_metrics_daily WHERE event = 'push.sent'`))
    .toEqual([{ count: 1 }]);
  const [request] = f.pushed;
  expect(request.url).toBe(phone.subscription.endpoint);
  expect(request.headers["content-encoding"]).toBe("aes128gcm");
  expect(request.headers.ttl).toBe("300");
  expect(request.headers.urgency).toBe("high");

  // The VAPID JWT: signed by the relay's key, for the push service's origin, from the relay's origin.
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(request.headers.authorization)!;
  expect(k).toBe(keys.RELAY_VAPID_PUBLIC_KEY);
  const [header, claims, signature] = jwt.split(".");
  const verifyKey = await crypto.subtle.importKey(
    "raw",
    Buffer.from(keys.RELAY_VAPID_PUBLIC_KEY, "base64url"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  expect(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      Buffer.from(signature, "base64url"),
      Buffer.from(`${header}.${claims}`),
    ),
  ).toBe(true);
  const { aud, sub, exp } = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
  expect([aud, sub]).toEqual(["https://fcm.googleapis.com", origin]);
  expect(exp * 1000 - Date.now()).toBeGreaterThan(0);
  expect(exp * 1000 - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);

  // Exactly the four fields, the `burrowId` the token's, and the phone opens it.
  const payload = decryptPush(request.body, phone);
  expect(Object.keys(payload).sort()).toEqual(["burrowId", "ct", "salt", "v"]);
  expect(payload.burrowId).toBe(f.laptop.burrowId);
  expect(
    await openPush({
      clientStaticPrivateKey: clientStatic.privateKey,
      burrowStaticPublicKey: burrowStatic.publicKey,
      sealed: payload,
    }),
  ).toEqual(notification);

  // Deleting is always 204, and the row is gone.
  const remove = (id: string) =>
    f.call("DELETE", pushSubscriptionDeletePath(id), { bearer: f.sessionToken });
  expect((await remove(deliveryId)).status).toBe(204);
  expect((await remove(deliveryId)).status).toBe(204);
  expect((await remove("not-a-delivery-id")).status).toBe(204);
  expect(await f.rows()).toEqual([]);
});

test("push rows are the account's: another account's session or Burrow subscribes, reads, deletes, and reaches none of them", async ({
  onTestFinished,
}) => {
  const f = await pushFixture();
  onTestFinished(f.close);
  const shared = browserSubscription().subscription;
  const deliveryA = randomSecret();
  expect((await f.subscribe(deliveryA, shared)).status).toBe(200);

  const b = await f.account();
  const laptopB = await f.burrow(b);
  const sessionB = await sessionFor(f, b);
  // While A is entitled, B's session is the expired session's 401.
  expect(await f.query([deliveryA], sessionB)).toMatchObject({
    status: 401,
    json: { error: UNAUTHORIZED_ERROR },
  });
  await f.entitle(b);
  // A's Burrow is unknown to B.
  expect(await f.subscribe(randomSecret(), shared, { burrowId: f.laptop.burrowId, bearer: sessionB })).toMatchObject({
    status: 404,
    json: { error: "unknown burrow" },
  });
  // Possession of A's id buys B nothing: no readback, no delete.
  expect((await f.query([deliveryA], sessionB)).json).toEqual({ registered: [] });
  expect((await f.call("DELETE", pushSubscriptionDeletePath(deliveryA), { bearer: sessionB })).status).toBe(204);
  // B's own row at A's address answers only B's Burrow.
  const ownB = randomSecret();
  expect((await f.subscribe(ownB, shared, { burrowId: laptopB.burrowId, bearer: sessionB })).json).toMatchObject({
    burrowIds: [laptopB.burrowId],
  });
  // B registering A's id at a new address moves nothing of A's: A's address is
  // not one B's delivery is moving off, so B's row there stays too.
  const moved = browserSubscription().subscription;
  expect(
    (await f.subscribe(deliveryA, moved, { burrowId: laptopB.burrowId, bearer: sessionB })).json,
  ).toMatchObject({ burrowIds: [laptopB.burrowId] });
  expect((await f.query([ownB], sessionB)).json).toEqual({
    registered: [{ burrowId: laptopB.burrowId, deliveryId: ownB }],
  });
  // B moving its own row off A's address drops B's rows there, never A's.
  expect(
    (await f.subscribe(ownB, browserSubscription().subscription, { burrowId: laptopB.burrowId, bearer: sessionB }))
      .json,
  ).toMatchObject({ burrowIds: [laptopB.burrowId] });
  // B's Burrow neither lists nor reaches A's subscriber.
  const onlyA = randomSecret();
  await f.entitle(f.owner);
  expect((await f.subscribe(onlyA)).status).toBe(200);
  await f.entitle(b);
  expect((await f.devices(laptopB.token)).json!.devices).toHaveLength(2);
  expect((await f.send(to(onlyA), laptopB.token)).json).toEqual({
    delivered: 0,
    expired: 0,
    unknown: 1,
    failed: 0,
  });
  expect(f.pushed).toEqual([]);
  // A's rows are all still there.
  await f.entitle(f.owner);
  expect((await f.query([deliveryA, onlyA])).json).toEqual({
    registered: [
      { burrowId: f.laptop.burrowId, deliveryId: deliveryA },
      { burrowId: f.laptop.burrowId, deliveryId: onlyA },
    ],
  });
  // A de-entitled owner's Burrow sends nothing.
  await f.entitle(b);
  expect(await f.send(to(onlyA))).toMatchObject({ status: 403, json: { error: NOT_ENTITLED_ERROR } });
});

test("subscribe upserts as the self-host Relay does: a moved endpoint takes its stale rows with it", async ({
  onTestFinished,
}) => {
  const f = await pushFixture();
  onTestFinished(f.close);
  const other = await f.burrow(f.owner);
  const sub = (endpoint: string) => browserSubscription(FCM + endpoint).subscription;
  const reset = () => f.sql(`DELETE FROM dormouse_relay_push_subscriptions`);
  const endpoints = async () => (await f.rows()).map((row) => row.endpoint);

  // Re-subscribing replaces the row rather than accumulating one per rotation.
  const deliveryId = randomSecret();
  await f.subscribe(deliveryId, sub("1"));
  await f.subscribe(deliveryId, sub("2"));
  expect(await endpoints()).toEqual([FCM + "2"]);
  await reset();

  // Rotating the endpoint drops every row still carrying the replaced one.
  const [forLaptop, forOther] = [randomSecret(), randomSecret()];
  await f.subscribe(forLaptop, sub("original"));
  await f.subscribe(forOther, sub("original"), { burrowId: other.burrowId });
  expect((await f.subscribe(forLaptop, sub("replacement"))).json!.burrowIds).toEqual([f.laptop.burrowId]);
  expect(await f.rows()).toEqual([
    { burrowId: f.laptop.burrowId, deliveryId: forLaptop, endpoint: FCM + "replacement" },
  ]);
  await reset();

  // A moved delivery drops its own stale rows under every Burrow that holds it.
  await f.subscribe(deliveryId, sub("old"), { burrowId: other.burrowId });
  expect((await f.subscribe(deliveryId, sub("new"))).json!.burrowIds).toEqual([f.laptop.burrowId]);
  expect(await endpoints()).toEqual([FCM + "new"]);
  expect((await f.query([deliveryId])).json!.registered).toEqual([{ burrowId: f.laptop.burrowId, deliveryId }]);
  await reset();

  // Subscribe answers every Burrow whose rows carry the presented endpoint, and only that endpoint's.
  expect((await f.subscribe(forLaptop, sub("phone"))).json!.burrowIds).toEqual([f.laptop.burrowId]);
  expect(
    [...(await f.subscribe(forOther, sub("phone"), { burrowId: other.burrowId })).json!.burrowIds].sort(),
  ).toEqual([f.laptop.burrowId, other.burrowId].sort());
  expect((await f.subscribe(randomSecret(), sub("other-phone"))).json!.burrowIds).toEqual([f.laptop.burrowId]);
  await reset();

  // A retried subscribe whose first response was lost still reports the truth.
  await f.subscribe(forLaptop, sub("first"));
  await f.subscribe(forOther, sub("first"), { burrowId: other.burrowId });
  const rotated = sub("rotated");
  expect((await f.subscribe(forLaptop, rotated)).json!.burrowIds).toEqual([f.laptop.burrowId]);
  expect((await f.subscribe(forLaptop, rotated)).json!.burrowIds).toEqual([f.laptop.burrowId]);
  await reset();

  // A brand-new delivery id cannot know its scope's previous address: those rows survive.
  await f.subscribe(forLaptop, sub("before"));
  await f.subscribe(randomSecret(), sub("after"));
  expect((await endpoints()).sort()).toEqual([FCM + "after", FCM + "before"]);
});

test("subscriptions are capped per Burrow and per account, evicting the oldest and never the new row or another account's", async ({
  onTestFinished,
}) => {
  const f = await pushFixture();
  onTestFinished(f.close);
  const vapid = testVapidKeys().RELAY_VAPID_PUBLIC_KEY;
  /** `count` rows for `burrowId`, the oldest first, all older than any subscribe. */
  const seed = (burrowId: string, count: number, prefix: string) =>
    f.sql(
      `INSERT INTO dormouse_relay_push_subscriptions
        ("burrowId", "deliveryId", endpoint, p256dh, auth, "vapidPublicKey", "subscribedAt")
      SELECT $1, lpad($3 || i::text, 43, 'A'), $4 || $3 || i::text, 'BPoint', 'Auth', $5,
        now() - interval '1 day' + i * interval '1 second'
      FROM generate_series(1, $2::int) AS i`,
      [burrowId, count, prefix, FCM, vapid],
    );
  const count = async (where: string, values: unknown[]) =>
    (
      await f.sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM dormouse_relay_push_subscriptions s
        JOIN dormouse_relay_burrows b ON b."burrowId" = s."burrowId" WHERE ${where}`,
        values,
      )
    )[0].n;
  // Another account already past both caps: nothing here touches it.
  const stranger = await f.account();
  const strangers = await f.burrow(stranger);
  await seed(strangers.burrowId, MAX_PUSH_SUBSCRIPTIONS_PER_BURROW + 8, "z");

  await seed(f.laptop.burrowId, MAX_PUSH_SUBSCRIPTIONS_PER_BURROW, "a");
  const newest = randomSecret();
  expect((await f.subscribe(newest)).status).toBe(200);
  expect(await count(`s."burrowId" = $1`, [f.laptop.burrowId])).toBe(MAX_PUSH_SUBSCRIPTIONS_PER_BURROW);
  expect(await count(`s."deliveryId" = $1`, [newest])).toBe(1);
  expect(await count(`s."deliveryId" = $1`, ["a1".padStart(43, "A")])).toBe(0);
  expect(await count(`s."deliveryId" = $1`, ["a2".padStart(43, "A")])).toBe(1);

  // Fill the account to its cap across further Burrows, then subscribe on one more.
  const perAccount = MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT / MAX_PUSH_SUBSCRIPTIONS_PER_BURROW;
  for (let i = 1; i < perAccount; i++) await seed((await f.burrow(f.owner)).burrowId, MAX_PUSH_SUBSCRIPTIONS_PER_BURROW, `b${i}x`);
  const last = await f.burrow(f.owner);
  const latest = randomSecret();
  expect((await f.subscribe(latest, undefined, { burrowId: last.burrowId })).status).toBe(200);
  expect(await count(`b."userId" = $1`, [f.owner])).toBe(MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT);
  expect(await count(`s."deliveryId" = $1`, [latest])).toBe(1);
  // The account's oldest row went: the first of the `b1x` Burrow, older than every `a` row.
  expect(await count(`s."deliveryId" = $1`, ["b1x1".padStart(43, "A")])).toBe(0);
  expect(await count(`b."userId" = $1`, [stranger])).toBe(MAX_PUSH_SUBSCRIPTIONS_PER_BURROW + 8);
});

test("removing a Burrow drops its subscriptions; views are VAPID-current; push is off, not half-working, without a matching pair", async ({
  onTestFinished,
}) => {
  const f = await pushFixture();
  onTestFinished(f.close);
  const [kept, stale] = [randomSecret(), randomSecret()];
  await f.subscribe(kept);
  await f.subscribe(stale);
  // A row registered under another key is stale: no readback, no device, no delivery.
  await f.sql(`UPDATE dormouse_relay_push_subscriptions SET "vapidPublicKey" = $1 WHERE "deliveryId" = $2`, [
    testVapidKeys("rotated").RELAY_VAPID_PUBLIC_KEY,
    stale,
  ]);
  expect((await f.query([kept, stale])).json!.registered).toEqual([{ burrowId: f.laptop.burrowId, deliveryId: kept }]);
  expect((await f.devices()).json!.devices.map((d: { deliveryId: string }) => d.deliveryId)).toEqual([kept]);
  expect((await f.send(to(stale))).json).toEqual({ delivered: 0, expired: 0, unknown: 1, failed: 0 });
  expect(f.pushed).toEqual([]);
  expect(await f.rows()).toHaveLength(2);
  // Removing the Burrow, as the account's Computers section does, drops its rows.
  await f.sql(`DELETE FROM dormouse_relay_burrows WHERE "burrowId" = $1`, [f.laptop.burrowId]);
  expect(await f.rows()).toEqual([]);

  for (const bindings of [
    { RELAY_VAPID_PUBLIC_KEY: undefined },
    { RELAY_VAPID_PRIVATE_KEY: testVapidKeys("mismatched").RELAY_VAPID_PRIVATE_KEY },
  ]) {
    const off = await pushFixture({ bindings });
    try {
      expect((await off.call("GET", API_ROUTES.pushConfig)).json).toEqual({ applicationServerKey: null });
      expect(await off.subscribe(randomSecret())).toMatchObject({
        status: 503,
        json: { error: "push is not configured" },
      });
      expect(await off.send(to(randomSecret()))).toMatchObject({ status: 503 });
      expect((await off.query([randomSecret()])).json).toEqual({ registered: [] });
      expect((await off.devices()).json).toEqual({ devices: [] });
    } finally {
      await off.close();
    }
  }
});

test("send outcomes: 404 and 410 prune, a refusal, a redirect, or a throw is failed and kept, and siblings deliver", async ({
  onTestFinished,
}) => {
  const f = await pushFixture();
  onTestFinished(f.close);
  const outcomes = ["ok", "gone404", "gone410", "refused", "redirect", "throw"];
  const ids = Object.fromEntries(outcomes.map((name) => [name, randomSecret()]));
  for (const name of outcomes) await f.subscribe(ids[name], browserSubscription(FCM + name).subscription);
  f.answerPushes((url) => {
    const name = url.pathname.split("/").at(-1);
    if (name === "throw") throw new Error("connection reset");
    if (name === "redirect")
      return new WorkerResponse(null, { status: 307, headers: { location: `${FCM}ok` } });
    const status = { ok: 201, gone404: 404, gone410: 410, refused: 500 }[name!]!;
    return new WorkerResponse(status === 500 ? '{"reason":"Overloaded"}' : null, { status });
  });
  // A repeated recipient is not sent twice.
  const body = to(...outcomes.map((name) => ids[name]), ids.ok);
  expect((await f.send(body)).json).toEqual({ delivered: 1, expired: 2, unknown: 1, failed: 3 });
  // One request per subscription: the redirect was not followed.
  expect(f.pushed.map((request) => request.url).sort()).toEqual(outcomes.map((name) => FCM + name).sort());
  expect((await f.rows()).map((row) => row.endpoint).sort()).toEqual(
    ["ok", "refused", "redirect", "throw"].map((name) => FCM + name).sort(),
  );
});

/** Polls `ready` every 25 ms until it holds, for at most `ms`; answers whether it did. */
async function eventually(ready: () => Promise<boolean>, ms = 5_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await ready()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Backends on the fixture's database that have run a query, other than the
 * one counting them (Miniflare's Hyperdrive keeps one open that never has),
 * optionally only those waiting on a lock.
 */
async function backends(f: Awaited<ReturnType<typeof fixture>>, waitingOnLock = false) {
  const [{ n }] = await f.sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid() AND query <> ''
      AND (NOT $1 OR wait_event_type = 'Lock')`,
    [waitingOnLock],
  );
  return n;
}

test("a send holds no Postgres connection while a push service answers, and reopens one only to prune", async ({
  onTestFinished,
}) => {
  const f = await pushFixture();
  onTestFinished(f.close);
  const gone = randomSecret();
  await f.subscribe(gone, browserSubscription(FCM + "gone").subscription);
  let released = false;
  f.answerPushes(async () => {
    // A closed connection's backend can outlive the close by a moment.
    released = await eventually(async () => (await backends(f)) === 0, 2_000);
    return new WorkerResponse(null, { status: 410 });
  });
  expect((await f.send(to(gone))).json).toEqual({ delivered: 0, expired: 1, unknown: 0, failed: 0 });
  expect(released).toBe(true);
  expect(await f.rows()).toEqual([]);
});

test("a send signs one VAPID JWT per push-service origin", async ({ onTestFinished }) => {
  const f = await pushFixture();
  onTestFinished(f.close);
  const mozilla = "https://updates.push.services.mozilla.com/wpush/v2/";
  const ids = [randomSecret(), randomSecret(), randomSecret()];
  for (const [i, endpoint] of [FCM + "a", FCM + "b", mozilla + "c"].entries())
    await f.subscribe(ids[i], browserSubscription(endpoint).subscription);
  expect((await f.send(to(...ids))).json).toMatchObject({ delivered: 3 });
  const byOrigin = new Map<string, Set<string>>();
  for (const { url, headers } of f.pushed) {
    const origin = new URL(url).origin;
    byOrigin.set(origin, (byOrigin.get(origin) ?? new Set()).add(headers.authorization));
  }
  // ECDSA signatures are randomized, so a second signing would differ.
  expect([...byOrigin].map(([origin, tokens]) => [origin, tokens.size])).toEqual([
    ["https://fcm.googleapis.com", 1],
    ["https://updates.push.services.mozilla.com", 1],
  ].sort());
});

test("a subscribe racing its Burrow's removal answers unknown burrow, never a database error", async ({
  onTestFinished,
}) => {
  const f = await pushFixture();
  onTestFinished(f.close);
  await withClient(f.ownerUrl, async (remover) => {
    // The removal has deleted the row and not yet committed.
    await remover.query("BEGIN");
    await remover.query(`DELETE FROM dormouse_relay_burrows WHERE "burrowId" = $1`, [f.laptop.burrowId]);
    const subscribed = f.subscribe(randomSecret());
    expect(await eventually(async () => (await backends(f, true)) === 1)).toBe(true);
    await remover.query("COMMIT");
    expect(await subscribed).toMatchObject({ status: 404, json: { error: "unknown burrow" } });
  });
  expect(await f.rows()).toEqual([]);
});

test("a capped write that waited on its lock is stamped after the write it followed", async ({ onTestFinished }) => {
  const f = await pushFixture();
  onTestFinished(f.close);
  /**
   * Runs `write` on a connection that pauses just after `BEGIN` while `other`
   * runs to completion: a transaction that began first and takes the lock
   * second. Answers both results.
   */
  async function interleaved<T>(write: (db: Client) => Promise<T>) {
    return withClient(f.url, async (db) => {
      let began!: () => void;
      let go!: () => void;
      const begun = new Promise<void>((resolve) => (began = resolve));
      const gate = new Promise<void>((resolve) => (go = resolve));
      const paused: Client = {
        async query<Row>(text: string, values?: unknown[]) {
          const result = await (db as Client).query<Row>(text, values);
          if (text === "BEGIN") {
            began();
            await gate;
          }
          return result;
        },
      };
      const waited = write(paused);
      await begun;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const first = await withClient(f.url, write);
      go();
      return { first, waited: await waited };
    });
  }
  const vapidPublicKey = testVapidKeys().RELAY_VAPID_PUBLIC_KEY;
  const subscriptions = await interleaved((db) => {
    const deliveryId = randomSecret();
    const { keys } = browserSubscription().subscription;
    return upsertSubscription(db, f.owner, {
      burrowId: f.laptop.burrowId,
      deliveryId,
      endpoint: FCM + deliveryId,
      keys,
      vapidPublicKey,
    });
  });
  expect(subscriptions.waited!.subscribedAt).toBeGreaterThan(subscriptions.first!.subscribedAt);
  const sessions = await interleaved((db) =>
    admit(db, SESSIONS, f.owner, { tokenHash: digest(randomSecret()), userId: f.owner }, 60_000),
  );
  expect(sessions.waited!).toBeGreaterThan(sessions.first!);
});

test("a send waits at most its deadline for a hung push service, keeping the row", async ({ onTestFinished }) => {
  const f = await pushFixture();
  onTestFinished(f.close);
  const [hung, ok] = [randomSecret(), randomSecret()];
  await f.subscribe(hung, browserSubscription(FCM + "hung").subscription);
  await f.subscribe(ok, browserSubscription(FCM + "ok").subscription);
  f.answerPushes((url) =>
    url.pathname.endsWith("/hung") ? new Promise(() => {}) : new WorkerResponse(null, { status: 201 }),
  );
  const started = Date.now();
  expect((await f.send(to(hung, ok))).json).toEqual({ delivered: 1, expired: 0, unknown: 0, failed: 1 });
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(15_000 - 500);
  expect(elapsed).toBeLessThan(30_000);
  expect(await f.rows()).toHaveLength(2);
});

test("only a known push service's endpoint registers, and a row naming any other is never fetched", async ({
  onTestFinished,
}) => {
  const f = await pushFixture();
  onTestFinished(f.close);
  for (const endpoint of [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://user:pass@fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com.evil.test/fcm/send/abc",
    "https://push.example.com/sub/abc",
    "https://100.64.0.1/sub/abc",
    "https://localhost/sub/abc",
  ])
    expect(await f.subscribe(randomSecret(), browserSubscription(endpoint).subscription), endpoint).toMatchObject({
      status: 400,
      json: { error: "endpoint must be a known push service" },
    });
  for (const endpoint of [
    "https://web.push.apple.com/QGuQyavXutnMH-5",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB",
  ])
    expect((await f.subscribe(randomSecret(), browserSubscription(endpoint).subscription)).status, endpoint).toBe(200);
  expect(await f.rows()).toHaveLength(3);
  // A row the allowlist no longer admits, however it got there, is never fetched.
  const legacy = randomSecret();
  await f.sql(
    `INSERT INTO dormouse_relay_push_subscriptions ("burrowId", "deliveryId", endpoint, p256dh, auth, "vapidPublicKey")
    VALUES ($1, $2, 'https://push.example.com/sub/abc', $3, 'BTBZMqHH6r4Tts7J_aSIgg', $4)`,
    [f.laptop.burrowId, legacy, browserSubscription().subscription.keys.p256dh, testVapidKeys().RELAY_VAPID_PUBLIC_KEY],
  );
  expect((await f.send(to(legacy))).json).toEqual({ delivered: 0, expired: 0, unknown: 0, failed: 1 });
  expect(f.pushed).toEqual([]);
});

test("send requires and bounds its recipients, and the push routes refuse an id no Burrow minted", async ({
  onTestFinished,
}) => {
  const f = await pushFixture();
  onTestFinished(f.close);
  const refused = {
    status: 400,
    json: { error: `recipients must be 1..${MAX_PUSH_QUERY_DELIVERY_IDS} { deliveryId, sealed } pairs` },
  };
  expect(await f.send({})).toMatchObject(refused);
  expect(await f.send({ recipients: [] })).toMatchObject(refused);
  expect(
    await f.send(to(...Array.from({ length: MAX_PUSH_QUERY_DELIVERY_IDS + 1 }, () => randomSecret()))),
  ).toMatchObject(refused);
  expect(await f.send({ recipients: [{ deliveryId: randomSecret(), sealed: { v: 2, salt: "x", ct: "y" } }] })).toMatchObject(
    refused,
  );
  expect(await f.send(to("short"))).toMatchObject(refused);
  expect(await f.query(["short"])).toMatchObject({ status: 400 });
  expect(await f.query([])).toMatchObject({ status: 400 });
  expect(await f.subscribe("short")).toMatchObject({ status: 400, json: { error: "malformed request" } });
  // A session is not a Burrow token, nor the reverse.
  expect((await f.devices(f.sessionToken)).status).toBe(401);
  expect((await f.query([randomSecret()], f.laptop.token)).status).toBe(401);
});

test("subscribe refuses a p256dh of the right shape off P-256, writing nothing", async ({ onTestFinished }) => {
  const f = await pushFixture();
  onTestFinished(f.close);
  const { subscription } = browserSubscription();
  // 65 bytes led by 0x04 with the low bit of y flipped: every send to it would fail.
  const offCurve = Buffer.from(subscription.keys.p256dh, "base64url");
  offCurve[64] ^= 1;
  expect(
    await f.subscribe(randomSecret(), {
      ...subscription,
      keys: { ...subscription.keys, p256dh: offCurve.toString("base64url") },
    }),
  ).toMatchObject({ status: 400, json: { error: "malformed request" } });
  expect(await f.rows()).toEqual([]);
});
