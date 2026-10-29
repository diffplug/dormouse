// Rules: docs/specs/hosted.md -> "Account closure".
import { BillingError, SUBSCRIBED, purchaseStanding, type Billing, type BillingDB, type Stripe } from "@pgstencil/stripe";
import type { Context, Hono } from "hono";
import type { Selectable } from "kysely";
import { readJson } from "remote-lib-common";
import { SUPPORT_EMAIL } from "../../website/src/lib/hosted-withdrawal";
import { accountQuery, cookieLogin, isRecentLogin, smallBody, type AccountHost } from "./account-gate";
import { DAY_MS, END_REASONS, run, withBilling, type BillingSetup } from "./billing";
import { RECENT_LOGIN_WINDOW, REFUND_DAYS, type Plan } from "./policy-constants";
import { refundPaidInvoices } from "./withdrawal";

/** What one request's account deployment provides to account closure. */
export interface ClosureHost extends AccountHost {
  /** The deployment's billing setup, null while billing is closed. */
  setup(): BillingSetup | null;
  /** Close a deleted Burrow's live relay socket (`RelayRoom.closeBurrow`). */
  closeBurrow(userId: string, burrowId: string): Promise<unknown>;
}

/** The 403 a closure from a login older than the recent-login window gets. */
export const CLOSE_RECENT_LOGIN = `Sign in again to close your account. Closing it needs a login from the last ${RECENT_LOGIN_WINDOW}.`;

/** The 409 a closure gets while billing is closed and the account holds a subscription it cannot cancel. */
export const CLOSE_UNAVAILABLE = `Your account cannot be closed online right now. Try again later, or email ${SUPPORT_EMAIL}.`;

/**
 * Expires `owner`'s open checkout, then ends in Stripe at once, without
 * proration or a final invoice (`billing.end`), every subscription of theirs
 * still current; answers the ones it ended. An owner billing never knew has
 * none.
 */
async function endSubscriptions(billing: Billing<Plan>, owner: string): Promise<string[]> {
  if (!(await billing.customerOf(owner))) return [];
  // A checkout Stripe completed meanwhile is confirmed here, and so ended below.
  await billing.cancelCheckout(owner);
  await billing.reconcile(owner);
  const current = await billing.db
    .selectFrom("subscriptions")
    .select("id")
    .where("owner_id", "=", owner)
    .where("status", "in", SUBSCRIBED)
    .execute();
  for (const { id } of current) await billing.end(owner, id, { reason: END_REASONS.closure });
  return current.map(({ id }) => id);
}

/**
 * Whether closing refunds paid invoice `invoice` of subscription `ended`,
 * which the closure ended: its first payment while it ended within
 * `REFUND_DAYS` of starting, as `purchaseStanding` counts a refund, or a
 * yearly plan's renewal paid within `REFUND_DAYS` of the end. A monthly
 * renewal never; the 30-day guarantee does not cover one.
 */
function closureRefunds(billing: Billing<Plan>, ended: Selectable<BillingDB["subscriptions"]>, invoice: Stripe.Invoice) {
  if (invoice.billing_reason === "subscription_create")
    return purchaseStanding(ended, { refundDays: REFUND_DAYS }) === "refund-window";
  const paidAt = invoice.status_transitions?.paid_at;
  const plan = billing.planOf(ended.price_id);
  return (
    invoice.billing_reason === "subscription_cycle" &&
    (plan === "yearly" || plan === "founding") &&
    !!paidAt &&
    new Date(ended.ended_at!).getTime() < paidAt * 1000 + REFUND_DAYS * DAY_MS
  );
}

/**
 * Refunds in full what closing `owner`'s account owes on each subscription
 * it canceled ({@link closureRefunds}), then stamps the closure settled.
 * Safe to repeat.
 */
async function settleClosure(billing: Billing<Plan>, owner: string, canceled: readonly string[]) {
  for (const id of canceled) {
    const ended = await billing.db
      .selectFrom("subscriptions")
      .selectAll()
      .where("id", "=", id)
      .where("owner_id", "=", owner)
      .executeTakeFirst();
    if (!ended?.ended_at) throw new Error(`Closure of ${owner}: subscription ${id} has not ended`);
    await refundPaidInvoices(billing, id, { kind: "closure", id }, (invoice) => closureRefunds(billing, ended, invoice));
  }
  await run(billing.db, `UPDATE public.dormouse_account_closures SET "settledAt" = $2 WHERE "userId" = $1`, [
    owner,
    billing.time.now(),
  ]);
}

