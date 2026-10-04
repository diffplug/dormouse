import { withClient } from "pgstencil/postgres";
import { applyRuntimeRoles, RUNTIME_ROLES } from "../runtime-roles";

type Worker = keyof typeof RUNTIME_ROLES;

/** Roles are cluster-wide: these exist only in pgstencil's local test container. */
const password = (role: string) => `${role}-local-only`;

/** The test database at `url`, connected as `worker`'s restricted role. */
function asWorker(url: string, worker: Worker) {
  const role = RUNTIME_ROLES[worker];
  const restricted = new URL(url);
  restricted.username = role;
  restricted.password = password(role);
  return restricted.href;
}

/**
 * Applies `runtime-roles.sql` to the test database at `url` (the migration
 * role's), lets each role log in, and answers each Worker's URL as its role:
 * what its `HYPERDRIVE` binding carries, so every query a suite drives must
 * hold its grant.
 */
export async function workerDatabases(url: string): Promise<Record<Worker, string>> {
  await applyRuntimeRoles(url);
  await withClient(url, async (client) => {
    for (const role of Object.values(RUNTIME_ROLES))
      await client.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password(role)}'`);
  });
  return { relay: asWorker(url, "relay"), voice: asWorker(url, "voice") };
}
