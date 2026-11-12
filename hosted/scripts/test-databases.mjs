// Hosted's Vitest global setup: one pgstencil root per invocation, shared by
// its workers and child processes. Teardown removes that run's containers,
// network, and volumes, after failures too (watch mode: when the watcher
// exits), and never touches a development stack or another live run.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { composeFile } from "pgstencil/database";

const exec = promisify(execFile);
// Survive removal of a worktree or the OS temporary directory. Completed runs
// remove their entry; a later invocation reaps entries whose runner died.
const registry = join(homedir(), ".cache", "dormouse", "test-databases-v1");
const exists = async (path) => access(path).then(() => true, (error) => {
  if (error.code === "ENOENT") return false;
  throw error;
});
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission errors are not proof that another runner has exited.
    return error.code !== "ESRCH";
  }
}

/** One pgstencil root per Vitest invocation, shared by that invocation's workers. */
export async function createTestDatabaseRun({
  directory = registry,
  pid = process.pid,
  isAlive = alive,
  run = exec,
  warn = console.warn,
} = {}) {
  await mkdir(directory, { recursive: true });
  async function cleanup(root) {
    // pgstencil creates this directory before starting Docker, including when
    // startup fails before services.json is written. DOM-only runs never do.
    if (await exists(join(root, ".pgstencil"))) {
      // pgstencil/database's projectName contract: SHA256 of the absolute root.
      const project = `pgstencil-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
      try {
        await run("docker", ["compose", "-f", join(root, "compose.yaml"), "-p", project, "down", "--volumes", "--remove-orphans"], { timeout: 120_000 });
      } catch (error) {
        // Concurrent invocations can both reap the same dead runner. Only
        // suppress an error if the other reaper already finished removing it.
        if (await exists(root)) throw error;
      }
    }
    await rm(root, { recursive: true, force: true });
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const owner = /^run-([1-9][0-9]*)-[a-zA-Z0-9]{6}$/.exec(entry.name);
    if (!entry.isDirectory() || !owner || isAlive(Number(owner[1]))) continue;
    const root = join(directory, entry.name);
    try {
      await cleanup(root);
    } catch (error) {
      // Keep the record and copied Compose file so the next run can retry.
      warn(`Could not clean interrupted test databases at ${root}: ${error.message}`);
    }
  }
  const root = await mkdtemp(join(directory, `run-${pid}-`));
  try {
    // A stale run must remain removable after its worktree/dependencies vanish.
    await copyFile(composeFile, join(root, "compose.yaml"));
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return { root, close: () => cleanup(root) };
}

/** @param {import("vitest/node").TestProject} project */
export default async function setup(project) {
  const run = await createTestDatabaseRun();
  project.provide("pgstencilRoot", run.root);
  return run.close;
}
