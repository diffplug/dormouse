// Rules: docs/specs/hosted.md -> "Account closure".
import type { Billing } from "@pgstencil/stripe";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { readJson } from "remote-lib-common";
import { accountQuery, cookieLogin, type AccountHost } from "./account-gate";
import { withBilling, type BillingSetup, type Plan } from "./billing";
import { CURRENT_STATUSES } from "./entitlement";
import { LOGIN_FRESH_AGE_MS, RECENT_LOGIN_WINDOW } from "./policy-constants";

/** What one request's account deployment provides to account closure. */
export interface ClosureHost extends AccountHost {
  /** The deployment's billing setup, null while billing is closed. */
  setup(): BillingSetup | null;
  /** Close a deleted Burrow's live relay socket (`RelayRoom.closeBurrow`). */
  closeBurrow(userId: string, burrowId: string): Promise<unknown>;
}

/** The 403 a closure from a login older than the recent-login window gets. */
export const CLOSE_RECENT_LOGIN = `Sign in again to close your account. Closing it needs a login from the last ${RECENT_LOGIN_WINDOW}.`;

/** The 503 a closure gets when it cannot reach billing to cancel a subscription the account holds. */
export const CLOSE_UNAVAILABLE = "Your account cannot be closed online right now. Try again later, or email support@dormouse.sh.";

/** The cancellation comment a subscription ended by closing its account carries. */
export const ENDED_FOR_CLOSURE = "dormouse: account closed";

/**
 * Expires `owner`'s open checkout, then cancels in Stripe at once, without
 * proration or a final invoice, every subscription of theirs still current;
 * answers the ones it canceled. An owner billing never knew has none.
 */
async function endSubscriptions(billing: Billing<Plan>, owner: string): Promise<string[]> {
  const known = await billing.db.selectFrom("accounts").select("owner_id").where("owner_id", "=", owner).executeTakeFirst();
  if (!known) return [];
  // A checkout Stripe completed meanwhile is confirmed here, and so ended below.
  await billing.cancelCheckout(owner);
  await billing.reconcile(owner);
  const current = await billing.db
    .selectFrom("subscriptions")
    .select("id")
    .where("owner_id", "=", owner)
    .where("status", "in", [...CURRENT_STATUSES])
    .execute();
  for (const { id } of current)
    await billing.stripe.subscriptions.cancel(id, {
      cancellation_details: { comment: ENDED_FOR_CLOSURE },
      prorate: false,
      invoice_now: false,
    });
  if (current.length) await billing.reconcile(owner);
  return current.map(({ id }) => id);
}

/**
 * The account's own closure, `POST /api/account/close`: a recent login and
 * `{ close: true }`, then every current subscription is canceled in Stripe
 * before the account is deleted, its closure recorded in the same statement.
 * Billing closed, an account still holding a current subscription is refused
 * rather than deleted with it. Call before any `/api/*` catch-all.
 */
export function closureRoutes(app: Hono<any>, host: (c: Context) => ClosureHost) {
  const small = bodyLimit({ maxSize: 1024, onError: (c) => c.json({ message: "Request too large." }, 413) });

  app.post("/api/account/close", small, cookieLogin(host), async (c) => {
    const { userId, createdAt } = c.get("login");
    // Fails closed, as approval's check does.
    if (!(Date.now() - Date.parse(String(createdAt)) < LOGIN_FRESH_AGE_MS))
      return c.json({ message: CLOSE_RECENT_LOGIN }, 403);
    if ((await readJson<{ close?: unknown }>(c))?.close !== true)
      return c.json({ message: "Confirm that you want to close your account." }, 400);
    const deployment = host(c);
    const setup = deployment.setup();
    let canceled: string[];
    if (setup)
      canceled = await withBilling(setup, deployment.databaseUrl, new URL(c.req.url).origin, (billing) =>
        endSubscriptions(billing, userId),
      );
    else {
      const [held] = await accountQuery<{ held: boolean }>(
        deployment,
        `SELECT EXISTS (SELECT FROM pgstencil_billing.subscriptions WHERE owner_id = $1 AND status = ANY ($2::text[])) AS held`,
        [userId, CURRENT_STATUSES],
      );
      if (held?.held) return c.json({ message: CLOSE_UNAVAILABLE }, 503);
      canceled = [];
    }
    // The account's rows cascade from its user; billing records, consents,
    // withdrawals, and this closure have no foreign key and stay.
    const [closed] = await accountQuery<{ burrows: string[] | null }>(
      deployment,
      `WITH burrows AS (SELECT array_agg("burrowId") AS ids FROM dormouse_relay_burrows WHERE "userId" = $1),
        recorded AS (
          INSERT INTO dormouse_account_closures ("userId", "canceledSubscriptions") VALUES ($1, $2)
        ),
        deleted AS (DELETE FROM "user" WHERE id = $1)
      SELECT (SELECT ids FROM burrows) AS burrows`,
      [userId, canceled],
    );
    for (const burrowId of closed?.burrows ?? [])
      await deployment.closeBurrow(userId, burrowId).catch((error: unknown) =>
        console.error("Closing a closed account's Burrow socket failed; the sweep will", error),
      );
    return c.body(null, 204);
  });
}
