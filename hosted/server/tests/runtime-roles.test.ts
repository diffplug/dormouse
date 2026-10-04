import { test, expect, beforeAll, afterAll } from "vitest";
import { createTestContext } from "pgstencil/testing";
import { queryDatabase, withClient } from "pgstencil/postgres";
import { migrations } from "../migrations";
import { applyRuntimeRoles, RUNTIME_ROLES } from "../runtime-roles";
import { workerDatabases } from "./worker-roles";

// `hosted/server/runtime-roles.sql` in real Postgres: what each restricted role
// may touch, exactly. The relay and voice suites run their Workers on these
// roles, so they prove every query holds its grant; this file proves nothing
// else does.

let context: Awaited<ReturnType<typeof createTestContext>>;
let databases: Awaited<ReturnType<typeof workerDatabases>>;

beforeAll(async () => {
  context = await createTestContext({ migrations });
  databases = await workerDatabases(context.database.url);
});
afterAll(async () => {
  await context?.close();
});

/**
 * Every privilege `role` holds on a relation outside the system schemas, its
 * memberships and PUBLIC's included: `table: PRIVS` for table-wide ones, and
 * `table.column: PRIVS` for those it holds on a column alone.
 */
async function privileges(role: string) {
  const rows = await queryDatabase<{ entry: string }>(
    context.database.url,
    `WITH relations AS (
      SELECT c.oid, c.relname, c.relkind FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    ), held AS (
      SELECT r.relname AS entry, p.privilege FROM relations r
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) AS p(privilege)
      WHERE r.relkind <> 'S' AND has_table_privilege($1, r.oid, p.privilege)
      UNION ALL
      SELECT r.relname, p.privilege FROM relations r
      CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p(privilege)
      WHERE r.relkind = 'S' AND has_sequence_privilege($1, r.oid, p.privilege)
      UNION ALL
      SELECT r.relname || '.' || a.attname, p.privilege FROM relations r
      JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(privilege)
      WHERE r.relkind <> 'S' AND has_column_privilege($1, r.oid, a.attnum, p.privilege)
        AND NOT has_table_privilege($1, r.oid, p.privilege)
      UNION ALL
      SELECT 'schema ' || n.nspname, p.privilege FROM pg_namespace n
      CROSS JOIN unnest(ARRAY['USAGE', 'CREATE']) AS p(privilege)
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_%'
        AND has_schema_privilege($1, n.oid, p.privilege)
    )
    SELECT entry || ': ' || string_agg(privilege, ', ' ORDER BY privilege) AS entry
    FROM held GROUP BY entry ORDER BY entry`,
    [role],
  );
  return rows.map((row) => row.entry);
}

test("each Worker's role holds exactly its grants, and nothing on any other table", async () => {
  expect(await privileges(RUNTIME_ROLES.relay)).toEqual([
    "dormouse_relay_burrows.enrolledAt: UPDATE",
    "dormouse_relay_burrows: INSERT, SELECT",
    "dormouse_relay_challenges: DELETE, INSERT, SELECT",
    "dormouse_relay_enrollment_approvals.redeemedAt: UPDATE",
    "dormouse_relay_enrollment_approvals.redeemedBurrowId: UPDATE",
    "dormouse_relay_enrollment_approvals: DELETE, SELECT",
    "dormouse_relay_passkeys: INSERT, SELECT",
    "dormouse_relay_presence_nonces: DELETE, INSERT, SELECT",
    "dormouse_relay_push_subscriptions.auth: UPDATE",
    "dormouse_relay_push_subscriptions.endpoint: UPDATE",
    "dormouse_relay_push_subscriptions.p256dh: UPDATE",
    "dormouse_relay_push_subscriptions.subscribedAt: UPDATE",
    "dormouse_relay_push_subscriptions.vapidPublicKey: UPDATE",
    "dormouse_relay_push_subscriptions: DELETE, INSERT, SELECT",
    "dormouse_relay_sessions: DELETE, INSERT, SELECT",
    "dormouse_relay_setup_tokens: DELETE, INSERT, SELECT",
    "schema public: USAGE",
    "user.email: SELECT",
    "user.emailVerified: SELECT",
    "user.id: SELECT",
  ]);
  expect(await privileges(RUNTIME_ROLES.voice)).toEqual([
    "dormouse_voice_tokens.hash: SELECT",
    "dormouse_voice_tokens.id: SELECT",
    "dormouse_voice_tokens.lastUsedAt: UPDATE",
    "dormouse_voice_tokens.revokedAt: SELECT",
    "dormouse_voice_tokens.userId: SELECT",
    "dormouse_voice_usage.count: UPDATE",
    "dormouse_voice_usage: INSERT, SELECT",
    "schema public: USAGE",
    "user.email: SELECT",
    "user.emailVerified: SELECT",
    "user.id: SELECT",
  ]);
});

