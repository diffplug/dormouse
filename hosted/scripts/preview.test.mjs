import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  previewName,
  previewConfig,
  previewConfigs,
  hyperdriveOrigin,
  cloudflare,
  findHyperdrives,
  cleanup,
  previewRatelimitNamespace,
  previewSecrets,
} from "./preview.mjs";
import { healthSmoke, smoke, smokeAll } from "./preview-smoke.mjs";
import { readConfigs } from "./workers.mjs";

const env = {
  PR_NUMBER: "42",
  CLOUDFLARE_WORKERS_SUBDOMAIN: "hosted-tests",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_API_TOKEN: "dummy-token",
  BUILD_SHA: "b".repeat(40),
  NEON_PROJECT_ID: "test-project",
  NEON_API_KEY: "dummy-neon-token",
};
const result = (value, extra = {}) =>
  Response.json({ success: true, result: value, ...extra });

test("each preview configuration isolates its origin and excludes production bindings", async () => {
  const bases = await readConfigs();
  // Every production field a preview must never copy, added to each base.
  const stale = (base) => ({
    ...base,
    routes: ["production.example/*"],
    vars: { ...base.vars, GOOGLE_CLIENT_SECRET: "do-not-copy", ELEVENLABS_API_KEY: "do-not-copy" },
    d1_databases: [{ production: true }],
    triggers: { crons: ["* * * * *"] },
  });
  const configs = previewConfigs(
    {
      account: stale(bases.account),
      relay: stale(bases.relay),
      voice: stale(bases.voice),
    },
    env,
    "c".repeat(32),
  );
  const expected = {
    account: ["dormouse-hosted-pr-42", "../../server/preview-worker.ts"],
    relay: ["dormouse-relay-pr-42", "../../server/relay-worker.ts"],
    voice: ["dormouse-voice-pr-42", "../../server/voice-preview-worker.ts"],
  };
  for (const [worker, [name, main]] of Object.entries(expected)) {
    const config = configs[worker];
    assert.equal(config.name, name, worker);
    assert.equal(config.main, main, worker);
    assert.deepEqual(
      config.vars,
      {
        APP_ORIGIN: `https://${name}.hosted-tests.workers.dev`,
        BUILD_SHA: env.BUILD_SHA,
        // The relay's enrollment links name this PR's account preview.
        ...(worker === "relay" && {
          ACCOUNT_ORIGIN: "https://dormouse-hosted-pr-42.hosted-tests.workers.dev",
        }),
      },
      worker,
    );
    assert.equal(config.workers_dev, true, worker);
    assert.equal(config.preview_urls, false, worker);
    for (const key of ["routes", "triggers", "d1_databases", "observability"])
      assert.equal(config[key], undefined, `${worker} ${key}`);
  }
  // Production alone sweeps ElevenLabs history, on the voice Worker; a preview has no cron.
  assert.ok(bases.voice.triggers?.crons?.length);
  // All three previews share one database.
  assert.deepEqual(configs.account.hyperdrive, [{ binding: "HYPERDRIVE", id: "c".repeat(32) }]);
  assert.deepEqual(configs.voice.hyperdrive, configs.account.hyperdrive);
  assert.deepEqual(configs.relay.hyperdrive, configs.account.hyperdrive);
  assert.equal(configs.account.assets.directory, "../../dist/account");
  assert.equal(configs.relay.assets.directory, "../../dist/relay");
  assert.equal(configs.voice.assets, undefined);
  for (const worker of ["account", "relay"])
    assert.equal(configs[worker].assets.run_worker_first, true, worker);
  // Production's account keeps the migrations that deleted its old room; its
  // preview, implementing no Durable Object, carries none, and its binding to
  // the relay's `RelayRoom` names this PR's relay preview.
  assert.ok(bases.account.migrations?.length);
  assert.equal(configs.account.migrations, undefined);
  assert.deepEqual(configs.account.durable_objects, {
    bindings: [{ name: "RELAY_ROOM", class_name: "RelayRoom", script_name: "dormouse-relay-pr-42" }],
  });
  assert.deepEqual(configs.relay.durable_objects, bases.relay.durable_objects);
  assert.deepEqual(configs.relay.migrations, bases.relay.migrations);
  for (const worker of ["relay", "account"])
    assert.deepEqual(
      configs[worker].ratelimits.map(({ name, namespace_id }) => [name, namespace_id]),
      bases[worker].ratelimits.map(({ name, namespace_id }) => [
        name,
        String(Number(namespace_id) + 1000),
      ]),
      worker,
    );
  for (const bad of ["0", "-1", "42/../../production", "main", "42\n"])
    assert.throws(() => previewName(bad, "dormouse-hosted"));
  assert.throws(() =>
    previewConfig(
      bases.account,
      { ...env, CLOUDFLARE_WORKERS_SUBDOMAIN: "example.com" },
      "account",
      "c".repeat(32),
    ),
  );
  assert.throws(() => previewConfigs(bases, env, "not-an-id"));
});

