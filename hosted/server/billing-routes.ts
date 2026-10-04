// Rules: docs/specs/hosted.md -> "Billing"; docs/specs/pricing.md ->
// "Checkout and entitlement" and "The founding card's live half".
import type { Billing } from "@pgstencil/stripe";
import type { Context, Hono } from "hono";
import { sql } from "kysely";
import { queryDatabase } from "pgstencil/postgres";
import { readJson } from "remote-lib-common";
import { COHORT_ENDPOINT, MAX_SHOWN_FOUNDERS } from "../../website/src/lib/hosted-cohorts";
import { isCheckoutPlan } from "../../website/src/lib/hosted-pricing";
import { accountQuery, cookieLogin, jsonBodyLimit, type AccountHost } from "./account-gate";
import {
  BillingError,
  foundingSold,
  openCohort,
  withBilling,
  type BillingSetup,
  type Plan,
} from "./billing";
import { accessSql, entitledSql, subscribedSql } from "./entitlement";

/** What one request's account deployment provides to the billing routes. */
export interface BillingHost extends AccountHost {
  /** The deployment's billing setup, null while billing is off; throws when misconfigured. */
  setup(): BillingSetup | null;
}

/** The billing routes' answer while a deployment has no Stripe configuration. */
export const CHECKOUT_CLOSED = "Checkout is not open yet.";

/** Stripe's events are larger than any request a browser sends here. */
export const WEBHOOK_BODY_BYTES = 1024 * 1024;

/** How long one isolate reuses its cohort answer. */
export const COHORT_CACHE_MS = 60_000;

/** Stripe's webhook path. */
export const BILLING_WEBHOOK_PATH = "/api/billing/webhook";

const CHECKOUT_ID = /^[A-Za-z0-9_-]{1,64}$/;
// A shown name: no control characters, nothing a row could not print.
const SHOWN_NAME = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,64}$/u;
const SURVEY = ["tooExpensive", "tooCheap", "expensive", "bargain"] as const;

/** Whether founder row `f` is a current founder: subscribed on a founding Price (`$1`). */
const CURRENT_FOUNDER = subscribedSql(`f."userId"`, "$1");

/**
 * The billing routes on the account origin: the cookie routes a signed-in
 * account drives, Stripe's webhook, and the public cohort endpoint the
 * Hosted page reads (also served from the site origin, `workerApp`'s
 * `site`).
 */
