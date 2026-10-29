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
export const CURRENT_STATUSES: readonly string[] = ["trialing", "active", "past_due", "unpaid", "paused", "incomplete"];
/** Subscription statuses Stripe has finished with (pgstencil's `missing` included). */
export const ENDED_STATUSES: readonly string[] = ["canceled", "incomplete_expired", "missing"];

const CURRENT = CURRENT_STATUSES.map((status) => `'${status}'`).join(", ");

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
 * and it grants access, as `status()` decides; with `prices`, an SQL `text[]`
 * expression, only while that subscription is on one of them.
 */
export function subscribedSql(owner: string, prices?: string): string {
  const on = prices ? ` AND entitling.price_id = ANY (${prices})` : "";
  // An alias no caller's query uses, so `owner` can name the outer row.
  return `coalesce((SELECT count(*) FILTER (WHERE entitling.status IN (${CURRENT})) = 1
      AND bool_or(${grantsAccessSql("entitling")}${on})
    FROM pgstencil_billing.subscriptions entitling WHERE entitling.owner_id = ${owner}), false)`;
}

/** Whether the SQL expression `owner` has a payment dispute open, which suspends its subscription. */
const disputedSql = (owner: string) =>
  `EXISTS (SELECT FROM dormouse_billing_disputes disputed WHERE disputed."userId" = ${owner})`;

/**
 * The entitlement (docs/specs/pricing.md -> "Checkout and entitlement"): a
 * SQL boolean over the `"user"` row aliased by `user` (default `u`), so a
 * query that resolves a bearer resolves its owner's entitlement in the same
 * statement. The account's subscription grants it unless a payment dispute
 * is open, and the verified `ADMIN_EMAIL` is a standing comp.
 */
export function entitledSql(user = "u"): string {
  return `(${adminSql(user)} OR (${subscribedSql(`${user}.id`)} AND NOT ${disputedSql(`${user}.id`)}))`;
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
