// Rules: docs/specs/hosted.md -> "Account closure".
import { BillingError, SUBSCRIBED, purchaseStanding, type Billing, type BillingDB, type Stripe } from "@pgstencil/stripe";
import type { Context, Hono } from "hono";
import type { Selectable } from "kysely";
import { readJson } from "remote-lib-common";
import { SUPPORT_EMAIL } from "../../website/src/lib/hosted-withdrawal";
import { accountQuery, cookieLogin, isRecentLogin, smallBody, type AccountHost } from "./account-gate";
import { DAY_MS, END_REASONS, run, withBilling, type BillingSetup } from "./billing";
import { RECENT_LOGIN_WINDOW, REFUND_DAYS, type Plan } from "./policy-constants";
import type { RelayAccountHost } from "./relay-account";
import { refundPaidInvoices } from "./withdrawal";

/** What one request's account deployment provides to account closure: closing its relay sockets as removals do, too. */
export interface ClosureHost extends AccountHost, Pick<RelayAccountHost, "closeBurrow" | "closeSessions"> {
  /** The deployment's billing setup, null while billing is closed. */
  setup(): BillingSetup | null;
}

/** The 403 a closure from a login older than the recent-login window gets. */
export const CLOSE_RECENT_LOGIN = `Sign in again to close your account. Closing it needs a login from the last ${RECENT_LOGIN_WINDOW}.`;

/** The 409 a closure gets while billing is closed and the account holds a subscription it cannot cancel. */
export const CLOSE_UNAVAILABLE = `Your account cannot be closed online right now. Try again later, or email ${SUPPORT_EMAIL}.`;

/** The 409 checkout answers while the account is being closed. */
export const ACCOUNT_CLOSING = "This account is being closed.";

/**
 * How long a closure in progress (`dormouse_account_closing`) holds off
 * checkout, should its request die before it deletes the account or clears
 * its row.
 */
const CLOSING_HOLD_MINUTES = 15;

/**
 * Whether `owner`'s account is gone or being closed. Checkout asks once it has
 * opened a checkout and before it answers its URL: a closure that started
 * after this read then expires that checkout, since it writes its row before
 * it cancels any.
 */
export async function accountClosing(billing: Billing<Plan>, owner: string): Promise<boolean> {
  const [row] = await run<{ closing: boolean }>(
    billing.db,
    `SELECT NOT EXISTS (SELECT FROM public."user" WHERE id = $1)
      OR EXISTS (SELECT FROM public.dormouse_account_closing
        WHERE "userId" = $1 AND "startedAt" > now() - make_interval(mins => $2)) AS closing`,
    [owner, CLOSING_HOLD_MINUTES],
  );
  return row!.closing;
}

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

/** How many closures one cron run finishes at most. */
const RETRY_BATCH = 20;

/**
 * The cron's pass: tries to finish the refunds of up to {@link RETRY_BATCH}
 * unsettled closures, however old, the least recently tried first, so one
 * that keeps failing never starves the rest; answers the failures, so every
 * run that tries one still unsettled fails.
 */
export async function retryClosures(billing: Billing<Plan>): Promise<unknown[]> {
  const rows = await run<{ userId: string; canceledSubscriptions: string[] }>(
    billing.db,
    `WITH due AS (
      SELECT "userId" FROM public.dormouse_account_closures WHERE "settledAt" IS NULL
      ORDER BY "attemptedAt" NULLS FIRST, "closedAt", "userId" LIMIT $2)
    UPDATE public.dormouse_account_closures SET "attemptedAt" = $1 WHERE "userId" IN (SELECT "userId" FROM due)
    RETURNING "userId", "canceledSubscriptions"`,
    [billing.time.now(), RETRY_BATCH],
  );
  const failed: unknown[] = [];
  for (const { userId, canceledSubscriptions } of rows)
    await settleClosure(billing, userId, canceledSubscriptions).catch((error: unknown) => failed.push(error));
  return failed;
}

