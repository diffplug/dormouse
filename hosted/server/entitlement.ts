// Rules: docs/specs/hosted.md -> "Entitlement".
import { queryDatabase } from "pgstencil/postgres";

/** The one address the entitlement keys on until billing ships. */
export const ADMIN_EMAIL = "ned.twigg@diffplug.com";

// Inlined into SQL below, so it may never carry a quote or a backslash.
if (!/^[^'\\]+$/.test(ADMIN_EMAIL)) throw new Error("ADMIN_EMAIL cannot be inlined into SQL");

/**
 * The statuses `@pgstencil/stripe` counts as a current subscription; access
 * needs exactly one of them (its `status()`).
 */
const CURRENT = `'trialing', 'active', 'past_due', 'unpaid', 'paused', 'incomplete'`;

/**
 * The entitlement (docs/specs/pricing.md -> "Checkout and entitlement"): a
 * SQL boolean over the `"user"` row aliased `user`, so a query that resolves
 * a bearer resolves its owner's entitlement in the same statement.
 *
 * A subscription grants it as `@pgstencil/stripe`'s `status()` grants access:
 * exactly one current subscription, and it `active` before its period end or
 * `trialing` before its trial end, read against the database's clock. The
 * verified `ADMIN_EMAIL` is a standing comp, so Dormouse's own dogfooding
 * never holds a subscription.
 */
export function entitledSql(user = "u"): string {
  const owned = `FROM pgstencil_billing.subscriptions s WHERE s.owner_id = ${user}.id`;
  return `((${user}."emailVerified" IS TRUE AND ${user}.email = '${ADMIN_EMAIL}')
    OR ((SELECT count(*) ${owned} AND s.status IN (${CURRENT})) = 1
      AND EXISTS (SELECT ${owned}
        AND ((s.status = 'active' AND s.period_end > now())
          OR (s.status = 'trialing' AND s.trial_end > now())))))`;
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
