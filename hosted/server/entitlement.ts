// Rules: docs/specs/hosted.md -> "Entitlement".
import { queryDatabase } from "pgstencil/postgres";
import { ADMIN_EMAIL } from "./admin";

// Inlined into SQL below, so it may never carry a quote or a backslash.
if (!/^[^'\\]+$/.test(ADMIN_EMAIL)) throw new Error("ADMIN_EMAIL cannot be inlined into SQL");

/**
 * The entitlement (docs/specs/pricing.md -> "Checkout and entitlement"): a
 * SQL boolean over the `"user"` row aliased `user`, so a query that resolves
 * a bearer resolves its owner's entitlement in the same statement. Admin-only
 * until billing ships: the verified `ADMIN_EMAIL`.
 */
export function entitledSql(user = "u"): string {
  return `(${user}."emailVerified" IS TRUE AND ${user}.email = '${ADMIN_EMAIL}')`;
}

/** Whether `userId` is entitled now, read from `databaseUrl` in one query. */
export async function entitled(databaseUrl: string, userId: string): Promise<boolean> {
  const [row] = await queryDatabase<{ entitled: boolean }>(
    databaseUrl,
    `SELECT ${entitledSql()} AS entitled FROM "user" u WHERE u.id = $1`,
    [userId],
  );
  return row?.entitled === true;
}
