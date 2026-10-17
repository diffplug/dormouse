import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_PORT,
  DEV_ENROLL_SECRET,
  LOCAL_HYPERDRIVE_ID,
  devConfig,
  devOrigin,
  devPort,
  hostedAttachment,
} from "./dev-one-time.mjs";
import { parseConfig } from "./workers.mjs";

const base = parseConfig(
  await readFile(new URL("../wrangler.relay.jsonc", import.meta.url), "utf8"),
);

test("the dev config runs the relay entry on loopback, with the rendezvous and nothing of production's", () => {
  const config = devConfig(
    {
      ...base,
      vars: { ...base.vars, GOOGLE_CLIENT_SECRET: "do-not-copy" },
      hyperdrive: [{ binding: "HYPERDRIVE", id: "0".repeat(32) }],
      d1_databases: [{ production: true }],
    },
    8787,
  );
  assert.equal(config.main, "../../server/relay-worker.ts");
  assert.notEqual(config.name, base.name);
  assert.deepEqual(config.vars, {
    APP_ORIGIN: "http://localhost:8787",
    RELAY_ENROLL_SECRET: DEV_ENROLL_SECRET,
  });
  for (const key of ["routes", "hyperdrive", "d1_databases", "workers_dev"])
    assert.equal(config[key], undefined, key);
  assert.deepEqual(config.durable_objects, base.durable_objects);
  assert.deepEqual(config.migrations, base.migrations);
  // The production namespaces: `wrangler dev --local` simulates them in memory.
  assert.deepEqual(config.ratelimits, base.ratelimits);
  assert.deepEqual(config.assets, { ...base.assets, directory: "./assets" });
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(config.compatibility_date, base.compatibility_date);
  assert.deepEqual(config.compatibility_flags, base.compatibility_flags);
});

test("the origin is loopback HTTP on the chosen port, which PORT names", () => {
  assert.equal(devPort({}), DEFAULT_PORT);
  assert.equal(devPort({ PORT: "" }), DEFAULT_PORT);
  assert.equal(devPort({ PORT: "9000" }), 9000);
  for (const bad of ["0", "65536", "80a", "-1", "1e3", " 80"])
    assert.throws(() => devPort({ PORT: bad }), /TCP port/, bad);
  assert.equal(devOrigin(9000), "http://localhost:9000");
  assert.equal(devConfig(base, 9000).vars.APP_ORIGIN, "http://localhost:9000");
});

test("attached to the Hosted dev loop, it approves at that account and reads its database, never production's", () => {
  assert.equal(hostedAttachment({}), null);
  assert.equal(hostedAttachment({ HOSTED_DEV_ACCOUNT_ORIGIN: "", HOSTED_DEV_DATABASE_URL: "" }), null);
  for (const half of [{ HOSTED_DEV_ACCOUNT_ORIGIN: "http://localhost:5000" }, { HOSTED_DEV_DATABASE_URL: "postgres://x" }])
    assert.throws(() => hostedAttachment(half), /set together/);
  const hosted = hostedAttachment({
    HOSTED_DEV_ACCOUNT_ORIGIN: "http://localhost:5000",
    HOSTED_DEV_DATABASE_URL: "postgresql://dev@localhost:5432/pgstencil_dev",
  });
  const config = devConfig({ ...base, hyperdrive: [{ binding: "HYPERDRIVE", id: "0".repeat(32) }] }, 8787, hosted);
  assert.deepEqual(config.vars, {
    APP_ORIGIN: "http://localhost:8787",
    RELAY_ENROLL_SECRET: DEV_ENROLL_SECRET,
    ACCOUNT_ORIGIN: "http://localhost:5000",
  });
  assert.deepEqual(config.hyperdrive, [
    {
      binding: "HYPERDRIVE",
      id: LOCAL_HYPERDRIVE_ID,
      localConnectionString: "postgresql://dev@localhost:5432/pgstencil_dev",
    },
  ]);
});
