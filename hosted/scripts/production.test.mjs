import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { productionConfig, preflight } from "./production.mjs";
const base = JSON.parse(
  await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
const env = {
  BUILD_SHA: "a".repeat(40),
  HYPERDRIVE_ID: "b".repeat(32),
  CLOUDFLARE_ACCOUNT_ID: "c".repeat(32),
  DATABASE_URL: "postgres://migration:synthetic@ep-production.neon.tech/neondb",
};
const config = productionConfig(base, env);
test("production config keeps canonical domain and production entry, excludes public aliases", () => {
  assert.equal(config.main, "../../server/worker.ts");
  assert.equal(config.vars.APP_ORIGIN, "https://hosted.dormouse.sh");
  assert.equal(config.vars.BUILD_SHA, env.BUILD_SHA);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.hyperdrive[0].id, env.HYPERDRIVE_ID);
  assert.throws(() =>
    productionConfig(base, { ...env, HYPERDRIVE_ID: "0".repeat(32) }),
  );
  assert.throws(() => productionConfig(base, { ...env, BUILD_SHA: "main" }));
  assert.throws(() => productionConfig({ ...base, workers_dev: true }, env));
});
function provider({
  host = "ep-production.neon.tech",
  database = "neondb",
  user = "runtime",
  disabled = true,
  secrets = ["AUTH_SECRET", "POSTMARK_SERVER_TOKEN"],
} = {}) {
  return async (path) => {
    if (path.startsWith("hyperdrive/configs/"))
      return {
        result: { origin: { host, database, user }, caching: { disabled } },
      };
    assert.equal(path, "workers/scripts/dormouse-hosted/secrets");
    return { result: secrets.map((name) => ({ name })) };
  };
}
test("preflight rejects wrong databases, caching, reused roles, and incomplete provider secrets", async () => {
  await preflight(env, config, provider());
  for (const override of [
    { host: "ep-preview.neon.tech" },
    { database: "preview" },
    { user: "migration" },
    { disabled: false },
    { secrets: ["AUTH_SECRET"] },
  ])
    await assert.rejects(preflight(env, config, provider(override)));
  const oauth = {
    ...config,
    vars: { ...config.vars, OAUTH_PROVIDERS: "github" },
  };
  await assert.rejects(preflight(env, oauth, provider()));
  await preflight(
    env,
    oauth,
    provider({
      secrets: [
        "AUTH_SECRET",
        "POSTMARK_SERVER_TOKEN",
        "GITHUB_CLIENT_ID",
        "GITHUB_CLIENT_SECRET",
      ],
    }),
  );
  await assert.rejects(
    preflight(
      env,
      { ...config, vars: { ...config.vars, OAUTH_PROVIDERS: "unknown" } },
      provider(),
    ),
  );
});
