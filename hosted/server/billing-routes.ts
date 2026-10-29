// Rules: docs/specs/hosted.md -> "Billing" and "Metrics"; docs/specs/pricing.md
// -> "Checkout and entitlement".
import { BillingError, purchaseStanding, type Billing, type BillingDB, type Stripe } from "@pgstencil/stripe";
import type { Context, Hono } from "hono";
import type { Kysely } from "kysely";
import { readJson } from "remote-lib-common";
import { accountQuery, cookieLogin, smallBody, type AccountHost } from "./account-gate";
import { REFUND_DAYS, foundingCohort, idOf, run, withBilling, type BillingSetup, type PriceCatalog } from "./billing";
import type { BillingSummary, Withdrawn } from "./billing-summary";
import { CURRENT_STATUSES, entitledSql, subscribedSql } from "./entitlement";
import { checkoutRef, type MetricEvent } from "./metric-labels";
import { countMetricInTransaction, recordMetric } from "./metrics";
import { CHECKOUT_CLOSED, PRICE_CHANGED, TERMS_VERSION, isFounderName, isPlan, type Plan } from "./policy-constants";
import { sendNotices, type NoticeContext } from "./notices";
import { completeWithdrawal, recordWithdrawal, recordedWithdrawal, withdrawalOffer } from "./withdrawal";
import { SUPPORT_EMAIL } from "../../website/src/lib/hosted-withdrawal";
import type { EmailSender } from "pgstencil";

/** What one request's account deployment provides to the billing routes. */
export interface BillingHost extends AccountHost {
  /** The deployment's billing setup, null while billing is closed; throws when misconfigured. */
  setup(): BillingSetup | null;
  /** The account's mail, which a withdrawal's acknowledgement and a dispute's notices go out by. */
  mail(): EmailSender;
}

/** Checkout's answer to a request that does not carry both agreements. */
export const CONSENT_REQUIRED = "Agree to the terms and to automatic renewal first.";

/** Checkout's answer to agreement with a terms version no longer current. */
export const TERMS_CHANGED = "The terms have changed. Reload this page to read them.";

/** The founders row's answer to an account not subscribed on a founding Price. */
export const FOUNDERS_ONLY = "Only a founding subscription can join the founders row.";

/** The withdrawal route's answer for a contract no longer withdrawable online, or never. */
export const WITHDRAWAL_CLOSED = `This contract can no longer be withdrawn from online. Email ${SUPPORT_EMAIL}.`;

/** Stripe's webhook endpoint. */
export const BILLING_WEBHOOK_PATH = "/api/billing/webhook";

/** Stripe's events are larger than anything a page sends here. */
export const WEBHOOK_BODY_BYTES = 1024 * 1024;

/** The cancellation comment a subscription ended for a full refund or a final reversal carries. */
export const ENDED_FOR_REFUND = "dormouse: full refund or final reversal";

