import { test, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { digest } from "@pgstencil/auth/security";
import { Hono } from "hono";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { createTestContext } from "pgstencil/testing";
import { queryDatabase } from "pgstencil/postgres";
import { workerDatabases } from "./worker-roles";
import {
  API_ROUTES,
  MAX_RELAY_CLIENT_SOCKETS,
  NOT_ENTITLED_ERROR,
  RELAY_IDLE_TIMEOUT_MS,
  RELAY_PING,
  RELAY_PONG,
  UNAUTHORIZED_ERROR,
  UNKNOWN_BURROW_TOKEN_ERROR,
  WS_CLOSE_BURROW_NOT_ENTITLED,
  WS_CLOSE_BURROW_REPLACED,
  WS_CLOSE_BURROW_REVOKED,
  WS_CLOSE_IDLE,
  WS_CLOSE_TRY_AGAIN_LATER,
  WS_CLOSE_UNAUTHORIZED,
  WS_CLOSE_UNAUTHORIZED_REASON,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  REMOTE_METHODS,
  SESSION_END_V1,
  generateNoiseKeyPair,
  utf8Encode,
} from "remote-lib-common";
import {
  SimAuthenticator,
  randomRoutingId,
  randomSecret,
  registrationClientData,
} from "../../../remote-lib-common/test/harness/actors.mjs";
import { e2eClientFrame, newE2eId } from "../../../remote-lib-common/test/harness/envelope.mjs";
import { FakeBurrow } from "../../../remote-lib-common/test/harness/fake-burrow.mjs";
import { FakeClient } from "../../../remote-lib-common/test/harness/fake-client.mjs";
import { openFrameSocket, until } from "../../../remote-lib-common/test/harness/frame-socket.mjs";
import { e2eCases, socketCases } from "../../../remote-lib-common/test/harness/relay-parity.mjs";
import { ADMIN_EMAIL } from "../entitlement";
import { migrations } from "../migrations";
import { relayAccountRoutes } from "../relay-account";
import { RELAY_ROOM_SWEEP_MS, RELAY_ROW_READ_TIMEOUT_MS } from "../relay-room-contract";
import { ORIGINS, TEST_ENROLL_SECRET, bundleWorker, miniflareOptions, wrangler } from "./bundle";

// The Hosted Relay's sockets and its per-account `RelayRoom`
// (`docs/specs/hosted.md` -> "Relay sockets") in real workerd against real
// Postgres: the routing every Relay shares (`relay-parity.mjs`), driven as on
// the self-host Relay, then what only the Durable Object has — hibernation,
// one object per account, the revocation RPC, the session alarm, and the
// liveness the runtime answers.

const origin = ORIGINS.relay;
const rpId = new URL(origin).hostname;
/** A browser's Origin on a Client socket: Pocket is same-origin. */
const POCKET = { headers: { origin } };

type Authenticator = Awaited<ReturnType<typeof SimAuthenticator.create>>;
const newAuthenticator = (
  SimAuthenticator.create as unknown as (options: {
    rpId: string;
    userVerification?: boolean;
  }) => Promise<Authenticator>
).bind(SimAuthenticator, { rpId, userVerification: false });

/** A harness peer, typed by hand: its JavaScript options are inferred from the first caller. */
type Peer = { ready: Promise<void>; close(): void } & Record<string, any>;
const harness = (Class: unknown, options: Record<string, unknown>) =>
  new (Class as new (options: Record<string, unknown>) => Peer)(options);

/** What `probe()` on the test entry's `RelayRoom` answers. */
interface Probe {
  constructed: number;
  handled: number;
  upgrades: { headers: string[]; params: string[] }[];
  attachments: Record<string, unknown>[];
  storage: Record<string, unknown>;
  alarm: number | null;
}
/** RPC on the account's object, through the test entry's `/__test/room/` route. */
async function rpc<T>(account: string, method: string, ...args: unknown[]): Promise<T> {
  const response = await relay.dispatchFetch(
    `${origin}/__test/room/${method}?account=${encodeURIComponent(account)}`,
    { method: "POST", body: JSON.stringify(args) },
  );
  expect(response.status, method).toBe(200);
  return (await response.json()) as T;
}
/** `account`'s object, as the Workers reach it. */
const roomOf = (account: string) => ({
  closeBurrow: (claimed: string, burrowId: string) => rpc<boolean>(account, "closeBurrow", claimed, burrowId),
  onlineBurrows: (claimed: string) => rpc<string[]>(account, "onlineBurrows", claimed),
  probe: () => rpc<Probe>(account, "probe"),
  skew: (ms: number) => rpc<null>(account, "skew", ms),
  /** Run the alarm now. */
  fire: () => rpc<null>(account, "fire"),
  /** Stall every row read the object makes, or stop. */
  stallRows: (on: boolean) => rpc<null>(account, "stallRows", on),
  /** The status of an upgrade naming `claimed` and `burrowId`. */
  forge: (claimed: string, burrowId: string) => rpc<number>(account, "forge", claimed, burrowId),
});

let context: Awaited<ReturnType<typeof createTestContext>>;
let relay: Miniflare;
/** Miniflare's own address; `upstream` makes every request to it one for `origin`. */
let base: URL;
let wsBase: string;

beforeAll(async () => {
  context = await createTestContext({ migrations });
  const databases = await workerDatabases(context.database.url);
  relay = new Miniflare({
    ...miniflareOptions(
      "relay",
      (await bundleWorker("server/tests/relay-room-entry.ts")).outputFiles[0].text,
      {
        bindings: {
          APP_ORIGIN: origin,
          ACCOUNT_ORIGIN: ORIGINS.account,
          RELAY_ENROLL_SECRET: TEST_ENROLL_SECRET,
        },
        hyperdrives: { HYPERDRIVE: databases.relay },
        serviceBindings: {
          ASSETS: () =>
            new WorkerResponse("<!doctype html>", { headers: { "content-type": "text/html" } }),
        },
      },
    ),
    upstream: origin,
  });
  base = await relay.ready;
  wsBase = base.href.replace(/^http/, "ws").replace(/\/$/, "");
});
afterAll(async () => {
  await relay?.dispose();
  await context?.close();
});

const sql = <Row extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) => queryDatabase<Row>(context.database.url, text, values);

