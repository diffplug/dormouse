import { queryDatabase } from "pgstencil/postgres";
import { applyRuntimeRoles } from "../runtime-roles";

/** The restricted Postgres role of each Worker `runtime-roles.sql` provisions; the account Worker has none. */
export const RUNTIME_ROLES = {
  relay: "dormouse_relay",
  voice: "dormouse_voice",
} as const;

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
 * them must hold its grant. Each role is first reset to no attribute or
 * membership, so a run killed mid-test leaves nothing the next one inherits.
 */
export async function workerDatabases(url: string): Promise<Record<Worker | "account", string>> {
  const roles = Object.values(RUNTIME_ROLES);
  await queryDatabase(
    url,
    `DO $$
    DECLARE grant_row record;
    BEGIN
      FOR grant_row IN
        SELECT g.rolname AS granted, m.rolname AS member FROM pg_auth_members a
        JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
        WHERE m.rolname IN (${roles.map((role) => `'${role}'`).join(", ")})
      LOOP
        EXECUTE format('REVOKE %I FROM %I', grant_row.granted, grant_row.member);
      END LOOP;
      ${roles
        .map(
          (role) => `IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
        ALTER ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      END IF;`,
        )
        .join("\n      ")}
    END $$`,
  );
  await applyRuntimeRoles(url);
  await queryDatabase(
    url,
    `DO $$ BEGIN
      ${roles.map((role) => `ALTER ROLE ${role} LOGIN PASSWORD '${password(role)}';`).join("\n      ")}
    END $$`,
  );
  return { account: url, relay: asWorker(url, "relay"), voice: asWorker(url, "voice") };
}