export function billingRoutes(app: Hono<any>, host: (c: Context) => BillingHost) {
  const gate = cookieLogin(host);
  const small = jsonBodyLimit(4096);
  const closed = (c: Context) => c.json({ message: CHECKOUT_CLOSED }, 503);

  /** Runs `action` with this deployment's `Billing`; 503 while billing is off, a `BillingError` as its status. */
  const billed = async (
    c: Context,
    action: (billing: Billing<Plan>, setup: BillingSetup) => Promise<Response>,
  ) => {
    const deployment = host(c);
    const setup = deployment.setup();
    if (!setup) return closed(c);
    try {
      return await withBilling(setup, deployment.databaseUrl, new URL(c.req.url).origin, (billing) =>
        action(billing, setup),
      );
    } catch (error) {
      if (error instanceof BillingError)
        return c.json({ message: error.message }, error.status as 400);
      throw error;
    }
  };

  /**
   * The account's plan as the account app shows it, from the synchronized
   * rows: webhooks, confirm, and the hourly resync keep them current.
   */
  const summary = async (c: Context, billing: Billing<Plan>, setup: BillingSetup, userId: string) => {
    const [status, account, sold] = await Promise.all([
      billing.status(userId),
      sql<{ entitled: boolean; founder: string | null }>`SELECT ${sql.raw(entitledSql())} AS entitled,
        (SELECT name FROM dormouse_founders WHERE "userId" = u.id) AS founder
        FROM "user" u WHERE u.id = ${userId}`.execute(billing.db),
      foundingSold(billing, setup),
    ]);
    const [row] = account.rows;
    return c.json({
      plan: status.access ? status.plan : null,
      until: status.access ? status.accessUntil : null,
      renews: status.access && !status.subscription?.cancel_at_period_end,
      entitled: row?.entitled === true,
      founder: row?.founder ?? null,
      founding: openCohort(sold),
    });
  };

  app.get("/api/billing", gate, (c) =>
    billed(c, (billing, setup) => summary(c, billing, setup, c.get("login").userId)),
  );

  app.post("/api/billing/checkout", small, gate, async (c) => {
    const { userId, email } = c.get("login");
    const plan = (await readJson<{ plan?: unknown }>(c))?.plan;
    if (!isCheckoutPlan(plan)) return c.json({ message: "Choose monthly, yearly, or founding." }, 400);
    // A provider-only account has no public email: Stripe Checkout asks for one.
    return billed(c, async (billing) => {
      // A checkout left open for another plan gives way to this one.
      const other = await billing.db
        .selectFrom("checkouts")
        .select("plan")
        .where("owner_id", "=", userId)
        .where("status", "in", ["pending", "open"])
        .executeTakeFirst();
      if (other && other.plan !== plan) await billing.cancelCheckout(userId);
      const { url } = await billing.checkout(userId, email, plan);
      return c.json({ url });
    });
  });

  app.post("/api/billing/confirm", small, gate, async (c) => {
    const { userId } = c.get("login");
    const checkout = (await readJson<{ checkout?: unknown }>(c))?.checkout;
    if (typeof checkout !== "string" || !CHECKOUT_ID.test(checkout))
      return c.json({ message: "Checkout not found." }, 404);
    return billed(c, async (billing, setup) => {
      // A complete checkout resyncs from Stripe before the summary reads.
      await billing.confirmCheckout(userId, checkout);
      return summary(c, billing, setup, userId);
    });
  });

  app.post("/api/billing/portal", gate, (c) =>
    billed(c, async (billing) => c.json({ url: await billing.portal(c.get("login").userId) })),
  );

  // The founders row: only a current founder may appear, under a name they chose.
  app.put("/api/billing/founder", small, gate, async (c) => {
    const { userId } = c.get("login");
    const body = await readJson<{ shown?: unknown; name?: unknown }>(c);
    if (body?.shown === false) {
      await accountQuery(host(c), `DELETE FROM dormouse_founders WHERE "userId" = $1`, [userId]);
      return c.body(null, 204);
    }
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (body?.shown !== true || !SHOWN_NAME.test(name))
      return c.json({ message: "Give a name of 1 to 64 characters to show." }, 400);
    const setup = host(c).setup();
    if (!setup) return closed(c);
    const [row] = await accountQuery<{ userId: string }>(
      host(c),
      `INSERT INTO dormouse_founders ("userId", name)
      SELECT "userId", $3 FROM (SELECT $2::text AS "userId") f WHERE ${CURRENT_FOUNDER}
      ON CONFLICT ("userId") DO UPDATE SET name = EXCLUDED.name
      RETURNING "userId"`,
      [setup.founding, userId, name],
    );
    return row
      ? c.body(null, 204)
      : c.json({ message: "Only a founding member can join the founders row." }, 409);
  });

  // The Van Westendorp answers: optional, each a whole-dollar price or null.
  app.put("/api/billing/survey", small, gate, async (c) => {
    const body = await readJson<Record<string, unknown>>(c);
    const answers = SURVEY.map((field) => body?.[field] ?? null);
    if (
      !body ||
      answers.every((answer) => answer === null) ||
      !answers.every(
        (answer) =>
          answer === null || (Number.isInteger(answer) && (answer as number) >= 0 && (answer as number) <= 100_000),
      )
    )
      return c.json({ message: "Answer with whole dollars." }, 400);
    await accountQuery(
      host(c),
      `INSERT INTO dormouse_price_survey ("userId", "tooExpensive", "tooCheap", expensive, bargain)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT ("userId") DO UPDATE SET "tooExpensive" = $2, "tooCheap" = $3,
        expensive = $4, bargain = $5, "answeredAt" = now()`,
      [c.get("login").userId, ...answers],
    );
    return c.body(null, 204);
  });

  // Stripe's: the raw body and its signature, 2xx only once `webhook()` has
  // committed; an unexpected failure throws to `onError`'s 503, which Stripe retries.
  app.post(
    BILLING_WEBHOOK_PATH,
    jsonBodyLimit(WEBHOOK_BODY_BYTES),
    async (c) => {
      const signature = c.req.header("stripe-signature");
      if (!signature) return c.json({ message: "Missing signature." }, 400);
      const body = await c.req.text();
      return billed(c, async (billing) => {
        await billing.webhook(body, signature);
        return c.json({ received: true });
      });
    },
  );

  // The founding card's live half, unauthenticated and cached per isolate as
  // text: a Response, and a promise its I/O settles, belong to one request.
  let cohorts: { at: number; status: number; text: string } | undefined;
  app.get(COHORT_ENDPOINT, async (c) => {
    const now = Date.now();
    if (!cohorts || now - cohorts.at >= COHORT_CACHE_MS) {
      const response = await billed(c, async (billing, setup) => {
        const [sold, shown] = await Promise.all([
          foundingSold(billing, setup),
          accountQuery<{ name: string }>(
            host(c),
            `SELECT f.name FROM dormouse_founders f WHERE ${CURRENT_FOUNDER}
            ORDER BY f."shownSince", f."userId" LIMIT ${MAX_SHOWN_FOUNDERS}`,
            [setup.founding],
          ),
        ]);
        const open = openCohort(sold);
        return c.json({
          // Which cohort the seats belong to, so a page prerendered at another
          // price can drop them; absent with the seats once founding closes.
          ...(open && { cohort: open.cohort, seatsLeft: open.seatsLeft }),
          founders: { total: sold.reduce((sum, count) => sum + count, 0), shown },
        });
      });
      cohorts = { at: now, status: response.status, text: await response.text() };
    }
    return c.body(cohorts.text, cohorts.status as 200, { "content-type": "application/json" });
  });
}

/**
 * The account Worker's Cron Trigger: resyncs from Stripe every subscription
 * whose paid period or trial ends within the hour, so a missed renewal
 * webhook never lapses a member. At most `limit` accounts a run.
 */
export async function reconcileDue(
  setup: BillingSetup | null,
  databaseUrl: string,
  origin: string,
  limit = 20,
) {
  if (!setup) return;
  const due = await queryDatabase<{ owner: string }>(
    databaseUrl,
    `SELECT owner_id AS owner FROM pgstencil_billing.subscriptions s
    WHERE status IN ('active', 'trialing') AND NOT ${accessSql("s", "now() + interval '1 hour'")}
    GROUP BY owner_id ORDER BY min(period_end) LIMIT $1`,
    [limit],
  );
  if (!due.length) return;
  const failed: unknown[] = [];
  await withBilling(setup, databaseUrl, origin, async (billing) => {
    for (const { owner } of due)
      await billing.reconcile(owner).catch((error: unknown) => failed.push(error));
  });
  if (failed.length) throw new AggregateError(failed, `${failed.length} reconciles failed`);
}