test("preview configuration keeps its own Durable Objects and rate-limit namespaces", () => {
  const durable_objects = {
    bindings: [{ name: "ROOM", class_name: "Room" }],
  };
  const migrations = [{ tag: "v1", new_sqlite_classes: ["Room"] }];
  const config = previewConfig(
    {
      name: "dormouse-relay",
      compatibility_date: "2026-01-01",
      assets: { directory: "./dist/relay" },
      durable_objects,
      migrations,
      ratelimits: [
        { name: "LIMIT", namespace_id: "7", simple: { limit: 1, period: 60 } },
      ],
    },
    env,
    "relay",
  );
  assert.deepEqual(config.durable_objects, durable_objects);
  assert.deepEqual(config.migrations, migrations);
  assert.deepEqual(config.ratelimits, [
    { name: "LIMIT", namespace_id: "1007", simple: { limit: 1, period: 60 } },
  ]);
  // Another Worker's class: its preview's, and it carries this Worker's
  // migrations only beside a class of its own.
  const foreign = { name: "OTHER", class_name: "Other", script_name: "dormouse-other" };
  const previewForeign = { ...foreign, script_name: "dormouse-other-pr-42" };
  const base = { name: "dormouse-hosted", compatibility_date: "2026-01-01", migrations };
  const onlyForeign = previewConfig(
    { ...base, durable_objects: { bindings: [foreign] } },
    env,
    "account",
  );
  assert.deepEqual(onlyForeign.durable_objects, { bindings: [previewForeign] });
  assert.equal(onlyForeign.migrations, undefined);
  const both = previewConfig(
    { ...base, durable_objects: { bindings: [...durable_objects.bindings, foreign] } },
    env,
    "account",
  );
  assert.deepEqual(both.durable_objects, {
    bindings: [...durable_objects.bindings, previewForeign],
  });
  assert.deepEqual(both.migrations, migrations);
  for (const bad of ["0", "1000", "-3", "x", "1.5"])
    assert.throws(() => previewRatelimitNamespace(bad));
});

test("Hyperdrive uses a direct URL and decodes credentials without logging them", () => {
  assert.deepEqual(
    hyperdriveOrigin(
      "postgresql://test:p%40ss%3Aword@ep-test.neon.tech/neondb?sslmode=require",
    ),
    {
      scheme: "postgres",
      host: "ep-test.neon.tech",
      port: 5432,
      database: "neondb",
      user: "test",
      password: "p@ss:word",
    },
  );
  assert.throws(
    () =>
      hyperdriveOrigin(
        "postgres://test:password@ep-test-pooler.neon.tech/neondb",
      ),
    /direct/,
  );
  assert.throws(() => hyperdriveOrigin("https://example.com"));
});

test("Cloudflare errors omit provider bodies, and missing deletions are idempotent", async () => {
  const api = cloudflare(env, async () =>
    Response.json(
      { success: false, errors: ["sensitive-password"] },
      { status: 403 },
    ),
  );
  await assert.rejects(api("hyperdrive/configs"), (error) => {
    assert.match(error.message, /403/);
    assert.doesNotMatch(error.message, /sensitive-password/);
    return true;
  });
  const missing = cloudflare(
    env,
    async () => new Response("missing", { status: 404 }),
  );
  assert.equal(
    await missing("workers/scripts/dormouse-hosted-pr-42", "DELETE"),
    null,
  );
  await assert.rejects(missing("workers/scripts/dormouse-hosted-pr-42"));
});