const JSON_BODY_BYTES = 4096;
const CHECKOUT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_]{1,250}$/;

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

  /** Runs `action` on this deployment's `Billing`: 503 while closed, a `BillingError` as its status. */
  const billed = async (
    c: Context,
    action: (billing: Billing<Plan>, setup: BillingSetup, catalog: PriceCatalog) => Promise<Response>,
  ) => {
    const deployment = host(c);
    const setup = deployment.setup();
    if (!setup) return c.json({ message: CHECKOUT_CLOSED }, 503);
    try {
      return await withBilling(setup, deployment.databaseUrl, new URL(c.req.url).origin, (billing, catalog) =>
        action(billing, setup, catalog),
      );
    } catch (error) {
      if (error instanceof BillingError) return c.json({ message: error.message }, error.status as 400);
      throw error;
    }
  };

  /** The account's plan, from the synchronized rows the webhook, confirm, and resync keep current. */
  const summary = async (
    c: Context,
    billing: Billing<Plan>,
    setup: BillingSetup,
    catalog: PriceCatalog,
    userId: string,
  ) => {
    const [status, [account], founding] = await Promise.all([
      billing.status(userId),
      accountQuery<{
        entitled: boolean;
        suspended: boolean;
        founder: boolean;
        name: string | null;
        consent: { termsVersion: string; consentedAt: string } | null;
        withdrawn: Withdrawn | null;
      }>(
        host(c),
        // A held subscription refuses another checkout, so the latest consent is its own.
        `SELECT ${entitledSql("u")} AS entitled,
          EXISTS (SELECT FROM dormouse_billing_disputes d WHERE d."userId" = u.id) AS suspended,
          ${subscribedSql("u.id", "$2::text[]")} AS founder,
          (SELECT f.name FROM dormouse_founders f WHERE f."userId" = u.id) AS name,
          (SELECT json_build_object('termsVersion', k."termsVersion", 'consentedAt', k."consentedAt")
            FROM dormouse_checkout_consents k WHERE k."userId" = u.id
            ORDER BY k."consentedAt" DESC LIMIT 1) AS consent,
          (SELECT json_build_object('reference', w.id, 'subscription', w."subscriptionId", 'plan', w.plan,
              'startedAt', w."contractStartedAt", 'submittedAt', w."submittedAt",
              'acknowledged', w."acknowledgedAt" IS NOT NULL, 'settled', w."settledAt" IS NOT NULL)
            FROM dormouse_withdrawals w WHERE w."userId" = u.id
            ORDER BY w."submittedAt" DESC LIMIT 1) AS withdrawn
        FROM "user" u WHERE u.id = $1`,
        [userId, setup.founding],
      ),
      foundingCohort(billing, setup.founding),
    ]);
    // A subscription Stripe still holds, paid up or not: its owner manages it
    // in the portal (a failed card included) and cannot check out again.
    const held = status.subscription && CURRENT_STATUSES.includes(status.subscription.status) ? status.subscription : null;
    // A contract withdrawn from once is never offered again.
    const offer =
      held && account?.withdrawn?.subscription !== held.id
        ? await withdrawalOffer(billing, userId, held, { cached: true })
        : null;
    return c.json({
      plan: held ? status.plan : null,
      price: held ? (catalog.prices.get(held.price_id)?.usd ?? null) : null,
      active: status.access,
      until: held ? (status.accessUntil?.toISOString() ?? null) : null,
      renews: !!held && !held.cancel_at_period_end,
      entitled: account?.entitled === true,
      suspended: account?.suspended === true,
      founding,
      // Offered while a founding subscription grants access; `name` while shown.
      founder: { offered: account?.founder === true, name: account?.name ?? null },
      consent: held ? (account?.consent ?? null) : null,
      withdrawal: offer && { subscription: offer.subscription, startedAt: offer.startedAt, until: offer.until, email: offer.email },
      // Only while it describes the held subscription, its settlement still
      // pending, or nothing is held: a plan bought after it is not withdrawn.
      withdrawn:
        account?.withdrawn && (!held || account.withdrawn.subscription === held.id)
          ? account.withdrawn
          : null,
    } satisfies BillingSummary);
  };

  app.get("/api/billing", gate, (c) =>
    billed(c, (billing, setup, catalog) => summary(c, billing, setup, catalog, c.get("login").userId)),
  );

  app.post("/api/billing/checkout", smallBody(JSON_BODY_BYTES), gate, async (c) => {
    const { userId, email } = c.get("login");
    const body = await readJson<{ plan?: unknown; ref?: unknown; terms?: unknown; autoRenew?: unknown; price?: unknown }>(c);
    const plan = body?.plan;
    if (!isPlan(plan)) return c.json({ message: "Choose monthly, yearly, or founding." }, 400);
    const ref = checkoutRef(body?.ref);
    return billed(c, async (billing, _setup, catalog) => {
      // `price` is what the page showed beside the renewal the buyer agreed to.
      if (typeof body?.terms !== "string" || body.autoRenew !== true || !Number.isSafeInteger(body.price))
        return c.json({ message: CONSENT_REQUIRED }, 400);
      if (body.terms !== TERMS_VERSION) return c.json({ message: TERMS_CHANGED }, 409);
      // A checkout left open for another plan gives way to this one.
      const open = await billing.db
        .selectFrom("checkouts")
        .select("plan")
        .where("owner_id", "=", userId)
        .where("status", "in", ["pending", "open"])
        .executeTakeFirst();
      if (open && open.plan !== plan) await billing.cancelCheckout(userId);
      // Without an email, Stripe Checkout asks for one.
      const { id, url } = await billing.checkout(userId, email, plan, ref === "none" ? {} : { ref });
      // The Price this checkout charges, a cohort sold out since the page
      // loaded or one left open at an earlier step included: one the buyer
      // was not shown is expired, so the page asks again at the new price.
      const opened = await billing.db
        .selectFrom("checkouts")
        .select("price_id")
        .where("id", "=", id)
        .where("owner_id", "=", userId)
        .executeTakeFirstOrThrow();
      if (catalog.prices.get(opened.price_id)?.usd !== body.price) {
        await billing.cancelCheckout(userId);
        return c.json({ message: PRICE_CHANGED }, 409);
      }
      // Recorded before the URL is answered, for the Price the buyer was shown.
      await run(
        billing.db,
        `INSERT INTO public.dormouse_checkout_consents ("checkoutId", "termsVersion", "userId", plan, "priceId")
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [id, TERMS_VERSION, userId, plan, opened.price_id],
      );
      recordMetric(c, host(c).databaseUrl, "checkout.started", `${plan}:${ref}`);
      return c.json({ url });
    });
  });

  app.post("/api/billing/confirm", smallBody(JSON_BODY_BYTES), gate, async (c) => {
    const { userId } = c.get("login");
    const checkout = (await readJson<{ checkout?: unknown }>(c))?.checkout;
    if (typeof checkout !== "string" || !CHECKOUT_ID.test(checkout))
      return c.json({ message: "Checkout not found." }, 404);
    return billed(c, async (billing, setup, catalog) => {
      await billing.confirmCheckout(userId, checkout);
      return summary(c, billing, setup, catalog, userId);
    });
  });

  app.post("/api/billing/portal", smallBody(JSON_BODY_BYTES), gate, (c) =>
    billed(c, async (billing) => c.json({ url: await billing.portal(c.get("login").userId) })),
  );

  // An EEA or UK consumer's withdrawal from the contract it names, which must
  // be the held subscription the page offers it for. Recorded before the
  // answer, it stands: an acknowledgement or a settlement that fails after is
  // logged, and the cron finishes it. Naming a contract already withdrawn
  // from answers that withdrawal again.
  app.post("/api/billing/withdraw", smallBody(JSON_BODY_BYTES), gate, async (c) => {
    const { userId } = c.get("login");
    const subscription = (await readJson<{ subscription?: unknown }>(c))?.subscription;
    if (typeof subscription !== "string" || !SUBSCRIPTION_ID.test(subscription))
      return c.json({ message: "Choose the contract to withdraw from." }, 400);
    return billed(c, async (billing, setup, catalog) => {
      let row = await recordedWithdrawal(billing, userId, subscription);
      if (!row) {
        const { subscription: held, plan } = await billing.status(userId);
        const offer = held?.id === subscription && plan ? await withdrawalOffer(billing, userId, held) : null;
        if (!offer || held?.id !== subscription || !plan) return c.json({ message: WITHDRAWAL_CLOSED }, 409);
        row = await recordWithdrawal(billing, userId, plan, held, offer);
      }
      await completeWithdrawal(billing, () => host(c).mail(), row).catch((error: unknown) =>
        console.error(`Withdrawal ${row.id} is recorded but not complete; the cron retries it`, error),
      );
      return summary(c, billing, setup, catalog, userId);
    });
  });

  // The founders row: shown under `name` only while a founding subscription
  // grants access. Leaving it needs nothing from billing, so it works while
  // billing is closed or failing, and answers 204.
  app.put("/api/billing/founder", smallBody(JSON_BODY_BYTES), gate, async (c) => {
    const { userId } = c.get("login");
    const body = await readJson<{ shown?: unknown; name?: unknown }>(c);
    const shown = body?.shown;
    const name = body?.name;
    if (typeof shown !== "boolean" || (shown && !isFounderName(name)))
      return c.json({ message: "Choose a name of 1 to 64 characters." }, 400);
    if (!shown) {
      await accountQuery(host(c), `DELETE FROM dormouse_founders WHERE "userId" = $1`, [userId]);
      return c.body(null, 204);
    }
    return billed(c, async (billing, setup, catalog) => {
      const joined = await accountQuery(
        host(c),
        `INSERT INTO dormouse_founders ("userId", name)
        SELECT $1, $2 WHERE ${subscribedSql("$1::text", "$3::text[]")}
        ON CONFLICT ("userId") DO UPDATE SET name = EXCLUDED.name
        RETURNING "userId"`,
        [userId, name, setup.founding],
      );
      if (!joined.length) return c.json({ message: FOUNDERS_ONLY }, 409);
      return summary(c, billing, setup, catalog, userId);
    });
  });

  // Stripe's: the raw body under its signature, 2xx only once `webhook()` has
  // committed; any other failure throws to `onError`'s 503, which Stripe retries.
  app.post(BILLING_WEBHOOK_PATH, smallBody(WEBHOOK_BODY_BYTES), async (c) => {
    const signature = c.req.header("stripe-signature");
    if (!signature) return c.json({ message: "Missing signature." }, 400);
    const body = await c.req.text();
    return billed(c, async (billing, _setup, catalog) => {
      await processEvent(billing, body, signature, () => host(c).mail(), { catalog, origin: new URL(c.req.url).origin });
      return c.json({ received: true });
    });
  });
}

/** The owner of Stripe customer `customer`, or null for one pgstencil did not create. */
async function ownerOf(billing: Billing<Plan>, customer: string | Stripe.Customer | Stripe.DeletedCustomer | null) {
  const id = idOf(customer);
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
 * the counts, dispute suspensions, and their notices' records, so a
 * redelivery repeats none. A full refund or a lost dispute then ends the
 * subscription in Stripe, after the commit and on every delivery until it
 * has; a dispute's notice is then sent, and the cron retries one that fails.
 */
async function processEvent(
  billing: Billing<Plan>,
  body: string,
  signature: string,
  mail: () => EmailSender,
  context: NoticeContext,
) {
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
      countMetricInTransaction((text, values) => run(trx, text, values), event, label);
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
    if (dispute?.owner) await recordDispute(trx, dispute.id, dispute.owner, dispute.action, billing.time.now());
  });
  const refunded = event.type === "charge.refunded" ? (event.data.object as Stripe.Charge) : null;
  const reversed = refunded?.refunded ? refunded : dispute?.action === "end" ? dispute.charge : null;
  if (reversed) await endForRefund(billing, reversed);
  if (dispute?.owner)
    for (const error of await sendNotices(billing, mail, context, { userId: dispute.owner }))
      console.error("A dispute notice is recorded but not sent; the cron retries it", error);
}

/**
 * The subscription `charge` paid for, through its invoice: the pinned API
 * version's charge names no invoice, so the invoice payments of its
 * PaymentIntent do. Null when that names no one subscription.
 */
async function subscriptionPaidBy(billing: Billing<Plan>, charge: Stripe.Charge): Promise<string | null> {
  const intent = idOf(charge.payment_intent);
  if (!intent) return null;
  const payments = await billing.stripe.invoicePayments.list({
    payment: { type: "payment_intent", payment_intent: intent },
    expand: ["data.invoice"],
  });
  const paid = new Set(
    payments.data.flatMap((payment) => {
      const subscription = idOf((payment.invoice as Stripe.Invoice).parent?.subscription_details?.subscription);
      return subscription ? [subscription] : [];
    }),
  );
  return paid.size === 1 ? [...paid][0]! : null;
}

/**
 * Opens or closes dispute `disputeId`'s suspension of `owner`, as `action`
 * says, recording the notice it owes in the same statement: opening it, its
 * suspension notice; closing it in the account's favor, its restoration
 * notice, unless another open dispute still suspends the account.
 */
async function recordDispute(
  trx: Kysely<BillingDB>,
  disputeId: string,
  owner: string,
  action: ReturnType<typeof disputeAction>,
  now: Date,
) {
  if (action === "suspend")
    await run(
      trx,
      `WITH opened AS (
        INSERT INTO public.dormouse_billing_disputes ("disputeId", "userId") VALUES ($1, $2)
        ON CONFLICT ("disputeId") DO NOTHING RETURNING "userId")
      INSERT INTO public.dormouse_billing_notices (id, "userId", kind, "disputeId", "createdAt")
      SELECT gen_random_uuid()::text, "userId", 'dispute_suspended', $1, $3 FROM opened
      ON CONFLICT DO NOTHING`,
      [disputeId, owner, now],
    );
  else if (action)
    // The statement reads the table as it was before its own delete.
    await run(
      trx,
      `WITH closed AS (
        DELETE FROM public.dormouse_billing_disputes WHERE "disputeId" = $1 RETURNING "userId")
      INSERT INTO public.dormouse_billing_notices (id, "userId", kind, "disputeId", "createdAt")
      SELECT gen_random_uuid()::text, "userId", 'dispute_restored', $1, $2 FROM closed
      WHERE $3 AND NOT EXISTS (
        SELECT FROM public.dormouse_billing_disputes other
        WHERE other."userId" = closed."userId" AND other."disputeId" <> $1)
      ON CONFLICT DO NOTHING`,
      [disputeId, now, action === "restore"],
    );
}

/** How many open disputes one cron run reads from Stripe at most. */
const DISPUTE_RESYNC_BATCH = 20;

/**
 * The cron's dispute pass, so a missed close event never suspends an account
 * for good: reads the current status of up to {@link DISPUTE_RESYNC_BATCH}
 * open disputes from Stripe, least recently checked first, and acts on each
 * as its webhook would. A lost one ends its subscription before its row
 * goes, so a failed end is retried; one closed either way records its
 * restoration notice as the webhook does, which the notice pass then sends.
 * Answers the failures.
 */
export async function resyncDisputes(billing: Billing<Plan>): Promise<unknown[]> {
  const rows = await run<{ disputeId: string; userId: string }>(
    billing.db,
    `SELECT "disputeId", "userId" FROM public.dormouse_billing_disputes
    ORDER BY "checkedAt" NULLS FIRST, "openedAt" LIMIT $1`,
    [DISPUTE_RESYNC_BATCH],
  );
  const failed: unknown[] = [];
  for (const { disputeId, userId } of rows)
    try {
      const current = await billing.stripe.disputes.retrieve(disputeId, { expand: ["charge"] });
      const action = disputeAction(current.status);
      if (action === "end") await endForRefund(billing, current.charge as Stripe.Charge);
      await billing.db.transaction().execute(async (trx) => {
        const now = billing.time.now();
        await run(trx, `UPDATE public.dormouse_billing_disputes SET "checkedAt" = $2 WHERE "disputeId" = $1`, [
          disputeId,
          now,
        ]);
        if (action !== "suspend") await recordDispute(trx, disputeId, userId, action, now);
      });
    } catch (error) {
      failed.push(error);
    }
  return failed;
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
