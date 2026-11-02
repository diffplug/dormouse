import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabaseRun } from "./test-databases.mjs";

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dormouse-db-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const config = { directory, run: async (...args) => { calls.push(args); }, ...options };
  return { directory, calls, create: (overrides = {}) => createTestDatabaseRun({ ...config, ...overrides }) };
}
const missing = (path) => assert.rejects(access(path), { code: "ENOENT" });

test("concurrent runs have independent roots and cleanup agrees with installed pgstencil's identity", async (t) => {
  const f = await fixture(t);
  const a = await f.create();
  const b = await f.create();
  assert.notEqual(a.root, b.root);
  // Test the package contract rather than restating its hash implementation.
  const project = execFileSync(process.execPath, ["--input-type=module", "-e", "import { projectName } from 'pgstencil/database'; process.stdout.write(projectName)"], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, PGSTENCIL_PROJECT_ROOT: a.root }, encoding: "utf8",
  });
  await mkdir(join(a.root, ".pgstencil"));
  await a.close();
  assert.deepEqual(f.calls[0], ["docker", ["compose", "-f", join(a.root, "compose.yaml"), "-p", project, "down", "--volumes", "--remove-orphans"], { timeout: 120_000 }]);
  await missing(a.root);
  await access(b.root);
  await b.close();
});

test("runs that never allocate a database need no Docker, and teardown is idempotent", async (t) => {
  const f = await fixture(t);
  const run = await f.create();
  await run.close();
  await run.close();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await readdir(f.directory), []);
});

test("failed startup is cleaned even without services.json", async (t) => {
  const f = await fixture(t);
  const run = await f.create();
  await mkdir(join(run.root, ".pgstencil"));
  await run.close();
  assert.equal(f.calls.length, 1);
  await missing(run.root);
});

test("a later invocation reaps dead runners but preserves live runners and unrelated directories", async (t) => {
  const f = await fixture(t, { isAlive: (pid) => pid !== 12345 });
  const dead = await f.create({ pid: 12345 });
  await mkdir(join(dead.root, ".pgstencil"));
  const unrelated = join(f.directory, "pgstencil-development");
  await mkdir(unrelated);
  const live = await f.create();
  await missing(dead.root);
  const next = await f.create();
  await access(live.root);
  await access(unrelated);
  assert.equal(f.calls.length, 1);
  await live.close();
  await next.close();
});

test("cleanup failure is visible and keeps the Compose file for retry after the worktree disappears", async (t) => {
  const f = await fixture(t);
  const run = await f.create({ run: async () => { throw new Error("Docker unavailable"); } });
  await mkdir(join(run.root, ".pgstencil"));
  await assert.rejects(run.close(), /Docker unavailable/);
  assert.match(await readFile(join(run.root, "compose.yaml"), "utf8"), /postgres-18-data/);
  const retry = await f.create({ isAlive: () => false });
  await missing(run.root);
  assert.equal(f.calls.length, 1);
  await retry.close();
});

test("an unsuccessful stale cleanup warns, retains its record, and allows a new run", async (t) => {
  const f = await fixture(t);
  const stale = await f.create();
  await mkdir(join(stale.root, ".pgstencil"));
  const warnings = [];
  const next = await f.create({ isAlive: () => false, run: async () => { throw new Error("offline"); }, warn: (message) => warnings.push(message) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /offline/);
  await access(stale.root);
  await next.close();
});

test("a real runner survives another invocation, then its SIGKILL leftovers are recovered", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createTestDatabaseRun } from ${JSON.stringify(new URL("./test-databases.mjs", import.meta.url).href)};
    import { mkdir } from "node:fs/promises";
    import { join } from "node:path";
    const run = await createTestDatabaseRun({ directory: process.argv[1] });
    await mkdir(join(run.root, ".pgstencil"));
    process.send(run.root);
    setInterval(() => {}, 1000);
  `, f.directory], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const exited = once(child, "exit");
  t.after(async () => { child.kill("SIGKILL"); await exited; });
  const [root] = await once(child, "message");
  const concurrent = await f.create();
  await access(root);
  assert.deepEqual(f.calls, []);
  child.kill("SIGKILL");
  await exited;
  const next = await f.create();
  await missing(root);
  assert.equal(f.calls.length, 1);
  await concurrent.close();
  await next.close();
});
