import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { digest } from "@pgstencil/auth/security";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { createTestContext } from "pgstencil/testing";
import { queryDatabase } from "pgstencil/postgres";
import {
  API_ROUTES,
  MAX_PENDING_REAUTH_NONCES_PER_SESSION,
  MAX_TOKENS_PER_BURROW,
  SETUP_TOKEN_INVALID_ERROR,
  UNAUTHORIZED_ERROR,
  toBase64Url,
  utf8Encode,
  verifyPresenceProof,
  type PresenceBinding,
} from "remote-lib-common";
import { SimAuthenticator } from "../../../remote-lib-common/test/harness/actors.mjs";
import { ADMIN_EMAIL } from "../admin";
import { migrations } from "../migrations";
import {
  MAX_PASSKEYS_PER_ACCOUNT,
  MAX_SESSIONS_PER_ACCOUNT,
  MAX_SETUP_CHALLENGES_PER_BURROW,
  NOT_ENTITLED_ERROR,
} from "../relay-api";
import { ENTRIES, ORIGINS, bundleWorker, miniflareOptions } from "./bundle";

// The Hosted Relay's routes (`docs/specs/hosted.md` -> "Relay") in real
// workerd against real Postgres, driven the way Pocket and a Burrow drive the
// self-host Relay: `SimAuthenticator` produces real WebAuthn, and each
// presence proof is checked with the Burrow's own verifier.

const origin = ORIGINS.relay;
const rpId = new URL(origin).hostname;
const script = bundleWorker(ENTRIES.relay);

const random = (bytes: number) =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

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

  /** An enrolled Burrow, as phase B's device-code flow will write one. */
  async function burrow(userId: string) {
    const burrowId = random(16);
    const token = random(32);
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
        clientDataJSON: toBase64Url(
          utf8Encode(
            JSON.stringify({
              type: "webauthn.create",
              challenge,
              origin: clientOrigin,
              crossOrigin: false,
            }),
          ),
        ),
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
    handshakeHash: random(32),
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

  return {
    sql,
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
        clientDataJSON: toBase64Url(
          utf8Encode(
            JSON.stringify({ type: "webauthn.create", challenge: begin.json!.challenge, origin }),
          ),
        ),
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
  // Both codes survive the refusal, and the challenge is still its own Burrow's.
  expect((await f.finish(phone, token, begin.json!.challenge)).status).toBe(200);
  expect((await f.call("POST", API_ROUTES.setupBegin, { body: { setupToken: other } })).status).toBe(200);
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
  const sessionA = await f.session(phoneA);
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
  expect(await finish(sessionB.sessionToken)).toMatchObject({
    status: 400,
    json: { error: "unrecognized or expired nonce" },
  });
  expect((await finish(sessionA.sessionToken)).status).toBe(200);

  // B cannot retire A's code, which still registers for A.
  const code = await f.setupToken(laptopA.token);
  expect(
    await f.call("POST", API_ROUTES.setupRetire, { bearer: sessionB.sessionToken, body: { setupToken: code } }),
  ).toMatchObject({ status: 401, json: { error: SETUP_TOKEN_INVALID_ERROR } });
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
      [random(16), owner],
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

  // Expired rows are refused, then pruned by the next write that grows their table.
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
  expect(await count("dormouse_relay_sessions", `"expiresAt" <= now()`)).toBe(0);
  expect(await count("dormouse_relay_presence_nonces", `"expiresAt" <= now()`)).toBe(0);
  expect(await count("dormouse_relay_setup_tokens", `"expiresAt" <= now()`)).toBe(0);
  expect(await count("dormouse_relay_challenges", `"expiresAt" <= now()`)).toBe(0);
});

test("sign-in challenges, minted unauthenticated, are rate limited per address", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  for (let i = 0; i < 30; i++)
    expect((await f.call("POST", API_ROUTES.signinBegin, { ip: "203.0.113.7" })).status).toBe(200);
  const limited = await f.call("POST", API_ROUTES.signinBegin, { ip: "203.0.113.7" });
  expect(limited).toMatchObject({ status: 429, json: { error: "too many sign-in attempts" } });
  expect(limited.headers.get("retry-after")).toBe("60");
  // Another address is another caller.
  expect((await f.call("POST", API_ROUTES.signinBegin, { ip: "203.0.113.8" })).status).toBe(200);
});
