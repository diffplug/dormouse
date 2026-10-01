import test from "node:test";
import assert from "node:assert/strict";
import {
  productionConfig,
  productionConfigs,
  preflight,
} from "./production.mjs";
import { readConfigs } from "./preview.mjs";
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
  // Each config is its own Worker's: none stands in for a sibling.
  assert.throws(() => productionConfig(bases.relay, env, "account"));
  assert.throws(() => productionConfig(bases.account, env, "voice"));
  // The account and voice share the production database; the relay reaches none.
  assert.deepEqual(configs.account.hyperdrive, [{ binding: "HYPERDRIVE", id: env.HYPERDRIVE_ID }]);
  assert.deepEqual(configs.voice.hyperdrive, configs.account.hyperdrive);
  assert.equal(configs.relay.hyperdrive, undefined);
  assert.equal(configs.account.assets.directory, "../../dist");
  assert.equal(configs.relay.assets.directory, "../../dist-relay");
  assert.equal(configs.voice.assets, undefined);
  assert.throws(() =>
    productionConfig(bases.account, { ...env, HYPERDRIVE_ID: "0".repeat(32) }),
  );
  assert.throws(() =>
    productionConfig(bases.voice, { ...env, HYPERDRIVE_ID: "0".repeat(32) }, "voice"),
  );
  assert.throws(() => productionConfig(bases.account, { ...env, BUILD_SHA: "main" }));
});
test("the history sweep's cron is the voice Worker's alone, and the account's removes its old one", () => {
  assert.deepEqual(configs.voice.triggers, { crons: ["*/5 * * * *"] });
  // An absent `triggers` would leave a deployed schedule in place.
  assert.deepEqual(configs.account.triggers, { crons: [] });
  assert.equal(configs.relay.triggers, undefined);
});
test("the rendezvous Durable Object and its rate limits are the relay's, and Durable Object migrations are append-only", () => {
  assert.deepEqual(configs.relay.durable_objects, {
    bindings: [{ name: "ONE_TIME_ROOM", class_name: "OneTimeRoom" }],
  });
  assert.deepEqual(configs.relay.migrations, [
    { tag: "v1", new_sqlite_classes: ["OneTimeRoom"] },
  ]);
  assert.deepEqual(
    configs.relay.ratelimits.map(({ name, namespace_id }) => [name, namespace_id]),
    [
      ["ONE_TIME_MINT_LIMIT", "1"],
      ["ONE_TIME_JOIN_LIMIT", "2"],
    ],
  );
  // The account deployed `v1` with the room, so it keeps that tag unedited and
  // appends the deletion.
  assert.deepEqual(configs.account.migrations, [
    { tag: "v1", new_sqlite_classes: ["OneTimeRoom"] },
    { tag: "v2", deleted_classes: ["OneTimeRoom"] },
  ]);
  for (const worker of ["account", "voice"]) {
    assert.equal(configs[worker].durable_objects, undefined, worker);
    assert.equal(configs[worker].ratelimits, undefined, worker);
  }
  assert.equal(configs.voice.migrations, undefined);
});
const accountSecrets = [
  "AUTH_SECRET",
  "POSTMARK_SERVER_TOKEN",
  ...configs.account.vars.OAUTH_PROVIDERS.split(",").filter(Boolean).flatMap((name) => [
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
  // The relay holds no secret, so nothing is asked of it.
  assert.deepEqual(read, ["dormouse-hosted", "dormouse-voice"]);
  for (const missing of accountSecrets)
    await assert.rejects(
      preflight(
        env,
        configs,
        provider({
          secrets: {
            "dormouse-hosted": accountSecrets.filter((name) => name !== missing),
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
          "dormouse-voice": [],
        },
      }),
    ),
    { message: "Missing dormouse-voice secret: ELEVENLABS_API_KEY" },
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