test("resource lookup paginates and matches exact PR names", async () => {
  const paths = [];
  const found = await findHyperdrives(async (path) => {
    paths.push(path);
    return {
      result_info: { total_pages: 2 },
      result:
        paths.length === 1
          ? [{ id: "other", name: "dormouse-hosted-pr-420" }]
          : [{ id: "ours", name: "dormouse-hosted-pr-42" }],
    };
  }, "dormouse-hosted-pr-42");
  assert.deepEqual(found, [{ id: "ours", name: "dormouse-hosted-pr-42" }]);
  assert.equal(paths.length, 2);
});

test("Cloudflare auth diagnostics expose numeric codes, never provider messages or malformed tokens", async () => {
  for (const token of [
    "Bearer synthetic-token",
    "synthetic-token\n",
    '"synthetic-token"',
  ])
    assert.throws(
      () => cloudflare({ ...env, CLOUDFLARE_API_TOKEN: token }),
      (error) => {
        assert.match(error.message, /only the token value/);
        assert.doesNotMatch(error.message, /synthetic-token/);
        return true;
      },
    );
  const api = cloudflare(env, async () =>
    Response.json(
      {
        success: false,
        errors: [
          {
            code: 6003,
            message: "sensitive-password",
            error_chain: [{ code: 6111, message: "sensitive-token" }],
          },
          { code: "sensitive-non-numeric-code" },
        ],
      },
      { status: 400 },
    ),
  );
  await assert.rejects(api("hyperdrive/configs"), (error) => {
    assert.match(error.message, /400; codes: 6003, 6111/);
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
});

test("cleanup only deletes this PR's resources and can run twice", async (t) => {
  const removed = [];
  const forced = [];
  let existing = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const path = new URL(url).pathname;
    if (options.method === "DELETE") {
      removed.push(path);
      if (path.includes("/workers/scripts/"))
        forced.push(new URL(url).searchParams.get("force") === "true");
      return existing ? result({}) : new Response("missing", { status: 404 });
    }
    if (path.endsWith("hyperdrive/configs"))
      return result(
        existing
          ? [
              { id: "ours", name: "dormouse-hosted-pr-42" },
              { id: "other", name: "dormouse-hosted-pr-420" },
            ]
          : [],
      );
    if (path.endsWith("branches"))
      return Response.json({
        branches: existing
          ? [
              { id: "br-ours", name: "dormouse-hosted-pr-42" },
              { id: "br-main", name: "main" },
            ]
          : [],
      });
    throw new Error(`Unexpected request ${path}`);
  });
  await cleanup(env);
  existing = false;
  await cleanup(env);
  const workers = ["dormouse-relay-pr-42", "dormouse-voice-pr-42", "dormouse-hosted-pr-42"];
  assert.deepEqual(
    removed.map((path) => path.split("/").pop()),
    [...workers, "ours", "br-ours", ...workers],
  );
  assert.deepEqual(
    forced,
    Array(6).fill(true),
    "a Worker implementing a Durable Object is deleted with force",
  );
});

test("deployment smoke compares enabled providers as a set, not a sequence", async () => {
  const origin = "https://hosted.example.test";
  // Every request the production smoke makes before its first POST; the POST
  // throws so a rejection distinguishes "passed the provider check" from
  // "failed it".
  const fetcher = (providers) => async (url) => {
    const { pathname } = new URL(url);
    if (pathname === "/api/health")
      return Response.json({ ok: true, revision: env.BUILD_SHA });
    if (pathname === "/api/auth/csrf")
      return Response.json(
        { csrf: "csrf-token" },
        {
          headers: {
            "cache-control": "no-store",
            "set-cookie":
              "__Host-session=1; Path=/; Secure; HttpOnly; SameSite=Lax",
          },
        },
      );
    if (pathname === "/api/auth/get-session") return Response.json(null);
    if (pathname === "/api/providers") return Response.json(providers);
    if (pathname === "/api/ready") return new Response(null, { status: 200 });
    throw new Error(`past-providers:${pathname}`);
  };
  // The packed adapter emits its own fixed order, not the configured one.
  await assert.rejects(
    smoke(origin, env.BUILD_SHA, fetcher(["google", "github"]), false, [
      "github",
      "google",
    ]),
    /past-providers/,
  );
  for (const enabled of [["google"], ["github", "google", "apple"], []])
    await assert.rejects(
      smoke(origin, env.BUILD_SHA, fetcher(enabled), false, [
        "github",
        "google",
      ]),
      /Unexpected enabled OAuth providers/,
    );
});

