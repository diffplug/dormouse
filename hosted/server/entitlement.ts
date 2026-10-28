// Rules: docs/specs/hosted.md -> "Entitlement".
import { queryDatabase } from "pgstencil/postgres";

/** The admin's address: a standing comp the entitlement admits without a subscription, and the admin page's. */
export const ADMIN_EMAIL = "ned.twigg@diffplug.com";

// Inlined into SQL below, so it may never carry a quote or a backslash.
if (!/^[^'\\]+$/.test(ADMIN_EMAIL)) throw new Error("ADMIN_EMAIL cannot be inlined into SQL");

/**
 * The statuses `@pgstencil/stripe`'s `status()` counts as a current
 * subscription; access needs exactly one of them.
 */
const CURRENT = `'trialing', 'active', 'past_due', 'unpaid', 'paused', 'incomplete'`;

/**
 * Whether subscription row `s` grants access now, by the database's clock:
 * `active` before its period end or `trialing` before its trial end, as
 * `status()` reads it. No other status grants anything, `past_due` included.
 */
export const grantsAccessSql = (s: string) =>
  `((${s}.status = 'active' AND ${s}.period_end > now())
    OR (${s}.status = 'trialing' AND ${s}.trial_end > now()))`;

/**
 * Whether the SQL expression `owner` holds exactly one current subscription
 * and it grants access, as `status()` decides.
 */
function subscribedSql(owner: string): string {
  // An alias no caller's query uses, so `owner` can name the outer row.
  return `coalesce((SELECT count(*) FILTER (WHERE entitling.status IN (${CURRENT})) = 1
      AND bool_or(${grantsAccessSql("entitling")})
    FROM pgstencil_billing.subscriptions entitling WHERE entitling.owner_id = ${owner}), false)`;
}

/**
 * The entitlement (docs/specs/pricing.md -> "Checkout and entitlement"): a
 * SQL boolean over the `"user"` row aliased by `user` (default `u`), so a
 * query that resolves a bearer resolves its owner's entitlement in the same
 * statement. The account's subscription grants it, and the verified
 * `ADMIN_EMAIL` is a standing comp.
 */
export function entitledSql(user = "u"): string {
  return `(${adminSql(user)} OR ${subscribedSql(`${user}.id`)})`;
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