/** The SQLSTATE `text` fails with as `worker`'s role, or "ok". */
const outcome = (worker: "relay" | "voice", text: string) =>
  withClient(databases[worker], (db) => db.query(text)).then(
    () => "ok",
    (error: { code?: string }) => error.code,
  );

test("the relay's role is refused the account's tables, the user row's other columns and writes, voice, and Burrow removal", async () => {
  // It does log in, and reads what the entitlement check reads.
  expect(await outcome("relay", `SELECT id, email, "emailVerified" FROM "user"`)).toBe("ok");
  for (const text of [
    `SELECT * FROM "session"`,
    `SELECT * FROM account`,
    `SELECT name FROM "user"`,
    `UPDATE "user" SET email = email`,
    `UPDATE "user" SET "emailVerified" = true`,
    `SELECT id FROM dormouse_voice_tokens`,
    `INSERT INTO dormouse_voice_usage ("userId", day, count) VALUES ('x', now()::date, 0)`,
    `DELETE FROM dormouse_relay_burrows`,
    `UPDATE dormouse_relay_burrows SET "userId" = "userId"`,
    `INSERT INTO dormouse_relay_enrollment_approvals ("userCode", "userId", "expiresAt") VALUES ('x', 'x', now())`,
    `CREATE TABLE dormouse_relay_extra (id int)`,
  ])
    expect([text, await outcome("relay", text)]).toEqual([text, "42501"]);
});

test("the voice role is refused the relay's tables, the account's, and its tokens' other columns and writes", async () => {
  expect(
    await outcome("voice", `SELECT id, "userId", hash, "revokedAt" FROM dormouse_voice_tokens`),
  ).toBe("ok");
  for (const text of [
    `SELECT * FROM dormouse_relay_sessions`,
    `SELECT * FROM dormouse_relay_burrows`,
    `SELECT * FROM "session"`,
    `SELECT name FROM "user"`,
    `UPDATE "user" SET "emailVerified" = true`,
    `SELECT "createdAt" FROM dormouse_voice_tokens`,
    `UPDATE dormouse_voice_tokens SET "revokedAt" = NULL`,
    `INSERT INTO dormouse_voice_tokens ("userId", hash) VALUES ('x', 'x')`,
    `DELETE FROM dormouse_voice_usage`,
  ])
    expect([text, await outcome("voice", text)]).toEqual([text, "42501"]);
});

test("reapplying revokes a grant made since, and keeps a role's login and password", async () => {
  await queryDatabase(context.database.url, `GRANT ALL ON ALL TABLES IN SCHEMA public TO dormouse_relay`);
  await queryDatabase(context.database.url, `GRANT SELECT (name) ON "user" TO dormouse_voice`);
  const before = { relay: await privileges(RUNTIME_ROLES.relay), voice: await privileges(RUNTIME_ROLES.voice) };
  expect(before.relay).toContain("session: DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE");
  expect(before.voice).toContain("user.name: SELECT");
  await applyRuntimeRoles(context.database.url);
  expect(await privileges(RUNTIME_ROLES.relay)).not.toContain(before.relay.find((entry) => entry.startsWith("session:")));
  expect(await privileges(RUNTIME_ROLES.voice)).not.toContain("user.name: SELECT");
  // The test harness set LOGIN and a password; the reapply left both.
  expect(await outcome("relay", "SELECT 1")).toBe("ok");
});

test("the roles file refuses a role holding power of its own or inherited", async () => {
  await queryDatabase(context.database.url, `GRANT pg_read_all_data TO dormouse_voice`);
  try {
    await expect(applyRuntimeRoles(context.database.url)).rejects.toThrow(
      /Role dormouse_voice has privileges beyond/,
    );
  } finally {
    await queryDatabase(context.database.url, `REVOKE pg_read_all_data FROM dormouse_voice`);
  }
  await queryDatabase(context.database.url, `ALTER ROLE dormouse_relay CREATEDB`);
  try {
    await expect(applyRuntimeRoles(context.database.url)).rejects.toThrow(
      /Role dormouse_relay has privileges beyond/,
    );
  } finally {
    await queryDatabase(context.database.url, `ALTER ROLE dormouse_relay NOCREATEDB`);
  }
  await applyRuntimeRoles(context.database.url);
});
