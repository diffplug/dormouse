// Rules: docs/specs/hosted.md -> "Entitlement".
import { queryDatabase } from "pgstencil/postgres";

/** The admin's address: the one the entitlement keys on until billing ships, and the admin page's. */
export const ADMIN_EMAIL = "ned.twigg@diffplug.com";

// Inlined into SQL below, so it may never carry a quote or a backslash.
if (!/^[^'\\]+$/.test(ADMIN_EMAIL)) throw new Error("ADMIN_EMAIL cannot be inlined into SQL");

/**
 * The entitlement (docs/specs/pricing.md -> "Checkout and entitlement"): a
 * SQL boolean over the `"user"` row aliased by `user` (default `u`), so a query that resolves
 * a bearer resolves its owner's entitlement in the same statement. Admin-only
 * until billing ships: the verified `ADMIN_EMAIL`.
 */
export function entitledSql(user = "u"): string {
  return adminSql(user);
}

/** Whether the `"user"` row aliased by `user` is the admin's: `ADMIN_EMAIL`, verified. */
export function adminSql(user = "u"): string {
  return `(${user}."emailVerified" IS TRUE AND ${user}.email = '${ADMIN_EMAIL}')`;
}

/** Whether `userId` is entitled now, read from `databaseUrl` in one query. */
export const entitled = (databaseUrl: string, userId: string) => userIs(entitledSql(), databaseUrl, userId);

/** Whether `userId` is the admin now, read from `databaseUrl` in one query. */
export const isAdmin = (databaseUrl: string, userId: string) => userIs(adminSql(), databaseUrl, userId);

async function userIs(predicate: string, databaseUrl: string, userId: string): Promise<boolean> {
  const [row] = await queryDatabase<{ is: boolean }>(
    databaseUrl,
    `SELECT ${predicate} AS is FROM "user" u WHERE u.id = $1`,
    [userId],
  );
  return row?.is === true;
}
