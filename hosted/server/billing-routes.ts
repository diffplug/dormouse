// Rules: docs/specs/hosted.md -> "Billing" and "Metrics"; docs/specs/pricing.md
// -> "Checkout and entitlement".
import { BillingError, purchaseStanding, type Billing, type BillingDB, type Stripe } from "@pgstencil/stripe";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { CompiledQuery, type Kysely } from "kysely";
import { readJson } from "remote-lib-common";
import { accountQuery, cookieLogin, type AccountHost } from "./account-gate";
import { REFUND_DAYS, foundingCohort, withBilling, type BillingSetup, type Plan } from "./billing";
import { CURRENT_STATUSES, entitledSql } from "./entitlement";
import { checkoutRef, type MetricEvent } from "./metric-labels";
import { countMetricInTransaction, recordMetric } from "./metrics";
import { BILLING_PLANS } from "./policy-constants";

/** What one request's account deployment provides to the billing routes. */
export interface BillingHost extends AccountHost {
  /** The deployment's billing setup, null while billing is closed; throws when misconfigured. */
  setup(): BillingSetup | null;
}

/** Every billing route's answer while billing is closed. */
export const CHECKOUT_CLOSED = "Checkout is not open yet.";

/** Stripe's webhook endpoint. */
export const BILLING_WEBHOOK_PATH = "/api/billing/webhook";

/** Stripe's events are larger than anything a page sends here. */
export const WEBHOOK_BODY_BYTES = 1024 * 1024;

/** The cancellation comment a subscription ended for a full refund or a final reversal carries. */
export const ENDED_FOR_REFUND = "dormouse: full refund or final reversal";

