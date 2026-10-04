import { withClient } from "pgstencil/postgres";
import { applyRuntimeRoles, RUNTIME_ROLES } from "../runtime-roles";

export type Worker = keyof typeof RUNTIME_ROLES;

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
 * role's), lets each role log in, and answers the URL each Worker's
 * `HYPERDRIVE` binding carries: the account's as the migration role, the
 * relay's and voice's as their own, so every query a suite drives through
 * them must hold its grant.
 */
export async function workerDatabases(url: string): Promise<Record<Worker | "account", string>> {
  await applyRuntimeRoles(url);
  await withClient(url, (client) =>
    client.query(
      Object.values(RUNTIME_ROLES)
        .map((role) => `ALTER ROLE ${role} LOGIN PASSWORD '${password(role)}';`)
        .join("\n"),
    ),
  );
  return { account: url, relay: asWorker(url, "relay"), voice: asWorker(url, "voice") };
}
