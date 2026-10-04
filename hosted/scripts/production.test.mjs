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
  RELAY_HYPERDRIVE_ID: "d".repeat(32),
  VOICE_HYPERDRIVE_ID: "e".repeat(32),
  CLOUDFLARE_ACCOUNT_ID: "c".repeat(32),
  DATABASE_URL: "postgres://migration:synthetic@ep-production.neon.tech/neondb",
};
const configs = productionConfigs(bases, env);
/** An `assert` failure's message: ours, then Node's diff. */
const failure = (message) => ({ message: new RegExp(`^${RegExp.escape(message)}(\\n|$)`) });
/** Each Worker's Hyperdrive variable and the role it must connect as. */
const HYPERDRIVES = {
  account: ["HYPERDRIVE_ID", "dormouse_app"],
  relay: ["RELAY_HYPERDRIVE_ID", "dormouse_relay"],
  voice: ["VOICE_HYPERDRIVE_ID", "dormouse_voice"],
};
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
  // Each on its own Hyperdrive, whatever the checked-in config names.
  assert.deepEqual(configs.account.hyperdrive, [{ binding: "HYPERDRIVE", id: env.HYPERDRIVE_ID }]);
  assert.deepEqual(configs.relay.hyperdrive, [{ binding: "HYPERDRIVE", id: env.RELAY_HYPERDRIVE_ID }]);
  assert.deepEqual(configs.voice.hyperdrive, [{ binding: "HYPERDRIVE", id: env.VOICE_HYPERDRIVE_ID }]);
  assert.equal(configs.account.assets.directory, "../../dist/account");
  assert.equal(configs.relay.assets.directory, "../../dist/relay");
  assert.equal(configs.voice.assets, undefined);
  for (const [worker, [variable]] of Object.entries(HYPERDRIVES)) {
    assert.throws(
      () => productionConfig(bases[worker], { ...env, [variable]: "0".repeat(32) }, worker),
      failure(`Provision production Hyperdrive first: ${variable}`),
    );
    assert.throws(() => productionConfig(bases[worker], { ...env, [variable]: undefined }, worker), {
      message: `Missing ${variable}; see hosted/README.md -> Deployment credentials in GitHub`,
    });
  }
  // No two Workers share a Hyperdrive.
  for (const [a, b] of [
    ["HYPERDRIVE_ID", "RELAY_HYPERDRIVE_ID"],
    ["HYPERDRIVE_ID", "VOICE_HYPERDRIVE_ID"],
    ["RELAY_HYPERDRIVE_ID", "VOICE_HYPERDRIVE_ID"],
  ])
    assert.throws(
      () => productionConfigs(bases, { ...env, [b]: env[a] }),
      failure("HYPERDRIVE_ID, RELAY_HYPERDRIVE_ID, VOICE_HYPERDRIVE_ID must name three different Hyperdrives"),
    );
  assert.throws(() =>
    productionConfig(bases.account, { ...env, BUILD_SHA: "main" }, "account"),
  );
  assert.throws(() => productionConfig(bases.account, env));
});
test("the release's deploy job hands every step each Worker's Hyperdrive variable", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/hosted-production.yml", import.meta.url),
    "utf8",
  );
  // The job's own `env`, which every step inherits.
  const start = workflow.indexOf("\n  deploy:");
  const deploy = workflow.slice(start, workflow.indexOf("    steps:", start));
  assert.match(deploy, /\n    env:\n/);
  for (const [variable] of Object.values(HYPERDRIVES))
    assert.ok(deploy.includes(`\n      ${variable}: \${{ vars.${variable} }}\n`), variable);
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
  // The relay's readiness, as a role missing a grant answers it.
  let ready = 200;
  const fetcher = async (url) => {
    if (url === "https://relay.dormouse.sh/api/push/config") {
      events.push("relay push");
      return Response.json({ applicationServerKey: "B" + "A".repeat(86) });
    }
    if (url === "https://relay.dormouse.sh/api/ready") {
      events.push("relay ready");
      return Response.json({ ok: ready === 200 }, { status: ready });
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
    "relay ready",
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
  assert.deepEqual(events, ["deploy dormouse-relay", "relay health", "relay ready", "relay push"]);
  // A relay whose role lacks a grant stops the release before anything else deploys.
  events.length = 0;
  ready = 503;
  await assert.rejects(
    deploy(async () => events.push("relay one-time")),
    failure("https://relay.dormouse.sh must reach Postgres through its Hyperdrive"),
  );
  assert.deepEqual(events, ["deploy dormouse-relay", "relay health", ...Array(6).fill("relay ready")]);
});
test("live verification retries the relay and voice while their domains come up, and runs the account's POSTs once", async () => {
  const health = {};
  // Each origin's health fails this many times before it passes.
  const failing = {
    "https://hosted.dormouse.sh": 1,
    "https://relay.dormouse.sh": 5,
    "https://voice.dormouse.sh": 5,
  };
  const ready = [];
  const fetcher = async (url) => {
    const { origin, pathname } = new URL(url);
    if (pathname === "/api/push/config") {
      assert.equal(origin, "https://relay.dormouse.sh");
      return Response.json({ applicationServerKey: `B${"A".repeat(86)}` });
    }
    if (pathname === "/api/ready") {
      ready.push(origin);
      return Response.json({ ok: true });
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
  // Each passed its revision, then its readiness once.
  assert.deepEqual(ready.sort(), ["https://relay.dormouse.sh", "https://voice.dormouse.sh"]);
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
/** Each Worker's Hyperdrive as Cloudflare answers it, by ID, correctly provisioned. */
const provisioned = () =>
  Object.fromEntries(
    Object.values(HYPERDRIVES).map(([variable, user]) => [
      env[variable],
      {
        origin: { host: "ep-production.neon.tech", port: 5432, database: "neondb", user },
        caching: { disabled: true },
      },
    ]),
  );
function provider({
  hyperdrives = provisioned(),
  secrets = {
    "dormouse-hosted": accountSecrets,
    "dormouse-relay": relaySecrets,
    "dormouse-voice": ["ELEVENLABS_API_KEY"],
  },
  read = [],
} = {}) {
  return async (path) => {
    const id = /^hyperdrive\/configs\/([a-f0-9]{32})$/.exec(path)?.[1];
    if (id) {
      assert.ok(id in hyperdrives, `Unexpected ${path}`);
      read.push(id);
      return { result: hyperdrives[id] };
    }
    const script = /^workers\/scripts\/([a-z-]+)\/secrets$/.exec(path)?.[1];
    assert.ok(script && script in secrets, `Unexpected ${path}`);
    read.push(script);
    return { result: secrets[script].map((name) => ({ name })) };
  };
}
test("preflight rejects wrong databases, caching, reused roles, and incomplete secrets on each Worker", async () => {
  const read = [];
  await preflight(env, configs, provider({ read }));
  assert.deepEqual(
    read.sort(),
    [
      env.HYPERDRIVE_ID,
      env.RELAY_HYPERDRIVE_ID,
      env.VOICE_HYPERDRIVE_ID,
      "dormouse-hosted",
      "dormouse-relay",
      "dormouse-voice",
    ].sort(),
  );
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
  // Each case breaks one Worker's Hyperdrive and supplies every configured
  // secret, so it fails on its own check.
  for (const [worker, [variable, user]] of Object.entries(HYPERDRIVES)) {
    const name = `${configs[worker].name}'s Hyperdrive`;
    const broken = (change) => {
      const hyperdrives = provisioned();
      change(hyperdrives[env[variable]]);
      return provider({ hyperdrives });
    };
    for (const [change, message] of [
      [(h) => (h.origin.host = "ep-preview.neon.tech"), `${name} must use the migration database's host`],
      [(h) => (h.origin.port = 6543), `${name} must use the migration database's port`],
      [(h) => (h.origin.database = "preview"), `${name} must use the migration database`],
      [(h) => (h.origin.user = "migration"), `${name} must not connect as the migration role`],
      [(h) => (h.caching.disabled = false), `${name} must disable caching`],
      [(h) => delete h.caching, `${name} must disable caching`],
      // The owner role, or a sibling's, is not this Worker's.
      ...["neondb_owner", ...Object.values(HYPERDRIVES).map(([, role]) => role).filter((role) => role !== user)].map(
        (other) => [(h) => (h.origin.user = other), `${name} must connect as ${user}`],
      ),
    ])
      await assert.rejects(preflight(env, configs, broken(change)), failure(message));
  }
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
