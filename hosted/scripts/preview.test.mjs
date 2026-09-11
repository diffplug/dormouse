import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  previewName,
  previewConfig,
  hyperdriveOrigin,
  cloudflare,
  findHyperdrives,
  cleanup,
} from "./preview.mjs";
import { smoke } from "./preview-smoke.mjs";

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

test("preview configuration isolates the origin and excludes production bindings", async () => {
  const base = JSON.parse(
    await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  );
  const config = previewConfig(
    {
      ...base,
      routes: ["production.example/*"],
      vars: { GOOGLE_CLIENT_SECRET: "do-not-copy" },
      d1_databases: [{ production: true }],
    },
    env,
    "c".repeat(32),
  );
  assert.equal(config.name, "dormouse-hosted-pr-42");
  assert.equal(
    config.vars.APP_ORIGIN,
    "https://dormouse-hosted-pr-42.hosted-tests.workers.dev",
  );
  assert.equal(config.workers_dev, true);
  assert.equal(config.main, "../../server/preview-worker.ts");
  assert.equal(config.vars.EMAIL_FROM, undefined);
  assert.equal(config.routes, undefined);
  assert.equal(config.d1_databases, undefined);
  assert.equal(config.vars.GOOGLE_CLIENT_SECRET, undefined);
  assert.equal(config.assets.run_worker_first, true);
  for (const bad of ["0", "-1", "42/../../production", "main", "42\n"])
    assert.throws(() => previewName(bad));
  assert.throws(() =>
    previewConfig(
      base,
      { ...env, CLOUDFLARE_WORKERS_SUBDOMAIN: "example.com" },
      "c".repeat(32),
    ),
  );
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
  let existing = true;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const path = new URL(url).pathname;
    if (options.method === "DELETE") {
      removed.push(path);
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
  assert.deepEqual(
    removed.map((path) => path.split("/").pop()),
    ["dormouse-hosted-pr-42", "ours", "br-ours", "dormouse-hosted-pr-42"],
  );
});

test("deployment smoke fails on a stale revision before making any auth requests", async () => {
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
