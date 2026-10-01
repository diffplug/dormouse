import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import {
  deployProduction,
  productionConfig,
  productionConfigs,
  productionSmoke,
  preflight,
} from "./production.mjs";
import { deployWorkers, oauthProviders, readConfigs } from "./workers.mjs";
const bases = await readConfigs();
const env = {
  BUILD_SHA: "a".repeat(40),
  HYPERDRIVE_ID: "b".repeat(32),
  CLOUDFLARE_ACCOUNT_ID: "c".repeat(32),
  DATABASE_URL: "postgres://migration:synthetic@ep-production.neon.tech/neondb",
};
const configs = productionConfigs(bases, env);
test("each production config keeps its canonical domain and production entry, and excludes public aliases", () => {
  const expected = {
    account: ["dormouse-hosted", "https://hosted.dormouse.sh", "../../server/worker.ts"],
    relay: ["dormouse-relay", "https://relay.dormouse.sh", "../../server/relay-worker.ts"],
    voice: ["dormouse-voice", "https://voice.dormouse.sh", "../../server/voice-worker.ts"],
  };
  for (const [worker, [name, origin, main]] of Object.entries(expected)) {
    const config = configs[worker];
    assert.equal(config.name, name, worker);
    assert.equal(config.main, main, worker);
    assert.equal(config.vars.APP_ORIGIN, origin, worker);
    assert.equal(config.vars.BUILD_SHA, env.BUILD_SHA, worker);
    assert.deepEqual(
      config.routes,
      [{ pattern: new URL(origin).host, custom_domain: true }],
      worker,
    );
    assert.equal(config.workers_dev, false, worker);
    assert.equal(config.preview_urls, false, worker);
    assert.deepEqual(config.observability, { enabled: false }, worker);
    const alias = {
      ...bases[worker],
      routes: [...bases[worker].routes, { pattern: "dormouse.sh/*" }],
    };
    assert.throws(() => productionConfig(alias, env, worker), worker);
    assert.throws(
      () => productionConfig({ ...bases[worker], workers_dev: true }, env, worker),
      worker,
    );
  }
  // The relay's enrollment links name production's account, and no other.
  assert.equal(configs.relay.vars.ACCOUNT_ORIGIN, "https://hosted.dormouse.sh");
  for (const elsewhere of [undefined, "https://evil.example.test"])
    assert.throws(() =>
      productionConfig(
        { ...bases.relay, vars: { ...bases.relay.vars, ACCOUNT_ORIGIN: elsewhere } },
        env,
        "relay",
      ),
    );
  // Each config is its own Worker's: none stands in for a sibling.
  assert.throws(() => productionConfig(bases.relay, env, "account"));
  assert.throws(() => productionConfig(bases.account, env, "voice"));
  // All three share the production database.
  assert.deepEqual(configs.account.hyperdrive, [{ binding: "HYPERDRIVE", id: env.HYPERDRIVE_ID }]);
  assert.deepEqual(configs.voice.hyperdrive, configs.account.hyperdrive);
  assert.deepEqual(configs.relay.hyperdrive, configs.account.hyperdrive);
  assert.equal(configs.account.assets.directory, "../../dist/account");
  assert.equal(configs.relay.assets.directory, "../../dist/relay");
  assert.equal(configs.voice.assets, undefined);
  assert.throws(() =>
    productionConfig(bases.account, { ...env, HYPERDRIVE_ID: "0".repeat(32) }, "account"),
  );
  for (const worker of ["voice", "relay"])
    assert.throws(() =>
      productionConfig(bases[worker], { ...env, HYPERDRIVE_ID: "0".repeat(32) }, worker),
    );
  assert.throws(() =>
    productionConfig(bases.account, { ...env, BUILD_SHA: "main" }, "account"),
  );
  assert.throws(() => productionConfig(bases.account, env));
});
test("Workers deploy relay, voice, then account from one config path each, and a failure stops the rest", async (t) => {
  t.after(() =>
    rm(new URL("../.wrangler/deploy-test/", import.meta.url), { recursive: true, force: true }),
  );
  const deployed = [];
  // Reads the config while it is on disk, as Wrangler does.
  const spawn = (failing) => (_command, args) => {
    const path = args[args.indexOf("--config") + 1];
    const { name } = JSON.parse(readFileSync(path, "utf8"));
    deployed.push([name, path]);
    return { status: name === failing ? 1 : 0 };
  };
  await deployWorkers("deploy-test", configs, { spawn: spawn() });
  assert.deepEqual(
    deployed.map(([name, path]) => [name, path.split("/").slice(-3).join("/")]),
    // The account last: its `v2` deletes the `OneTimeRoom` the relay replaces.
    [
      ["dormouse-relay", ".wrangler/deploy-test/wrangler.relay.json"],
      ["dormouse-voice", ".wrangler/deploy-test/wrangler.voice.json"],
      ["dormouse-hosted", ".wrangler/deploy-test/wrangler.account.json"],
    ],
  );
  deployed.length = 0;
  await assert.rejects(
    deployWorkers("deploy-test", configs, { spawn: spawn("dormouse-voice") }),
    { message: "dormouse-voice deploy failed" },
  );
  assert.deepEqual(deployed.map(([name]) => name), ["dormouse-relay", "dormouse-voice"]);
  // Each config is removed once deployed, failed or not.
  for (const [, path] of deployed)
    await assert.rejects(readFile(path), { code: "ENOENT" });
});
test("production smokes the relay before anything after it deploys, and a relay failure never deploys the account", async (t) => {
  t.after(() =>
    rm(new URL("../.wrangler/deploy-production-test/", import.meta.url), {
      recursive: true,
      force: true,
    }),
  );
  const events = [];
  const spawn = (_command, args) => {
    const path = args[args.indexOf("--config") + 1];
    events.push(`deploy ${JSON.parse(readFileSync(path, "utf8")).name}`);
    return { status: 0 };
  };
  // The relay's health fails this many times before it passes.
  let unhealthy = 5;
  const fetcher = async (url) => {
    if (url === "https://relay.dormouse.sh/api/push/config") {
      events.push("relay push");
      return Response.json({ applicationServerKey: "B" + "A".repeat(86) });
    }
    assert.equal(url, "https://relay.dormouse.sh/api/health");
    events.push("relay health");
    return unhealthy-- > 0
      ? Response.json({ ok: false }, { status: 503 })
      : Response.json({ ok: true, revision: env.BUILD_SHA });
  };
  const deploy = (oneTime) =>
    deployProduction(configs, env.BUILD_SHA, {
      stage: "deploy-production-test",
      spawn,
      fetcher,
      oneTime,
      wait: async () => {},
    });
  await deploy(async (origin) => {
    assert.equal(origin, "https://relay.dormouse.sh");
    events.push("relay one-time");
  });
  // The relay retried up to its sixth attempt, then the rendezvous ran once.
  assert.deepEqual(events, [
    "deploy dormouse-relay",
    ...Array(6).fill("relay health"),
    "relay push",
    "relay one-time",
    "deploy dormouse-voice",
    "deploy dormouse-hosted",
  ]);
  events.length = 0;
  let rendezvous = 0;
  await assert.rejects(
    deploy(async () => {
      rendezvous++;
      throw new Error("rendezvous failed");
    }),
    { message: "rendezvous failed" },
  );
  // Six attempts, then nothing else deploys: the account's `v2` never runs.
  assert.equal(rendezvous, 6);
  assert.deepEqual(events, ["deploy dormouse-relay", "relay health", "relay push"]);
});
test("live verification retries the relay and voice while their domains come up, and runs the account's POSTs once", async () => {
  const health = {};
  // Each origin's health fails this many times before it passes.
  const failing = {
    "https://hosted.dormouse.sh": 1,
    "https://relay.dormouse.sh": 5,
    "https://voice.dormouse.sh": 5,
  };
  const fetcher = async (url) => {
    const { origin, pathname } = new URL(url);
    if (pathname === "/api/push/config") {
      assert.equal(origin, "https://relay.dormouse.sh");
      return Response.json({ applicationServerKey: `B${"A".repeat(86)}` });
    }
    assert.equal(pathname, "/api/health");
    health[origin] = (health[origin] ?? 0) + 1;
    return health[origin] > failing[origin]
      ? Response.json({ ok: true, revision: env.BUILD_SHA })
      : Response.json({ ok: false }, { status: 503 });
  };
  let rendezvous = 0;
  await assert.rejects(
    productionSmoke(configs, env.BUILD_SHA, {
      fetcher,
      wait: async () => {},
      oneTime: async () => rendezvous++,
    }),
    // The account's failure alone: the relay and voice passed on their sixth try.
    { message: /^https:\/\/hosted\.dormouse\.sh must be healthy/ },
  );
  assert.deepEqual(health, {
    "https://hosted.dormouse.sh": 1,
    "https://relay.dormouse.sh": 6,
    "https://voice.dormouse.sh": 6,
  });
  assert.equal(rendezvous, 1);
});
test("the history sweep's cron is the voice Worker's, the relay's sweeps its expired rows, and the account's removes its old one", () => {
  assert.deepEqual(configs.voice.triggers, { crons: ["*/5 * * * *"] });
  assert.deepEqual(configs.relay.triggers, { crons: ["0 * * * *"] });
  // An absent `triggers` would leave a deployed schedule in place.
  assert.deepEqual(configs.account.triggers, { crons: [] });
});
test("the Durable Objects are the relay's, each rate limit its Worker's, and Durable Object migrations are append-only", () => {
  assert.deepEqual(configs.relay.durable_objects, {
    bindings: [
      { name: "ONE_TIME_ROOM", class_name: "OneTimeRoom" },
      { name: "RELAY_ROOM", class_name: "RelayRoom" },
    ],
  });
  assert.deepEqual(configs.relay.migrations, [
    { tag: "v1", new_sqlite_classes: ["OneTimeRoom"] },
    { tag: "v2", new_sqlite_classes: ["RelayRoom"] },
  ]);
  // The account reaches the relay's `RelayRoom` by name, implementing nothing.
  assert.deepEqual(configs.account.durable_objects, {
    bindings: [{ name: "RELAY_ROOM", class_name: "RelayRoom", script_name: configs.relay.name }],
  });
  assert.deepEqual(
    configs.relay.ratelimits.map(({ name, namespace_id }) => [name, namespace_id]),
    [
      ["ONE_TIME_MINT_LIMIT", "1"],
      ["ONE_TIME_JOIN_LIMIT", "2"],
      ["RELAY_SIGNIN_LIMIT", "3"],
      ["RELAY_SETUP_LIMIT", "4"],
      ["RELAY_ENROLL_BEGIN_LIMIT", "5"],
      ["RELAY_ENROLL_POLL_LIMIT", "6"],
    ],
  );
  // Approvals are limited per account, on the account.
  assert.deepEqual(
    configs.account.ratelimits.map(({ name, namespace_id }) => [name, namespace_id]),
    [["RELAY_APPROVE_LIMIT", "7"]],
  );
  // The account deployed `v1` with the room, so it keeps that tag unedited and
  // appends the deletion.
  assert.deepEqual(configs.account.migrations, [
    { tag: "v1", new_sqlite_classes: ["OneTimeRoom"] },
    { tag: "v2", deleted_classes: ["OneTimeRoom"] },
  ]);
  assert.equal(configs.voice.durable_objects, undefined);
  assert.equal(configs.voice.ratelimits, undefined);
  assert.equal(configs.voice.migrations, undefined);
});
const relaySecrets = ["RELAY_ENROLL_SECRET", "RELAY_VAPID_PUBLIC_KEY", "RELAY_VAPID_PRIVATE_KEY"];
const accountSecrets = [
  "AUTH_SECRET",
  "POSTMARK_SERVER_TOKEN",
  ...oauthProviders(configs.account).flatMap((name) => [
    `${name.toUpperCase()}_CLIENT_ID`,
    `${name.toUpperCase()}_CLIENT_SECRET`,
  ]),
];
function provider({
  host = "ep-production.neon.tech",
  database = "neondb",
  user = "runtime",
  disabled = true,
  secrets = {
    "dormouse-hosted": accountSecrets,
    "dormouse-relay": relaySecrets,
    "dormouse-voice": ["ELEVENLABS_API_KEY"],
  },
  read = [],
} = {}) {
  return async (path) => {
    if (path.startsWith("hyperdrive/configs/"))
      return {
        result: { origin: { host, database, user }, caching: { disabled } },
      };
    const script = /^workers\/scripts\/([a-z-]+)\/secrets$/.exec(path)?.[1];
    assert.ok(script && script in secrets, `Unexpected ${path}`);
    read.push(script);
    return { result: secrets[script].map((name) => ({ name })) };
  };
}
test("preflight rejects wrong databases, caching, reused roles, and incomplete secrets on each Worker", async () => {
  const read = [];
  await preflight(env, configs, provider({ read }));
  assert.deepEqual(read.sort(), ["dormouse-hosted", "dormouse-relay", "dormouse-voice"]);
  for (const missing of accountSecrets)
    await assert.rejects(
      preflight(
        env,
        configs,
        provider({
          secrets: {
            "dormouse-hosted": accountSecrets.filter((name) => name !== missing),
            "dormouse-relay": relaySecrets,
            "dormouse-voice": ["ELEVENLABS_API_KEY"],
          },
        }),
      ),
      { message: `Missing dormouse-hosted secret: ${missing}` },
    );
  // The key on the account Worker, where it used to live, does not count.
  await assert.rejects(
    preflight(
      env,
      configs,
      provider({
        secrets: {
          "dormouse-hosted": [...accountSecrets, "ELEVENLABS_API_KEY"],
          "dormouse-relay": relaySecrets,
          "dormouse-voice": [],
        },
      }),
    ),
    { message: "Missing dormouse-voice secret: ELEVENLABS_API_KEY" },
  );
  // The relay's secrets, on the account Worker, do not count either.
  for (const missing of relaySecrets)
    await assert.rejects(
      preflight(
        env,
        configs,
        provider({
          secrets: {
            "dormouse-hosted": [...accountSecrets, missing],
            "dormouse-relay": relaySecrets.filter((name) => name !== missing),
            "dormouse-voice": ["ELEVENLABS_API_KEY"],
          },
        }),
      ),
      { message: `Missing dormouse-relay secret: ${missing}` },
    );
  // Each case supplies every configured secret, so it fails on its own check.
  for (const [override, message] of [
    [{ host: "ep-preview.neon.tech" }, "Migration and runtime databases must use the same host"],
    [{ database: "preview" }, "Migration and runtime databases must match"],
    [{ user: "migration" }, "Use separate runtime and migration roles"],
    [{ disabled: false }, "Production Hyperdrive must disable caching"],
  ])
    await assert.rejects(preflight(env, configs, provider(override)), {
      message: new RegExp(`^${message}`),
    });
  const withProviders = (providers) => ({
    ...configs,
    account: {
      ...configs.account,
      vars: { ...configs.account.vars, OAUTH_PROVIDERS: providers },
    },
  });
  const minimal = (extra) =>
    provider({
      secrets: {
        "dormouse-hosted": ["AUTH_SECRET", "POSTMARK_SERVER_TOKEN", ...extra],
        "dormouse-relay": relaySecrets,
        "dormouse-voice": ["ELEVENLABS_API_KEY"],
      },
    });
  await assert.rejects(preflight(env, withProviders("github"), minimal([])));
  await preflight(
    env,
    withProviders("github"),
    minimal(["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]),
  );
  await assert.rejects(preflight(env, withProviders("unknown"), provider()));
});