let addresses = 0;
/** One API request, each from its own address so no rate limit is shared. */
async function call(
  path: string,
  { body, bearer, method = "POST" }: { body?: unknown; bearer?: string; method?: string } = {},
) {
  const response = await relay.dispatchFetch(origin + path, {
    method,
    headers: {
      "cf-connecting-ip": `198.51.100.${++addresses % 250}`,
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : null) as Record<string, any> };
}

/** A user row made the one entitled account: `ADMIN_EMAIL` is unique, so whoever held it moves. */
async function entitled() {
  const id = randomUUID();
  await sql(`UPDATE "user" SET email = id || '@example.test' WHERE email = $1`, [ADMIN_EMAIL]);
  await sql(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $1, $2, true)`, [
    id,
    ADMIN_EMAIL,
  ]);
  return id;
}

/** An enrolled Burrow row, as the device-code poll writes one. */
async function burrowRow(userId: string) {
  const burrowId = randomRoutingId() as string;
  const burrowToken = randomSecret() as string;
  await sql(
    `INSERT INTO dormouse_relay_burrows ("burrowId", "userId", "tokenHash") VALUES ($1, $2, $3)`,
    [burrowId, userId, digest(burrowToken)],
  );
  return { burrowId, burrowToken };
}

/**
 * A passkey registered off `burrowToken`'s setup code and signed in, through
 * the Hosted routes as Pocket drives them.
 */
async function signedIn(burrowToken: string) {
  const authenticator = await newAuthenticator();
  const minted = await call(API_ROUTES.burrowSetupToken, { bearer: burrowToken });
  const setupToken = minted.json.token as string;
  const begun = await call(API_ROUTES.setupBegin, { body: { setupToken } });
  const finished = await call(API_ROUTES.setupFinish, {
    body: {
      setupToken,
      credentialId: authenticator.credentialId,
      publicKey: authenticator.publicKey,
      clientDataJSON: registrationClientData({ challenge: begun.json.challenge, origin }),
      label: "Phone",
    },
  });
  expect(finished.status).toBe(200);
  const challenge = (await call(API_ROUTES.signinBegin, { body: {} })).json.challenge;
  const assertion = await authenticator.assert({ challenge, origin });
  const signed = await call(API_ROUTES.signinFinish, { body: { assertion } });
  expect(signed.status).toBe(200);
  return { authenticator, sessionToken: signed.json.sessionToken as string };
}

const burrowUrl = (token: string) => `${wsBase}${WS_ROUTES.burrow}?${WS_TOKEN_PARAM}=${token}`;
const clientUrl = (token: string) => `${wsBase}${WS_ROUTES.client}?${WS_TOKEN_PARAM}=${token}`;

type FrameSocket = ReturnType<typeof openFrameSocket>;
const opened = new Set<FrameSocket>();
function socket(url: string, init?: { headers: Record<string, string> }) {
  const ws = openFrameSocket(url, init);
  opened.add(ws);
  return ws;
}
async function open(url: string, init?: { headers: Record<string, string> }) {
  const ws = socket(url, init);
  await ws.ready;
  return ws;
}
function closeAll() {
  for (const ws of opened) ws.close();
  opened.clear();
}

/** An entitled account, signed in, with the parity driver over its sockets. */
async function account() {
  const userId = await entitled();
  const first = await burrowRow(userId);
  const { sessionToken, authenticator } = await signedIn(first.burrowToken);
  const openClient = () => socket(clientUrl(sessionToken), POCKET);
  return {
    userId,
    sessionToken,
    authenticator,
    /** This account's object. */
    room: async () => roomOf(userId),
    driver: {
      async connectBurrow() {
        const row = await burrowRow(userId);
        return { ...row, socket: await open(burrowUrl(row.burrowToken)) };
      },
      reconnectBurrow: (burrowToken: string) => open(burrowUrl(burrowToken)),
      openClient,
      async connectClient() {
        const ws = openClient();
        await ws.ready;
        return ws;
      },
    },
  };
}

/** Whether an attachment is a socket the object still routes. */
const live = (conn: Record<string, unknown>) => !conn.retired;

/** Evict `account`'s object, its sockets hibernated, as the runtime does when nothing is happening. */
const hibernate = (account: string) =>
  relay.unsafeEvictDurableObject(wrangler.relay.name, "RelayRoom", {
    name: account,
    webSockets: "hibernate",
  });

for (const { name, run } of socketCases)
  test(`parity: ${name}`, async ({ onTestFinished }) => {
    onTestFinished(closeAll);
    await run((await account()).driver);
  });

for (const { name, run } of e2eCases)
  test(`parity: ${name}`, async ({ onTestFinished }) => {
    const owner = await account();
    const burrowStatic = await generateNoiseKeyPair();
    const clientStatic = await generateNoiseKeyPair();
    const peers: { close(): void }[] = [];
    onTestFinished(() => {
      for (const peer of peers) peer.close();
    });
    const fakeBurrow = async ({ burrowId, burrowToken }: { burrowId: string; burrowToken: string }) => {
      const peer = harness(FakeBurrow, {
        relayUrl: wsBase,
        burrowToken,
        burrowId,
        origin,
        rpId,
        noiseStaticKeyPair: burrowStatic,
      });
      peers.push(peer);
      await peer.ready;
      return peer;
    };
    const enrollment = await burrowRow(owner.userId);
    const burrow = await fakeBurrow(enrollment);
    const client = harness(FakeClient, {
      relayUrl: base.href.replace(/\/$/, ""),
      sessionToken: owner.sessionToken,
      burrowId: enrollment.burrowId,
      staticKeyPair: clientStatic,
      burrowStaticPublicKey: burrowStatic.publicKey,
      origin,
      rpId,
      socketInit: POCKET,
    });
    peers.push(client);
    await client.ready;
    await run({
      burrow,
      client,
      authenticator: owner.authenticator,
      accountId: owner.userId,
      enrollment,
      burrowStatic,
      clientStatic,
      replacementBurrow: () => fakeBurrow(enrollment),
      secondBurrow: async () => fakeBurrow(await burrowRow(owner.userId)),
      close: async () => {},
    });
  });

test("each upgrade resolves its token and Origin first, and hands the object only what they resolved to", async ({
  onTestFinished,
}) => {
  onTestFinished(closeAll);
  const owner = await account();
  const { burrowId, burrowToken } = await burrowRow(owner.userId);

  /** An upgrade's refusal: its status and body. */
  const refusal = async (url: string, headers: Record<string, string> = {}) => {
    const response = await relay.dispatchFetch(url.replace(wsBase, origin), {
      headers: { upgrade: "websocket", ...headers },
    });
    return { status: response.status, json: await response.json() };
  };
  // A Burrow socket carries no Origin: a browser page always sends one.
  expect(await refusal(burrowUrl(burrowToken), POCKET.headers)).toEqual({
    status: 403,
    json: { error: "forbidden" },
  });
  for (const token of ["", "short", randomSecret()])
    expect(await refusal(`${origin}${WS_ROUTES.burrow}?${WS_TOKEN_PARAM}=${token}`), token).toEqual({
      status: 401,
      json: { error: UNKNOWN_BURROW_TOKEN_ERROR },
    });
  // A Client socket carries exactly this origin: no other page's, and not none.
  for (const headers of [{}, { origin: ORIGINS.account }, { origin: `${origin}.evil.test` }] as Record<
    string,
    string
  >[])
    expect(await refusal(clientUrl(owner.sessionToken), headers)).toEqual({
      status: 403,
      json: { error: "forbidden" },
    });
  for (const token of ["", "short", randomSecret()])
    expect(await refusal(clientUrl(token), POCKET.headers), token).toEqual({
      status: 401,
      json: { error: UNAUTHORIZED_ERROR },
    });

  // Admitted, the object hears the account and the Burrow or the expiry, and
  // not one of the caller's headers or its token.
  const before = (await (await owner.room()).probe()).upgrades.length;
  await open(burrowUrl(burrowToken), {
    headers: { cookie: "a=b", authorization: "Bearer x", "cf-connecting-ip": "203.0.113.9" },
  });
  await open(clientUrl(owner.sessionToken), { headers: { ...POCKET.headers, cookie: "a=b" } });
  const { upgrades, storage } = await (await owner.room()).probe();
  expect(upgrades.slice(before)).toEqual([
    { headers: ["upgrade"], params: ["account", "burrow"] },
    { headers: ["upgrade"], params: ["account", "expires"] },
  ]);
  // Its one durable value is the account it serves.
  expect(storage).toEqual({ account: owner.userId });
  expect((await call(API_ROUTES.burrows, { bearer: owner.sessionToken, method: "GET" })).json.burrows).toContainEqual({
    burrowId,
    online: true,
  });

  // A de-entitled owner opens neither socket; Pocket reads the 401 as expiry.
  await entitled();
  expect(await refusal(burrowUrl(burrowToken))).toEqual({
    status: 403,
    json: { error: NOT_ENTITLED_ERROR },
  });
  expect(await refusal(clientUrl(owner.sessionToken), POCKET.headers)).toEqual({
    status: 401,
    json: { error: UNAUTHORIZED_ERROR },
  });
});

test("routing survives hibernation: across a binding, a replacement, and a pending session alarm", async ({
  onTestFinished,
}) => {
  onTestFinished(closeAll);
  const owner = await account();
  const first = await owner.driver.connectBurrow();
  const client = await owner.driver.connectClient();
  const init = e2eClientFrame(first.burrowId);
  client.send(init);
  const forwarded = await first.socket.take();

  // Between init and transport: the binding and the clientId are the attachment's.
  await hibernate(owner.userId);
  client.send(e2eClientFrame(first.burrowId, { step: "transport", id: init.id }));
  const transport = await first.socket.take();
  expect(transport).toMatchObject({ step: "transport", clientId: forwarded.clientId });
  first.socket.send({ ...transport, step: "transport", burrowId: undefined, ct: "YmFy" });
  expect(await client.take()).toMatchObject({ t: "e2e", burrowId: first.burrowId, ct: "YmFy" });

  // Between replacement steps.
  await hibernate(owner.userId);
  const second = await owner.driver.reconnectBurrow(first.burrowToken);
  expect((await first.socket.closed).code).toBe(WS_CLOSE_BURROW_REPLACED);
  expect(await client.take()).toEqual({ t: "burrow-gone" });
  await hibernate(owner.userId);
  client.send(e2eClientFrame(first.burrowId, { step: "transport" }));
  expect(await second.quiet(150)).toBe(true);
  await hibernate(owner.userId);
  client.send(e2eClientFrame(first.burrowId));
  expect(await second.take()).toMatchObject({ step: "init", clientId: forwarded.clientId });

  // A session about to expire: its alarm wakes the object it was armed in.
  await sql(`UPDATE dormouse_relay_sessions SET "expiresAt" = now() + interval '2 seconds'`);
  const expiring = await owner.driver.connectClient();
  expiring.send(e2eClientFrame(first.burrowId));
  const bound = await second.take();
  await hibernate(owner.userId);
  const closed = await expiring.closed;
  expect([closed.code, closed.reason]).toEqual([WS_CLOSE_UNAUTHORIZED, WS_CLOSE_UNAUTHORIZED_REASON]);
  expect(await second.take(3000)).toEqual({ t: "client-gone", clientId: bound.clientId });
  // The Client opened before the update holds its own expiry: still routed.
  client.send(e2eClientFrame(first.burrowId, { step: "transport" }));
  expect(await second.take()).toMatchObject({ step: "transport" });
});

test("the alarm is the earliest Client expiry or Burrow sweep; a close leaves it, and the alarm re-arms or clears", async ({
  onTestFinished,
}) => {
  onTestFinished(closeAll);
  const owner = await account();
  const room = await owner.room();
  const expiry = async () =>
    (
      await sql<{ expiresAt: number }>(
        `SELECT floor(extract(epoch from "expiresAt") * 1000)::float8 AS "expiresAt"
        FROM dormouse_relay_sessions WHERE "tokenHash" = $1`,
        [digest(owner.sessionToken)],
      )
    )[0]!.expiresAt;
  const later = await owner.driver.connectClient();
  expect((await room.probe()).alarm).toBe(await expiry());
  await sql(`UPDATE dormouse_relay_sessions SET "expiresAt" = "expiresAt" - interval '1 hour'`);
  const sooner = await owner.driver.connectClient();
  const soonest = await expiry();
  expect((await room.probe()).alarm).toBe(soonest);
  // A close writes nothing; the alarm, when it comes, moves to what is left.
  sooner.close();
  await sooner.closed;
  await until(async () => (await room.probe()).attachments.filter(live).length === 1);
  expect((await room.probe()).alarm).toBe(soonest);
  await room.fire();
  expect((await room.probe()).alarm).toBe(soonest + 3_600_000);

  // A Burrow socket brings the alarm to its sweep, at most an hour off.
  const before = Date.now();
  await owner.driver.connectBurrow();
  const swept = (await room.probe()).alarm!;
  expect(swept).toBeGreaterThanOrEqual(before + RELAY_ROOM_SWEEP_MS);
  expect(swept).toBeLessThanOrEqual(Date.now() + RELAY_ROOM_SWEEP_MS);
  // And a sweep, while the Burrow is held, schedules the next one an hour on.
  const sweeping = Date.now();
  await room.fire();
  const next = (await room.probe()).alarm!;
  expect(next).toBeGreaterThanOrEqual(sweeping + RELAY_ROOM_SWEEP_MS);
  expect(next).toBeLessThanOrEqual(Date.now() + RELAY_ROOM_SWEEP_MS);
  closeAll();
  await until(async () => (await room.probe()).attachments.filter(live).length === 0);
  await room.fire();
  expect((await room.probe()).alarm).toBe(null);
});

test("the sweep closes a Burrow removed (4001) or de-entitled (4002) behind its socket's back, and keeps the rest", async ({
  onTestFinished,
}) => {
  onTestFinished(closeAll);
  const owner = await account();
  const room = await owner.room();
  const removed = await owner.driver.connectBurrow();
  const kept = await owner.driver.connectBurrow();
  const client = await owner.driver.connectClient();
  client.send(e2eClientFrame(removed.burrowId));
  await removed.socket.take();

  // Removed with no RPC, as a removal whose close never arrived.
  await sql(`DELETE FROM dormouse_relay_burrows WHERE "burrowId" = $1`, [removed.burrowId]);
  await room.fire();
  expect((await removed.socket.closed).code).toBe(WS_CLOSE_BURROW_REVOKED);
  expect(await client.take()).toEqual({ t: "burrow-gone" });
  expect(await room.onlineBurrows(owner.userId)).toEqual([kept.burrowId]);
  expect(await kept.socket.quiet(150)).toBe(true);

  // The owner loses the entitlement: every Burrow socket it holds goes, on
  // the code that says why.
  await entitled();
  await room.fire();
  expect((await kept.socket.closed).code).toBe(WS_CLOSE_BURROW_NOT_ENTITLED);
  expect(await room.onlineBurrows(owner.userId)).toEqual([]);
});

test("a Burrow removed between the Worker's token check and the object's accept is refused", async ({
  onTestFinished,
}) => {
  onTestFinished(closeAll);
  const owner = await account();
  const room = await owner.room();
  // The object holds the account already: the refusals below are the row's.
  await owner.driver.connectClient();
  const enrolled = await burrowRow(owner.userId);
  // The upgrade as the Worker hands it on once the token resolved: accepted.
  expect(await room.forge(owner.userId, enrolled.burrowId)).toBe(101);
  const removed = await burrowRow(owner.userId);
  await sql(`DELETE FROM dormouse_relay_burrows WHERE "burrowId" = $1`, [removed.burrowId]);
  expect(await room.forge(owner.userId, removed.burrowId)).toBe(401);
  // Another account's Burrow, and one whose owner lost the entitlement.
  const other = await account();
  expect(await room.forge(owner.userId, (await burrowRow(other.userId)).burrowId)).toBe(401);
  expect(await room.forge(owner.userId, (await burrowRow(owner.userId)).burrowId)).toBe(403);
});

test("a stalled row read answers the upgrade 503 within its bound and leaves the sweep for later, the object's sockets open", async ({
  onTestFinished,
}) => {
  const owner = await account();
  const room = await owner.room();
  onTestFinished(async () => {
    closeAll();
    await room.stallRows(false);
  });
  const held = await owner.driver.connectBurrow();
  const client = await owner.driver.connectClient();
  const enrolled = await burrowRow(owner.userId);
  await room.stallRows(true);

  // Unbounded, the read would hold `blockConcurrencyWhile` past the runtime's
  // 30 s and reset the object, every socket with it.
  const started = Date.now();
  expect(await room.forge(owner.userId, enrolled.burrowId)).toBe(503);
  expect(Date.now() - started).toBeLessThan(RELAY_ROW_READ_TIMEOUT_MS + 5_000);
  // The sweep's read fails the same way and closes nothing.
  await room.fire();
  expect(await held.socket.quiet(150)).toBe(true);

  client.send(e2eClientFrame(held.burrowId));
  expect(await held.socket.take()).toMatchObject({ step: "init" });
  expect(await room.onlineBurrows(owner.userId)).toEqual([held.burrowId]);
  await room.stallRows(false);
  expect(await room.forge(owner.userId, enrolled.burrowId)).toBe(101);
});

test("a removal answers 204 once the row is gone, even when closing its socket fails", async () => {
  const userId = await entitled();
  const { burrowId } = await burrowRow(userId);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const app = new Hono();
  relayAccountRoutes(app, () => ({
    databaseUrl: context.database.url,
    auth: async () =>
      Response.json({ user: { id: userId, email: ADMIN_EMAIL, emailVerified: true }, session: {} }),
    approveLimit: {} as RateLimit,
    closeBurrow: async () => {
      throw new Error("the relay is unreachable");
    },
  }));
  const response = await app.request(`${ORIGINS.account}/api/relay/burrows/${burrowId}`, {
    method: "DELETE",
    headers: { origin: ORIGINS.account },
  });
  expect(response.status).toBe(204);
  expect(await sql(`SELECT 1 FROM dormouse_relay_burrows WHERE "burrowId" = $1`, [burrowId])).toEqual([]);
  expect(logged).toHaveBeenCalledOnce();
  logged.mockRestore();
});

test("a ping is answered without waking the object, and changes nothing it holds", async ({
  onTestFinished,
}) => {
  onTestFinished(closeAll);
  const owner = await account();
  const { burrowId, socket: burrow } = await owner.driver.connectBurrow();
  const client = await owner.driver.connectClient();
  client.send(e2eClientFrame(burrowId));
  await burrow.take();

  const room = await owner.room();
  const before = await room.probe();
  await hibernate(owner.userId);
  for (const ws of [client, burrow, client]) {
    ws.ws.send(RELAY_PING);
    expect(await ws.take()).toBe(RELAY_PONG);
  }
  const after = await room.probe();
  // The probe itself is the one wake-up; no handler ran for the pings.
  expect(after.constructed).toBe(before.constructed + 1);
  expect(after.handled).toBe(before.handled);
  expect(after.attachments).toEqual(before.attachments);
  expect(after.storage).toEqual(before.storage);
});

test("a Burrow silent past three ping intervals is gone when routed to, and is not reported online", async ({
  onTestFinished,
}) => {
  onTestFinished(async () => {
    closeAll();
    await (await owner.room()).skew(0);
  });
  const owner = await account();
  const quiet = await owner.driver.connectBurrow();
  const pinging = await owner.driver.connectBurrow();
  const neverPinged = await owner.driver.connectBurrow();
  for (const { socket } of [quiet, pinging]) {
    socket.ws.send(RELAY_PING);
    expect(await socket.take()).toBe(RELAY_PONG);
  }
  const room = await owner.room();
  await room.skew(RELAY_IDLE_TIMEOUT_MS + 1_000);
  // `pinging` pings again on time; `quiet` does not; `neverPinged` is never judged.
  pinging.socket.ws.send(RELAY_PING);
  expect(await pinging.socket.take()).toBe(RELAY_PONG);

  const client = await owner.driver.connectClient();
  client.send(e2eClientFrame(quiet.burrowId));
  expect((await client.take()).error).toBe(`burrow ${quiet.burrowId} is offline`);
  expect((await quiet.socket.closed).code).toBe(WS_CLOSE_IDLE);

  // `pinging`'s last pong is now behind the skewed clock too: not online, and gone.
  await room.skew(2 * RELAY_IDLE_TIMEOUT_MS);
  expect(await room.onlineBurrows(owner.userId)).toEqual([neverPinged.burrowId]);
  expect((await pinging.socket.closed).code).toBe(WS_CLOSE_IDLE);
});

test("at the Client cap, a silent socket is gone and a live one is never evicted", async ({
  onTestFinished,
}) => {
  const owner = await account();
  const room = await owner.room();
  onTestFinished(async () => {
    closeAll();
    await room.skew(0);
  });
  const clients = [];
  for (let i = 0; i < MAX_RELAY_CLIENT_SOCKETS; i += 1) clients.push(await owner.driver.connectClient());
  const [silent] = clients;
  silent.ws.send(RELAY_PING);
  expect(await silent.take()).toBe(RELAY_PONG);
  // Full, and nobody silent yet: refused.
  expect((await owner.driver.openClient().closed).code).toBe(WS_CLOSE_TRY_AGAIN_LATER);
  await room.skew(RELAY_IDLE_TIMEOUT_MS + 1_000);
  // The one that pinged and fell silent goes; those that never pinged stay.
  const admitted = owner.driver.openClient();
  await admitted.ready;
  expect((await silent.closed).code).toBe(WS_CLOSE_IDLE);
  expect(await admitted.quiet(150)).toBe(true);
  expect(clients.slice(1).every(({ ws }) => ws.readyState === WebSocket.OPEN)).toBe(true);
});

test("revocation closes a Burrow 4001 and tells its Clients; removal on the account pushes it", async ({
  onTestFinished,
}) => {
  onTestFinished(closeAll);
  const owner = await account();
  const { burrowId, socket: burrow } = await owner.driver.connectBurrow();
  const client = await owner.driver.connectClient();
  client.send(e2eClientFrame(burrowId));
  await burrow.take();
  const room = await owner.room();
  expect(await room.closeBurrow(owner.userId, newE2eId())).toBe(false);
  await hibernate(owner.userId);
  expect(await room.closeBurrow(owner.userId, burrowId)).toBe(true);
  expect((await burrow.closed).code).toBe(WS_CLOSE_BURROW_REVOKED);
  expect(await client.take()).toEqual({ t: "burrow-gone" });
  expect(await room.onlineBurrows(owner.userId)).toEqual([]);
  expect(await room.closeBurrow(owner.userId, burrowId)).toBe(false);
});

test("one object per account: another account's session never reaches this account's Burrow", async ({
  onTestFinished,
}) => {
  onTestFinished(closeAll);
  const a = await account();
  const { burrowId, socket: burrowA } = await a.driver.connectBurrow();
  const clientA = await a.driver.connectClient();
  clientA.send(e2eClientFrame(burrowId));
  const { clientId } = await burrowA.take();

  // B is entitled now; A's live sockets stay as they are.
  const b = await account();
  const clientB = await b.driver.connectClient();
  for (const step of ["init", "transport"]) {
    clientB.send(e2eClientFrame(burrowId, { step }));
    if (step === "init") expect((await clientB.take()).error).toBe(`burrow ${burrowId} is offline`);
  }
  expect(await burrowA.quiet(150)).toBe(true);
  expect((await call(API_ROUTES.burrows, { bearer: b.sessionToken, method: "GET" })).json.burrows).not.toContainEqual(
    expect.objectContaining({ burrowId }),
  );
  // A frame A's Burrow addresses to its own Client still reaches only that Client.
  burrowA.send({ t: "e2e", clientId, kind: "pairing", id: newE2eId(), step: "response", ct: "YmFy" });
  expect((await clientA.take()).burrowId).toBe(burrowId);
  expect(await clientB.quiet(150)).toBe(true);

  // A's object, handed B's account, refuses: no socket, no RPC, nothing written.
  const roomA = await a.room();
  expect(await roomA.forge(b.userId, newE2eId())).toBe(403);
  expect(await roomA.closeBurrow(b.userId, burrowId)).toBe(false);
  expect(await roomA.onlineBurrows(b.userId)).toEqual([]);
  expect((await roomA.probe()).storage).toEqual({ account: a.userId });
  expect(await roomA.onlineBurrows(a.userId)).toEqual([burrowId]);
});

test("a Burrow enrolled by device code pairs and connects a phone, and under Local networks ends the session its first request relays", async ({
  onTestFinished,
}) => {
  const peers: { close(): void }[] = [];
  onTestFinished(() => {
    for (const peer of peers) peer.close();
  });
  const userId = await entitled();

  // The Burrow asks the relay for a code, as `beginHostedEnrollment` does …
  const begun = await call(API_ROUTES.burrowEnrollBegin, { body: { origin } });
  expect(begun.status).toBe(200);
  // … its account approves it on the account origin, as the enroll page posts …
  const account = new Hono();
  relayAccountRoutes(account, () => ({
    databaseUrl: context.database.url,
    auth: async () =>
      Response.json({
        user: { id: userId, email: ADMIN_EMAIL, emailVerified: true },
        session: { createdAt: new Date().toISOString() },
      }),
    approveLimit: { limit: async () => ({ success: true }) } as unknown as RateLimit,
    closeBurrow: async () => true,
  }));
  const approved = await account.request(`${ORIGINS.account}/api/relay/enrollments/approve`, {
    method: "POST",
    headers: { origin: ORIGINS.account, "content-type": "application/json" },
    body: JSON.stringify({ userCode: begun.json.userCode }),
  });
  expect(approved.status).toBe(204);
  // … and its poll answers the enrollment, once.
  const polled = await call(API_ROUTES.burrowEnrollPoll, { body: { deviceCode: begun.json.deviceCode } });
  expect(polled.json.status).toBe("enrolled");
  const { burrowId, burrowToken } = polled.json.enrollment as { burrowId: string; burrowToken: string };

  // The Burrow under Local networks (`BurrowRuntime` with the path policy
  // held), on the relay socket that token opens.
  const burrowStatic = await generateNoiseKeyPair();
  const burrow = harness(FakeBurrow, {
    relayUrl: wsBase,
    burrowToken,
    burrowId,
    origin,
    rpId,
    noiseStaticKeyPair: burrowStatic,
    directOnly: true,
  });
  peers.push(burrow);
  await burrow.ready;

  // A phone whose passkey joined the account off this Burrow's setup code,
  // paired and connected through the account's object.
  const { authenticator, sessionToken } = await signedIn(burrowToken);
  const client = harness(FakeClient, {
    relayUrl: base.href.replace(/\/$/, ""),
    sessionToken,
    burrowId,
    staticKeyPair: await generateNoiseKeyPair(),
    burrowStaticPublicKey: burrowStatic.publicKey,
    origin,
    rpId,
    socketInit: POCKET,
  });
  peers.push(client);
  await client.ready;
  const paired = await client.pair({ invitation: await burrow.mintInvitation(), authenticator, accountId: userId });
  expect(paired.ok).toBe(true);
  const connected = await client.connect({ authenticator });
  expect(connected.outcome).toEqual({ ok: true, burrowLabel: burrow.label, directOnly: true });

  // A keepalive is no application message; the first request is, and the
  // Burrow ends the session unread, saying goodbye through the relay.
  const answered: unknown[] = [];
  burrow.on("msg", (event: unknown) => answered.push(event));
  const relayed = new Promise((resolve) => burrow.once("relayed-app", resolve));
  client.sendKeepalive();
  client.sendApp(
    utf8Encode(JSON.stringify({ requestId: "r1", method: REMOTE_METHODS.hello, params: { protocolVersion: 1, viewer: "phone" } })),
  );
  await relayed;
  const goodbye = client.receiveFrame(await client.nextTransport());
  expect(goodbye).toEqual({ kind: "control", value: SESSION_END_V1 });
  expect(answered).toEqual([]);
});