test("preview cleanup runs the base branch's script, never the closed PR's", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/hosted-preview.yml", import.meta.url),
    "utf8",
  );
  const cleanup = workflow.slice(workflow.indexOf("\n  cleanup:"));
  assert.ok(cleanup.includes("preview.mjs cleanup"), "Found the cleanup job");
  assert.match(cleanup, /\n {10}ref: refs\/heads\/main\n/);
  assert.doesNotMatch(cleanup, /pull_request\.head\.sha/);
  assert.match(cleanup, /\n {10}persist-credentials: false\n/);
});

test("deployment smoke rejects malformed health before making any auth requests", async () => {
  let requests = 0;
  await assert.rejects(
    smoke(
      "https://dormouse-hosted-pr-42.test.workers.dev",
      env.BUILD_SHA,
      async () => {
        requests++;
        return Response.json({
          ok: true,
          development: false,
          revision: "stale",
        });
      },
    ),
  );
  assert.equal(requests, 1);
});

test("the smoke runs its parts concurrently, retries each alone, and checks the push config and rendezvous after the relay's revision alone", async () => {
  const origins = {
    account: "https://account.example.test",
    relay: "https://relay.example.test",
    voice: "https://voice.example.test",
  };
  const events = [];
  // The relay's VAPID key, or null while push is off.
  let pushKey = `B${"A".repeat(86)}`;
  // How many more health checks each origin fails before it is healthy.
  const unhealthy = {};
  // Every request the production smoke makes, answered as a healthy account would.
  const fetcher = async (url, init = {}) => {
    const { origin, pathname } = new URL(url);
    if (pathname === "/api/health") {
      events.push(`${origin} health`);
      if (unhealthy[origin] > 0) {
        unhealthy[origin]--;
        return Response.json({ ok: false }, { status: 503 });
      }
      return Response.json({ ok: true, revision: env.BUILD_SHA });
    }
    if (pathname === "/api/push/config") {
      assert.equal(origin, origins.relay);
      events.push("push");
      return Response.json({ applicationServerKey: pushKey });
    }
    assert.equal(origin, origins.account);
    if (pathname === "/api/ready") return new Response(null, { status: 200 });
    if (pathname === "/api/auth/csrf")
      return Response.json(
        { csrf: "csrf-token" },
        {
          headers: {
            "cache-control": "no-store",
            "set-cookie": "__Host-session=1; Path=/; Secure; HttpOnly; SameSite=Lax",
          },
        },
      );
    if (pathname === "/api/auth/get-session") return Response.json(null);
    if (pathname === "/api/providers") return Response.json([]);
    if (init.method === "POST") return new Response(null, { status: 403 });
    if (pathname === "/login")
      return new Response("<html></html>", { headers: { "content-type": "text/html" } });
    return new Response(null, { status: 404 });
  };
  const count = (event) => events.filter((e) => e === event).length;
  const oneTime = async (origin) => {
    assert.equal(origin, origins.relay);
    events.push("one-time");
  };
  const waits = [];
  unhealthy[origins.relay] = 1;
  await smokeAll(origins, env.BUILD_SHA, {
    fetcher,
    attempts: 2,
    wait: async (ms) => waits.push(ms),
    oneTime,
  });
  // The relay alone retried; the rendezvous ran once, after it passed.
  assert.deepEqual(waits, [10_000]);
  assert.equal(count(`${origins.account} health`), 1);
  assert.equal(count(`${origins.voice} health`), 1);
  assert.equal(count(`${origins.relay} health`), 2);
  assert.equal(count("one-time"), 1);
  assert.equal(count("push"), 1);
  assert.ok(events.indexOf("push") > events.lastIndexOf(`${origins.relay} health`));
  assert.equal(events.at(-1), "one-time");

  // A relay with push off — a VAPID secret missing, or a pair that does not
  // match — fails the smoke: preflight can read only the secrets' names.
  events.length = 0;
  pushKey = null;
  await assert.rejects(smokeAll(origins, env.BUILD_SHA, { fetcher, oneTime }), {
    message: `${origins.relay} must answer a VAPID key: both relay secrets set, as one pair`,
  });
  pushKey = `B${"A".repeat(86)}`;

  // Per-part attempts: the account runs once while the relay and voice retry.
  events.length = 0;
  waits.length = 0;
  Object.assign(unhealthy, { [origins.account]: 1, [origins.relay]: 2, [origins.voice]: 1 });
  await assert.rejects(
    smokeAll(origins, env.BUILD_SHA, {
      fetcher,
      attempts: { account: 1, relay: 3, voice: 2 },
      wait: async (ms) => waits.push(ms),
      oneTime,
    }),
    { message: new RegExp(`^${origins.account} must be healthy`) },
  );
  assert.equal(count(`${origins.account} health`), 1);
  assert.equal(count(`${origins.relay} health`), 3);
  assert.equal(count(`${origins.voice} health`), 2);
  // An account failure does not hold back the rendezvous.
  assert.equal(count("one-time"), 1);

  // A part out of attempts fails the smoke, the rendezvous never runs on a
  // relay that did not pass, and every failed part is reported.
  events.length = 0;
  Object.assign(unhealthy, { [origins.account]: 1, [origins.relay]: 1 });
  await assert.rejects(
    smokeAll(origins, env.BUILD_SHA, { fetcher, oneTime }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map(({ message }) => message.split("\n")[0]),
        [`${origins.account} must be healthy`, `${origins.relay} must be healthy`],
      );
      return true;
    },
  );
  assert.equal(count("one-time"), 0);
});

