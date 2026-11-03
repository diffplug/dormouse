import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_PORT,
  DEV_ENROLL_SECRET,
  LOCAL_HYPERDRIVE_ID,
  devConnectConfig,
  devOrigin,
  devPort,
  devRelayConfig,
  hostedAttachment,
} from "./dev-one-time.mjs";
import { parseConfig } from "./workers.mjs";

const readBase = async (name) =>
  parseConfig(await readFile(new URL(`../${name}`, import.meta.url), "utf8"));
const base = await readBase("wrangler.relay.jsonc");
const connectBase = await readBase("wrangler.connect.jsonc");

test("the relay's dev config runs its entry on loopback, with nothing of production's", () => {
  const config = devRelayConfig(
    {
      ...base,
      vars: { ...base.vars, GOOGLE_CLIENT_SECRET: "do-not-copy" },
      hyperdrive: [{ binding: "HYPERDRIVE", id: "0".repeat(32) }],
      d1_databases: [{ production: true }],
    },
    8787,
    8788,
  );
  assert.equal(config.main, "../../server/relay-worker.ts");
  assert.notEqual(config.name, base.name);
  assert.deepEqual(config.vars, {
    APP_ORIGIN: "http://localhost:8787",
    CONNECT_ORIGIN: "http://localhost:8788",
    RELAY_ENROLL_SECRET: DEV_ENROLL_SECRET,
  });
  for (const key of ["routes", "hyperdrive", "d1_databases", "workers_dev"])
    assert.equal(config[key], undefined, key);
  // Its room is the connect Worker's dev script, never a deployed one.
  assert.deepEqual(config.durable_objects.bindings, [
    { name: "ONE_TIME_ROOM", class_name: "OneTimeRoom", script_name: devConnectConfig(connectBase, 8788).name },
    { name: "RELAY_ROOM", class_name: "RelayRoom" },
  ]);
  assert.deepEqual(config.migrations, base.migrations);
  // The production namespaces: `wrangler dev --local` simulates them in memory.
  assert.deepEqual(config.ratelimits, base.ratelimits);
  assert.deepEqual(config.assets, { ...base.assets, directory: "./relay-assets" });
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(config.compatibility_date, base.compatibility_date);
  assert.deepEqual(config.compatibility_flags, base.compatibility_flags);
});

test("the connect Worker's dev config runs its entry and the room, with nothing of production's", () => {
  const config = devConnectConfig(
    { ...connectBase, vars: { ...connectBase.vars, GOOGLE_CLIENT_SECRET: "do-not-copy" }, d1_databases: [{ production: true }] },
    8788,
  );
  assert.equal(config.main, "../../server/connect-worker.ts");
  assert.notEqual(config.name, connectBase.name);
  assert.deepEqual(config.vars, { APP_ORIGIN: "http://localhost:8788" });
  for (const key of ["routes", "hyperdrive", "d1_databases", "workers_dev"])
    assert.equal(config[key], undefined, key);
  assert.deepEqual(config.durable_objects, connectBase.durable_objects);
  assert.deepEqual(config.migrations, connectBase.migrations);
  assert.deepEqual(config.ratelimits, connectBase.ratelimits);
  assert.deepEqual(config.assets, { ...connectBase.assets, directory: "./connect-assets" });
});

test("the origin is loopback HTTP on the chosen port, which PORT names", () => {
  assert.equal(devPort({}), DEFAULT_PORT);
  assert.equal(devPort({ PORT: "" }), DEFAULT_PORT);
  assert.equal(devPort({ PORT: "9000" }), 9000);
  // 65535 leaves no port for the connect Worker.
  for (const bad of ["0", "65535", "65536", "80a", "-1", "1e3", " 80"])
    assert.throws(() => devPort({ PORT: bad }), /TCP port/, bad);
  assert.equal(devOrigin(9000), "http://localhost:9000");
  assert.equal(devRelayConfig(base, 9000, 9001).vars.APP_ORIGIN, "http://localhost:9000");
});

test("it attaches to the Hosted dev loop with both its account origin and its database, or neither", () => {
  assert.equal(hostedAttachment({}), null);
  assert.equal(hostedAttachment({ HOSTED_DEV_ACCOUNT_ORIGIN: "", HOSTED_DEV_DATABASE_URL: "" }), null);
  for (const half of [
    { HOSTED_DEV_ACCOUNT_ORIGIN: "http://localhost:5000" },
    { HOSTED_DEV_DATABASE_URL: "postgres://x" },
    { HOSTED_DEV_ACCOUNT_ORIGIN: "http://localhost:5000", HOSTED_DEV_DATABASE_URL: "" },
  ])
    assert.throws(() => hostedAttachment(half), /set together/, JSON.stringify(half));
  assert.deepEqual(
    hostedAttachment({ HOSTED_DEV_ACCOUNT_ORIGIN: "http://localhost:5000", HOSTED_DEV_DATABASE_URL: "postgres://x" }),
    { accountOrigin: "http://localhost:5000", databaseUrl: "postgres://x" },
  );
});

test("attached, it approves at that account origin and reads its database, never production's", () => {
  const config = devRelayConfig(
    { ...base, hyperdrive: [{ binding: "HYPERDRIVE", id: "0".repeat(32) }] },
    8787,
    8788,
    { accountOrigin: "http://localhost:5000", databaseUrl: "postgresql://dev@localhost:5432/dev" },
  );
  assert.deepEqual(config.vars, {
    APP_ORIGIN: "http://localhost:8787",
    CONNECT_ORIGIN: "http://localhost:8788",
    RELAY_ENROLL_SECRET: DEV_ENROLL_SECRET,
    ACCOUNT_ORIGIN: "http://localhost:5000",
  });
  assert.deepEqual(config.hyperdrive, [
    { binding: "HYPERDRIVE", id: LOCAL_HYPERDRIVE_ID, localConnectionString: "postgresql://dev@localhost:5432/dev" },
  ]);
});
