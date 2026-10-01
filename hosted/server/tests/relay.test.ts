import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { digest } from "@pgstencil/auth/security";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { createTestContext } from "pgstencil/testing";
import { queryDatabase, withClient } from "pgstencil/postgres";
import {
  API_ROUTES,
  MAX_PENDING_REAUTH_NONCES_PER_SESSION,
  MAX_TOKENS_PER_BURROW,
  SETUP_TOKEN_INVALID_ERROR,
  UNAUTHORIZED_ERROR,
  verifyPresenceProof,
  type PresenceBinding,
} from "remote-lib-common";
import {
  SimAuthenticator,
  randomRoutingId,
  randomSecret,
  registrationClientData,
} from "../../../remote-lib-common/test/harness/actors.mjs";
import { ADMIN_EMAIL } from "../admin";
import { migrations } from "../migrations";
import {
  MAX_PASSKEYS_PER_ACCOUNT,
  MAX_SESSIONS_PER_ACCOUNT,
  MAX_SETUP_CHALLENGES_PER_BURROW,
  restoreSetupToken,
} from "../relay-api";
import { NOT_ENTITLED_ERROR } from "../relay-auth";
import { ENTRIES, ORIGINS, bundleWorker, miniflareOptions } from "./bundle";

// The Hosted Relay's routes (`docs/specs/hosted.md` -> "Relay") in real
// workerd against real Postgres, driven the way Pocket and a Burrow drive the
// self-host Relay: `SimAuthenticator` produces real WebAuthn, and each
// presence proof is checked with the Burrow's own verifier.

const origin = ORIGINS.relay;
const rpId = new URL(origin).hostname;
const script = bundleWorker(ENTRIES.relay);

type Authenticator = Awaited<ReturnType<typeof SimAuthenticator.create>>;

async function fixture() {
  const context = await createTestContext({ migrations });
  const relay = new Miniflare(
    miniflareOptions("relay", (await script).outputFiles[0].text, {
      bindings: { APP_ORIGIN: origin },
      hyperdrives: { HYPERDRIVE: context.database.url },
      serviceBindings: {
        ASSETS: () =>
          new WorkerResponse("<!doctype html>", {
            headers: { "content-type": "text/html" },
          }),
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

  /** An enrolled Burrow, as phase B's device-code flow will write one. */
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
    entitle,
    url: context.database.url,
    call,
    account,
    burrow,
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

test("a refused finish puts the token back on its own expiry; a revoked Burrow's tokens die with it", async ({
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
  await f.sql(`UPDATE dormouse_relay_burrows SET "revokedAt" = now()`);
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
  for (const [routes, error] of [
    [[API_ROUTES.signinBegin, API_ROUTES.signinFinish], "too many sign-in attempts"],
    [[API_ROUTES.setupBegin, API_ROUTES.setupFinish], "too many setup attempts"],
  ] as const) {
    // A ceremony's two routes spend one budget.
    for (let i = 0; i < 30; i++)
      expect((await f.call("POST", routes[i % 2], { ip: "203.0.113.7", body: {} })).status).not.toBe(429);
    for (const route of routes) {
      const limited = await f.call("POST", route, { ip: "203.0.113.7", body: {} });
      expect(limited, route).toMatchObject({ status: 429, json: { error } });
      expect(limited.headers.get("retry-after")).toBe("60");
    }
    // Another address is another caller.
    expect((await f.call("POST", routes[0], { ip: "203.0.113.8", body: {} })).status).not.toBe(429);
  }
});