test("a relay or voice health check requires the deployed revision, and nothing else", async () => {
  const origin = "https://dormouse-voice-pr-42.test.workers.dev";
  const answering = (status, body) => async (url) => {
    assert.equal(url, origin + "/api/health");
    return Response.json(body, { status });
  };
  await healthSmoke(origin, env.BUILD_SHA, answering(200, { ok: true, revision: env.BUILD_SHA }));
  await assert.rejects(
    healthSmoke(origin, env.BUILD_SHA, answering(200, { ok: true, revision: env.BUILD_SHA, extra: 1 })),
  );
  await assert.rejects(
    healthSmoke(origin, env.BUILD_SHA, answering(503, { ok: false })),
    /must be healthy/,
  );
  await assert.rejects(healthSmoke(origin + "/", env.BUILD_SHA, answering(200, {})), /exact origin/);
});

test("each preview Worker with a secret gets its own, derived from the preview secret and its name", async () => {
  const configs = previewConfigs(await readConfigs(), env, "c".repeat(32));
  const secret = "p".repeat(32);
  const derived = (name) => createHmac("sha256", secret).update(name).digest("hex");
  const secrets = previewSecrets(configs, { ...env, PREVIEW_AUTH_SECRET: secret });
  const { RELAY_VAPID_PUBLIC_KEY, RELAY_VAPID_PRIVATE_KEY, ...relay } = secrets.relay;
  assert.deepEqual(
    { ...secrets, relay },
    {
      account: { AUTH_SECRET: derived("dormouse-hosted-pr-42") },
      relay: { RELAY_ENROLL_SECRET: derived("dormouse-relay-pr-42") },
    },
  );
  // The relay's VAPID scalar is the HMAC of its name, and its point signs as one pair.
  assert.equal(
    RELAY_VAPID_PRIVATE_KEY,
    createHmac("sha256", secret).update("dormouse-relay-pr-42/vapid").digest("base64url"),
  );
  const point = Buffer.from(RELAY_VAPID_PUBLIC_KEY, "base64url");
  assert.equal(point.length, 65);
  const jwk = { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") };
  const signature = sign("sha256", Buffer.from("probe"), createPrivateKey({ key: { ...jwk, d: RELAY_VAPID_PRIVATE_KEY }, format: "jwk" }));
  assert.ok(verify("sha256", Buffer.from("probe"), createPublicKey({ key: jwk, format: "jwk" }), signature));
  // Stable across redeploys of one PR, distinct across PRs and secrets.
  assert.deepEqual(previewSecrets(configs, { ...env, PREVIEW_AUTH_SECRET: secret }), secrets);
  const otherPr = previewConfigs(await readConfigs(), { ...env, PR_NUMBER: "43" }, "c".repeat(32));
  assert.notEqual(
    previewSecrets(otherPr, { ...env, PREVIEW_AUTH_SECRET: secret }).relay.RELAY_VAPID_PRIVATE_KEY,
    RELAY_VAPID_PRIVATE_KEY,
  );
  assert.throws(() => previewSecrets(configs, env), /Missing PREVIEW_AUTH_SECRET/);
  assert.throws(
    () => previewSecrets(configs, { ...env, PREVIEW_AUTH_SECRET: "short" }),
    /at least 32 random characters/,
  );
});