/**
 * Once `owner`'s account is gone, ends each subscription of theirs still
 * current, as closing does, and refunds what closing owes on it: one a
 * checkout paid after the closure started. Its closure record names it,
 * unsettled, before it ends, so the cron finishes a failed refund; a failed
 * end throws, for the caller to retry. Does nothing while the account stands.
 */
export async function endAfterClosure(billing: Billing<Plan>, owner: string) {
  const current = await run<{ id: string }>(
    billing.db,
    `SELECT id FROM pgstencil_billing.subscriptions
    WHERE owner_id = $1 AND status = ANY ($2::text[]) AND NOT EXISTS (SELECT FROM public."user" WHERE id = $1)`,
    [owner, SUBSCRIBED],
  );
  if (!current.length) return;
  const [closure] = await run<{ canceledSubscriptions: string[] }>(
    billing.db,
    `INSERT INTO public.dormouse_account_closures AS k ("userId", "canceledSubscriptions") VALUES ($1, $2)
    ON CONFLICT ("userId") DO UPDATE SET "settledAt" = NULL, "canceledSubscriptions" = k."canceledSubscriptions"
      || ARRAY(SELECT id FROM unnest(EXCLUDED."canceledSubscriptions") id WHERE id <> ALL (k."canceledSubscriptions"))
    RETURNING "canceledSubscriptions"`,
    [owner, current.map(({ id }) => id)],
  );
  for (const { id } of current) await billing.end(owner, id, { reason: END_REASONS.closure });
  await settleClosure(billing, owner, closure!.canceledSubscriptions).catch((error: unknown) =>
    console.error(`Closure of ${owner} ended a later subscription but its refunds are not complete; the cron retries them`, error),
  );
}

/**
 * The account's own closure, `POST /api/account/close`: a recent login and
 * `{ close: true }`, then, checkout held off, every current subscription is
 * canceled in Stripe before the account is deleted, its closure recorded in
 * the same statement;
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
      const [closed] = await accountQuery<{ burrows: string[] | null; sessions: string[] | null }>(
        deployment,
        `WITH burrows AS (SELECT array_agg("burrowId") AS ids FROM dormouse_relay_burrows WHERE "userId" = $1),
          sessions AS (SELECT array_agg("tokenHash") AS ids FROM dormouse_relay_sessions WHERE "userId" = $1),
          recorded AS (
            INSERT INTO dormouse_account_closures ("userId", "canceledSubscriptions", "settledAt")
            VALUES ($1, $2, CASE WHEN cardinality($2::text[]) = 0 THEN now() END)
          ),
          deleted AS (DELETE FROM "user" WHERE id = $1)
        SELECT (SELECT ids FROM burrows) AS burrows, (SELECT ids FROM sessions) AS sessions`,
        [userId, canceled],
      );
      for (const burrowId of closed?.burrows ?? [])
        await deployment.closeBurrow(userId, burrowId).catch((error: unknown) =>
          console.error("Closing a closed account's Burrow socket failed; the sweep will", error),
        );
      if (closed?.sessions)
        await deployment.closeSessions(userId, closed.sessions).catch((error: unknown) =>
          console.error("Closing a closed account's Client sockets failed; the sweep will", error),
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
        // Committed before any Stripe call, so checkout opens nothing past it
        // (`accountClosing`); deleted with the account, or here on a failure.
        await run(
          billing.db,
          `INSERT INTO public.dormouse_account_closing ("userId") VALUES ($1)
          ON CONFLICT ("userId") DO UPDATE SET "startedAt" = now()`,
          [userId],
        );
        let canceled: string[];
        try {
          canceled = await endSubscriptions(billing, userId);
          await close(canceled);
        } catch (error) {
          await run(billing.db, `DELETE FROM public.dormouse_account_closing WHERE "userId" = $1`, [userId]).catch(
            (cleared: unknown) => console.error("Clearing a failed closure's hold on checkout failed; it lapses", cleared),
          );
          throw error;
        }
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