const JSON_BODY_BYTES = 4096;
const CHECKOUT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Subscription statuses Stripe has finished with (pgstencil's `missing` included). */
const ENDED = ["canceled", "incomplete_expired", "missing"];

const isPlan = (plan: unknown): plan is Plan => (BILLING_PLANS as readonly unknown[]).includes(plan);

/**
 * What a dispute's current status does to its account's subscription: an
 * open one suspends it, one closed in the account's favor restores it, and
 * a lost one is a final reversal, which ends it. An inquiry, or a status
 * this list does not know, changes nothing.
 */
export function disputeAction(status: string): "suspend" | "restore" | "end" | null {
  if (status === "needs_response" || status === "under_review") return "suspend";
  if (status === "won" || status === "warning_closed" || status === "prevented") return "restore";
  if (status === "lost") return "end";
  return null;
}

/**
 * The billing routes on the account origin: the cookie routes a signed-in
 * account drives, and Stripe's webhook. Call before any `/api/*` catch-all.
 */
export function billingRoutes(app: Hono<any>, host: (c: Context) => BillingHost) {
  const gate = cookieLogin(host);
  const limit = (maxSize: number) =>
    bodyLimit({ maxSize, onError: (c) => c.json({ message: "Request too large." }, 413) });

  /** Runs `action` on this deployment's `Billing`: 503 while closed, a `BillingError` as its status. */
  const billed = async (c: Context, action: (billing: Billing<Plan>, setup: BillingSetup) => Promise<Response>) => {
    const deployment = host(c);
    const setup = deployment.setup();
    if (!setup) return c.json({ message: CHECKOUT_CLOSED }, 503);
    try {
      return await withBilling(setup, deployment.databaseUrl, new URL(c.req.url).origin, (billing) =>
        action(billing, setup),
      );
    } catch (error) {
      if (error instanceof BillingError) return c.json({ message: error.message }, error.status as 400);
      throw error;
    }
  };

  /** The account's plan, from the synchronized rows the webhook, confirm, and resync keep current. */
  const summary = async (c: Context, billing: Billing<Plan>, setup: BillingSetup, userId: string) => {
    const [status, [account], founding] = await Promise.all([
      billing.status(userId),
      accountQuery<{ entitled: boolean; suspended: boolean }>(
        host(c),
        `SELECT ${entitledSql("u")} AS entitled,
          EXISTS (SELECT FROM dormouse_billing_disputes d WHERE d."userId" = u.id) AS suspended
        FROM "user" u WHERE u.id = $1`,
        [userId],
      ),
      foundingCohort(billing, setup.founding),
    ]);
    // A subscription Stripe still holds, paid up or not: its owner manages it
    // in the portal (a failed card included) and cannot check out again.
    const held = !!status.subscription && !ENDED.includes(status.subscription.status);
    return c.json({
      plan: held ? status.plan : null,
      active: status.access,
      until: held ? status.accessUntil : null,
      renews: held && !status.subscription!.cancel_at_period_end,
      entitled: account?.entitled === true,
      suspended: account?.suspended === true,
      founding,
    });
  };

  app.get("/api/billing", gate, (c) =>
    billed(c, (billing, setup) => summary(c, billing, setup, c.get("login").userId)),
  );

  app.post("/api/billing/checkout", limit(JSON_BODY_BYTES), gate, async (c) => {
    const { userId, email } = c.get("login");
    const body = await readJson<{ plan?: unknown; ref?: unknown }>(c);
    const plan = body?.plan;
    if (!isPlan(plan)) return c.json({ message: "Choose monthly, yearly, or founding." }, 400);
    const ref = checkoutRef(body?.ref);
    return billed(c, async (billing) => {
      // A checkout left open for another plan gives way to this one.
      const open = await billing.db
        .selectFrom("checkouts")
        .select("plan")
        .where("owner_id", "=", userId)
        .where("status", "in", ["pending", "open"])
        .executeTakeFirst();
      if (open && open.plan !== plan) await billing.cancelCheckout(userId);
      // Without an email, Stripe Checkout asks for one.
      const { url } = await billing.checkout(userId, email, plan, ref === "none" ? {} : { ref });
      recordMetric(c, host(c).databaseUrl, "checkout.started", `${plan}:${ref}`);
      return c.json({ url });
    });
  });

  app.post("/api/billing/confirm", limit(JSON_BODY_BYTES), gate, async (c) => {
    const { userId } = c.get("login");
    const checkout = (await readJson<{ checkout?: unknown }>(c))?.checkout;
    if (typeof checkout !== "string" || !CHECKOUT_ID.test(checkout))
      return c.json({ message: "Checkout not found." }, 404);
    return billed(c, async (billing, setup) => {
      await billing.confirmCheckout(userId, checkout);
      return summary(c, billing, setup, userId);
    });
  });

  app.post("/api/billing/portal", limit(JSON_BODY_BYTES), gate, (c) =>
    billed(c, async (billing) => c.json({ url: await billing.portal(c.get("login").userId) })),
  );

  // Stripe's: the raw body under its signature, 2xx only once `webhook()` has
  // committed; any other failure throws to `onError`'s 503, which Stripe retries.
  app.post(BILLING_WEBHOOK_PATH, limit(WEBHOOK_BODY_BYTES), async (c) => {
    const signature = c.req.header("stripe-signature");
    if (!signature) return c.json({ message: "Missing signature." }, 400);
    const body = await c.req.text();
    return billed(c, async (billing) => {
      await processEvent(billing, body, signature);
      return c.json({ received: true });
    });
  });
}

/** The owner of Stripe customer `customer`, or null for one pgstencil did not create. */
async function ownerOf(billing: Billing<Plan>, customer: string | Stripe.Customer | Stripe.DeletedCustomer | null) {
  const id = typeof customer === "string" ? customer : (customer?.id ?? null);
  if (!id) return null;
  const row = await billing.db
    .selectFrom("accounts")
    .select("owner_id")
    .where("customer_id", "=", id)
    .executeTakeFirst();
  return row?.owner_id ?? null;
}

/**
 * One verified event: pgstencil's synchronization, and in its transaction
 * the counts and dispute suspensions, so a redelivery repeats neither. A full
 * refund or a lost dispute then ends the subscription in Stripe, after the
 * commit and on every delivery until it has.
 */
async function processEvent(billing: Billing<Plan>, body: string, signature: string) {
  const event = await billing.verifyWebhook(body, signature);
  // A dispute names no customer, and its event may be stale: read its current
  // status and its charge from Stripe, before any write.
  let dispute: { id: string; charge: Stripe.Charge; owner: string | null; action: ReturnType<typeof disputeAction> } | null =
    null;
  if (event.type.startsWith("charge.dispute.")) {
    const current = await billing.stripe.disputes.retrieve((event.data.object as Stripe.Dispute).id, {
      expand: ["charge"],
    });
    const charge = current.charge as Stripe.Charge;
    dispute = { id: current.id, charge, owner: await ownerOf(billing, charge.customer), action: disputeAction(current.status) };
  }
  await billing.webhook(body, signature, async (verified, trx) => {
    const count = (event: MetricEvent, label: string) =>
      countMetricInTransaction((text, values) => trx.executeQuery(CompiledQuery.raw(text, values)), event, label);
    const completed = await billing.completedCheckout(verified, trx);
    if (completed && isPlan(completed.plan))
      await count("checkout.completed", `${completed.plan}:${checkoutRef(completed.ref)}`);
    if (verified.type === "customer.subscription.deleted") {
      const subscription = verified.data.object as Stripe.Subscription;
      const plan = billing.planOf(subscription.items.data[0]?.price.id);
      const standing = purchaseStanding(subscription, { refundDays: REFUND_DAYS });
      if (plan && (standing === "purchased" || standing === "refund-window"))
        await count(
          standing === "refund-window" || subscription.cancellation_details?.comment === ENDED_FOR_REFUND
            ? "subscription.refunded"
            : "subscription.canceled",
          plan,
        );
    }
    if (dispute?.owner) await recordDispute(trx, dispute.id, dispute.owner, dispute.action);
  });
  const refunded = event.type === "charge.refunded" ? (event.data.object as Stripe.Charge) : null;
  const reversed = refunded?.refunded ? refunded : dispute?.action === "end" ? dispute.charge : null;
  if (reversed) await endForRefund(billing, reversed);
}

/**
 * The subscription `charge` paid for, through its invoice: the pinned API
 * version's charge names no invoice, so the invoice payments of its
 * PaymentIntent do. Null when that names no one subscription.
 */
async function subscriptionPaidBy(billing: Billing<Plan>, charge: Stripe.Charge): Promise<string | null> {
  const intent = typeof charge.payment_intent === "string" ? charge.payment_intent : (charge.payment_intent?.id ?? null);
  if (!intent) return null;
  const payments = await billing.stripe.invoicePayments.list({
    payment: { type: "payment_intent", payment_intent: intent },
    expand: ["data.invoice"],
  });
  const paid = new Set(
    payments.data.flatMap((payment) => {
      const subscription = (payment.invoice as Stripe.Invoice).parent?.subscription_details?.subscription;
      return subscription ? [typeof subscription === "string" ? subscription : subscription.id] : [];
    }),
  );
  return paid.size === 1 ? [...paid][0]! : null;
}

/** Opens or closes dispute `disputeId`'s suspension of `owner`, as `action` says. */
async function recordDispute(
  trx: Kysely<BillingDB>,
  disputeId: string,
  owner: string,
  action: ReturnType<typeof disputeAction>,
) {
  if (action === "suspend")
    await trx.executeQuery(
      CompiledQuery.raw(
        `INSERT INTO public.dormouse_billing_disputes ("disputeId", "userId") VALUES ($1, $2)
        ON CONFLICT ("disputeId") DO NOTHING`,
        [disputeId, owner],
      ),
    );
  else if (action)
    await trx.executeQuery(
      CompiledQuery.raw(`DELETE FROM public.dormouse_billing_disputes WHERE "disputeId" = $1`, [disputeId]),
    );
}

/**
 * Ends at once, without proration or a final invoice, the subscription that
 * `charge` paid for, now fully refunded or finally reversed, while it is its
 * owner's current one. A charge for an older subscription, one that names no
 * subscription, or one already ended, as on a redelivery once it has, ends
 * nothing; the first two are logged for the operator.
 */
async function endForRefund(billing: Billing<Plan>, charge: Stripe.Charge) {
  const owner = await ownerOf(billing, charge.customer);
  if (!owner) return;
  await billing.reconcile(owner);
  const { subscription } = await billing.status(owner);
  if (!subscription || !CURRENT_STATUSES.includes(subscription.status)) return;
  const paidFor = await subscriptionPaidBy(billing, charge);
  if (paidFor !== subscription.id) {
    console.warn(
      `Charge ${charge.id} was refunded or reversed in full, but paid for ${paidFor ?? "no one subscription"}, not ${subscription.id}; ending nothing`,
    );
    return;
  }
  await billing.stripe.subscriptions.cancel(subscription.id, {
    cancellation_details: { comment: ENDED_FOR_REFUND },
    prorate: false,
    invoice_now: false,
  });
  await billing.reconcile(owner);
}