/** How long the cron keeps retrying a closure's refunds, and how many one run finishes at most. */
const RETRY_DAYS = 30;
const RETRY_BATCH = 20;

/**
 * The cron's pass: settles every closure in the last {@link RETRY_DAYS}
 * days whose refunds failed, up to {@link RETRY_BATCH}; answers the
 * failures.
 */
export async function retryClosures(billing: Billing<Plan>): Promise<unknown[]> {
  const rows = await run<{ userId: string; canceledSubscriptions: string[] }>(
    billing.db,
    `SELECT "userId", "canceledSubscriptions" FROM public.dormouse_account_closures
    WHERE "settledAt" IS NULL AND "closedAt" > $1 ORDER BY "closedAt" LIMIT $2`,
    [new Date(billing.time.now().getTime() - RETRY_DAYS * DAY_MS), RETRY_BATCH],
  );
  const failed: unknown[] = [];
  for (const { userId, canceledSubscriptions } of rows)
    await settleClosure(billing, userId, canceledSubscriptions).catch((error: unknown) => failed.push(error));
  return failed;
}

/**
 * The account's own closure, `POST /api/account/close`: a recent login and
 * `{ close: true }`, then every current subscription is canceled in Stripe
 * before the account is deleted, its closure recorded in the same statement;
 * then what the closure refunds is refunded, and a failure there logged for
 * the cron to finish. Billing closed, an account still holding a current
 * subscription is refused rather than deleted with it. Call before any
 * `/api/*` catch-all.
 */
export function closureRoutes(app: Hono<any>, host: (c: Context) => ClosureHost) {
  app.post("/api/account/close", smallBody(1024), cookieLogin(host), async (c) => {
    const { userId } = c.get("login");
    if (!isRecentLogin(c.get("login"))) return c.json({ message: CLOSE_RECENT_LOGIN }, 403);
    if ((await readJson<{ close?: unknown }>(c))?.close !== true)
      return c.json({ message: "Confirm that you want to close your account." }, 400);
    const deployment = host(c);
    const setup = deployment.setup();
    /** Records the closure and deletes the account; unsettled while it canceled something. */
    const close = async (canceled: string[]) => {
      // The account's rows cascade from its user; billing records, consents,
      // withdrawals, disputes, and this closure have no foreign key and stay.
      const [closed] = await accountQuery<{ burrows: string[] | null }>(
        deployment,
        `WITH burrows AS (SELECT array_agg("burrowId") AS ids FROM dormouse_relay_burrows WHERE "userId" = $1),
          recorded AS (
            INSERT INTO dormouse_account_closures ("userId", "canceledSubscriptions", "settledAt")
            VALUES ($1, $2, CASE WHEN cardinality($2::text[]) = 0 THEN now() END)
          ),
          deleted AS (DELETE FROM "user" WHERE id = $1)
        SELECT (SELECT ids FROM burrows) AS burrows`,
        [userId, canceled],
      );
      for (const burrowId of closed?.burrows ?? [])
        await deployment.closeBurrow(userId, burrowId).catch((error: unknown) =>
          console.error("Closing a closed account's Burrow socket failed; the sweep will", error),
        );
    };
    if (!setup) {
      const [held] = await accountQuery<{ held: boolean }>(
        deployment,
        `SELECT EXISTS (SELECT FROM pgstencil_billing.subscriptions WHERE owner_id = $1 AND status = ANY ($2::text[])) AS held`,
        [userId, SUBSCRIBED],
      );
      if (held?.held) return c.json({ message: CLOSE_UNAVAILABLE }, 409);
      await close([]);
      return c.body(null, 204);
    }
    try {
      await withBilling(setup, deployment.databaseUrl, new URL(c.req.url).origin, async (billing) => {
        const canceled = await endSubscriptions(billing, userId);
        await close(canceled);
        if (canceled.length)
          await settleClosure(billing, userId, canceled).catch((error: unknown) =>
            console.error(`Closure of ${userId} is recorded but its refunds are not complete; the cron retries them`, error),
          );
      });
    } catch (error) {
      // A checkout still being created, say: the account stays, and the page shows why.
      if (error instanceof BillingError) return c.json({ message: error.message }, error.status as 409);
      throw error;
    }
    return c.body(null, 204);
  });
}
