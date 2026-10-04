// Rules: docs/specs/hosted.md -> "Entitlement".
import { queryDatabase } from "pgstencil/postgres";

/** The standing comp: Dormouse's own dogfooding account, entitled without a subscription. */
export const ADMIN_EMAIL = "ned.twigg@diffplug.com";

// Inlined into SQL below, so it may never carry a quote or a backslash.
if (!/^[^'\\]+$/.test(ADMIN_EMAIL)) throw new Error("ADMIN_EMAIL cannot be inlined into SQL");

/**
 * Whether the `"user"` row aliased `user` is the admin: `ADMIN_EMAIL`, verified.
 * The entitlement's standing comp, and the gate on the admin metrics view.
 */
export const adminSql = (user = "u") =>
  `(${user}."emailVerified" IS TRUE AND ${user}.email = '${ADMIN_EMAIL}')`;

/**
 * The statuses `@pgstencil/stripe` counts as a current subscription; access
 * needs exactly one of them (its `status()`).
 */
const CURRENT = `'trialing', 'active', 'past_due', 'unpaid', 'paused', 'incomplete'`;

/**
 * Whether subscription row `s` grants access at `at`: `active` before its
 * period end or `trialing` before its trial end, as `status()` reads it.
 */
export const accessSql = (s = "s", at = "now()") =>
  `((${s}.status = 'active' AND ${s}.period_end > ${at})
    OR (${s}.status = 'trialing' AND ${s}.trial_end > ${at}))`;

/**
 * The entitlement (docs/specs/pricing.md -> "Checkout and entitlement"): a
 * SQL boolean over the `"user"` row aliased `user`, so a query that resolves
 * a bearer resolves its owner's entitlement in the same statement.
 *
 * A subscription grants it as `@pgstencil/stripe`'s `status()` grants access:
 * exactly one current subscription, and it granting access by the database's
 * clock. The verified `ADMIN_EMAIL` is a standing comp, so Dormouse's own
 * dogfooding never holds a subscription.
 */
export function entitledSql(user = "u"): string {
  return `(${adminSql(user)} OR ${subscribedSql(`${user}.id`)})`;
}

/**
 * Whether `owner` holds exactly one current subscription and it grants
 * access, as `status()` decides; with `prices`, an SQL array, only one on
 * those Prices counts.
 */
export function subscribedSql(owner: string, prices?: string): string {
  const granting = prices ? `${accessSql()} AND s.price_id = ANY(${prices})` : accessSql();
  return `coalesce((SELECT count(*) FILTER (WHERE s.status IN (${CURRENT})) = 1 AND bool_or(${granting})
    FROM pgstencil_billing.subscriptions s WHERE s.owner_id = ${owner}), false)`;
}

/** Whether `userId` passes `predicate` (an SQL boolean over `u`) now, read from `databaseUrl` in one query. */
async function holds(databaseUrl: string, userId: string, predicate: string): Promise<boolean> {
  const [row] = await queryDatabase<{ holds: boolean }>(
    databaseUrl,
    `SELECT ${predicate} AS holds FROM "user" u WHERE u.id = $1`,
    [userId],
  );
  return row?.holds === true;
}

/** Whether `userId` is entitled now. */
export const entitled = (databaseUrl: string, userId: string) => holds(databaseUrl, userId, entitledSql());

/** Whether `userId` is the admin now. */
export const isAdmin = (databaseUrl: string, userId: string) => holds(databaseUrl, userId, adminSql());
