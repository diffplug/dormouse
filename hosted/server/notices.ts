// Rules: docs/specs/hosted.md -> "Billing notices"; docs/specs/pricing.md ->
// "Checkout and entitlement".
import type { Billing, Stripe } from "@pgstencil/stripe";
import { postmarkEmail } from "@pgstencil/auth/postmark";
import type { EmailSender } from "pgstencil";
import { planInterval } from "../../website/src/lib/hosted-pricing";
import { DAY_MS, run, stripeHoldsPrice, type PriceCatalog, type PriceChange } from "./billing";
import { BillingOverdue } from "./billing-alert";
import { NOTICE_FROM, noticeMessage, type NoticeContext, type Pending } from "./notice-message";
import type { Plan } from "./policy-constants";
import { billingContact, type Contact } from "./withdrawal";

/** The mail a notice goes by: Postmark sends the address it is built with, whatever a message names. */
export const noticeMail = (token: string): EmailSender => postmarkEmail(token, NOTICE_FROM);

/**
 * A yearly plan's renewal notice, and a monthly plan's annual reminder, are
 * due this many days before the renewal they precede: inside California's
 * 15 to 45 days for an annual term's renewal notice.
 */
export const RENEWAL_NOTICE_DAYS = 30;
/**
 * A price change's notice is due this many days before the renewal it first
 * applies at: inside California's 7 to 30 days before a fee change.
 */
export const PRICE_NOTICE_DAYS = 21;
/**
 * A price change applies at a renewal only after its notice was sent at least
 * this many days before it; later, the change waits for the next renewal and
 * its own notice. Migration 018's CHECK repeats it.
 */
export const PRICE_NOTICE_MIN_DAYS = 7;
/**
 * A price-change notice is sent only while its renewal is further off than
 * this, so the send finishes before {@link PRICE_NOTICE_MIN_DAYS} with a day to
 * spare and never announces a change that then cannot apply.
 */
const PRICE_SEND_BY_DAYS = PRICE_NOTICE_MIN_DAYS + 1;
/** How long the cron retries a dispute notice, stale past it; a withdrawal's acknowledgement and a purchase's confirmation it retries until sent. */
const RETRY_DAYS = 30;
/** A withdrawal's acknowledgement still unsent this many days after its withdrawal fails every cron run until it goes. */
const ACKNOWLEDGEMENT_OVERDUE_DAYS = 1;
/** One send attempt holds its notice this long before another may try it. */
const LEASE_MS = 5 * 60 * 1000;
/** How many notices one pass sends, and how many price changes it applies, at most. */
const BATCH = 50;

/** Throws unless Stripe holds both of `change`'s Prices at its amounts, in USD, per its plan's interval. */
async function verifyChange(billing: Billing<Plan>, change: PriceChange) {
  for (const [id, usd] of [
    [change.fromPriceId, change.fromUsd],
    [change.toPriceId, change.toUsd],
  ] as const)
    if (!(await stripeHoldsPrice(billing, id, usd, change.plan)))
      throw new Error(`Price change ${change.id}: Stripe's ${id} is not ${usd} USD every ${planInterval(change.plan)}`);
}

/**
 * Sends each unsent notice that still applies, up to {@link BATCH}, to its
 * billing email, and stamps it sent; `userId` narrows it to one account's.
 * A renewal-type notice still applies while its subscription renews at that
 * renewal, a price change's only while it is further off than
 * {@link PRICE_SEND_BY_DAYS} and its change is among `verified`; a suspension
 * while its dispute is open; a dispute notice for {@link RETRY_DAYS}; a
 * withdrawal's acknowledgement and a purchase's confirmation until sent.
 * The batch is leased in the statement that picks it, so two passes never
 * send one twice. Never-tried notices go first, then the least recently
 * tried, so ones that keep failing never starve newer ones past their
 * deadlines. Each account's contact is read from Stripe once per pass;
 * `contacts` may hold one its caller just read. Answers the failures.
 */
export async function sendNotices(
  billing: Billing<Plan>,
  mail: () => EmailSender,
  context: NoticeContext,
  {
    userId = null,
    verified = [],
    contacts = new Map(),
  }: { userId?: string | null; verified?: readonly string[]; contacts?: Map<string, Contact> } = {},
): Promise<unknown[]> {
  const now = billing.time.now();
  const leased = await run<Pending>(
    billing.db,
    `WITH due AS (
      SELECT n.id, s.price_id AS "priceId", w.plan AS "withdrawalPlan", w."contractStartedAt", w."submittedAt",
        k.plan AS "consentPlan", k."shownUsd", k."termsVersion", k."consentedAt"
      FROM public.dormouse_billing_notices n
      LEFT JOIN pgstencil_billing.subscriptions s ON s.id = n."subscriptionId"
      LEFT JOIN public.dormouse_price_changes c ON c.id = n."priceChangeId"
      LEFT JOIN public.dormouse_withdrawals w ON w.id = n."withdrawalId"
      -- A checkout reused across a terms change holds one consent per version.
      LEFT JOIN LATERAL (
        SELECT * FROM public.dormouse_checkout_consents consent WHERE consent."checkoutId" = n."checkoutId"
        ORDER BY consent."consentedAt" DESC LIMIT 1) k ON true
      WHERE n."sentAt" IS NULL AND (n."attemptedAt" IS NULL OR n."attemptedAt" < $2)
        AND ($3::text IS NULL OR n."userId" = $3)
        AND CASE
          WHEN n.kind IN ('renewal', 'annual') THEN
            s.status = 'active' AND NOT s.cancel_at_period_end AND s.period_end = n."renewsAt" AND n."renewsAt" > $1::timestamptz
          WHEN n.kind = 'price_change' THEN
            s.status = 'active' AND NOT s.cancel_at_period_end AND s.period_end = n."renewsAt"
            AND s.price_id = c."fromPriceId" AND c.id = ANY ($6::text[])
            AND n."renewsAt" > $1::timestamptz + make_interval(days => $7)
          WHEN n.kind = 'dispute_suspended' THEN
            n."createdAt" > $4
            AND EXISTS (SELECT FROM public.dormouse_billing_disputes d WHERE d."disputeId" = n."disputeId")
          WHEN n.kind = 'dispute_restored' THEN n."createdAt" > $4
          ELSE n.kind IN ('withdrawal', 'purchase')
        END
      ORDER BY n."attemptedAt" NULLS FIRST, n."createdAt", n.id LIMIT $5
      FOR UPDATE OF n SKIP LOCKED)
    UPDATE public.dormouse_billing_notices n SET "attemptedAt" = $1 FROM due WHERE n.id = due.id
    RETURNING n.id, n."userId", n.kind, n."renewsAt", due."priceId", n."priceChangeId",
      n."withdrawalId", due."withdrawalPlan", due."contractStartedAt", due."submittedAt",
      due."consentPlan", due."shownUsd", due."termsVersion", due."consentedAt"`,
    [
      now,
      new Date(now.getTime() - LEASE_MS),
      userId,
      new Date(now.getTime() - RETRY_DAYS * DAY_MS),
      BATCH,
      verified,
      PRICE_SEND_BY_DAYS,
    ],
  );
  const failed: unknown[] = [];
  for (const notice of leased)
    try {
      if (!contacts.has(notice.userId)) contacts.set(notice.userId, await billingContact(billing, notice.userId));
      const email = contacts.get(notice.userId)?.email;
      if (!email) throw new Error(`Notice ${notice.id}: Stripe gave no billing email to send it to`);
      await mail().send(noticeMessage(email, notice, billing.planOf(notice.priceId), context));
      await run(billing.db, `UPDATE public.dormouse_billing_notices SET "sentAt" = $2, email = $3 WHERE id = $1`, [
        notice.id,
        billing.time.now(),
        email,
      ]);
    } catch (error) {
      failed.push(error);
    }
  return failed;
}

/**
 * Moves each subscription whose price-change notice was sent at least
 * {@link PRICE_NOTICE_MIN_DAYS} before the renewal it named, and still
 * renews then on the change's old Price, to the new Price, without
 * proration, so that renewal is the first to charge it. Stripe's own copy is
 * checked first. Answers the failures.
 */
async function applyPriceChanges(billing: Billing<Plan>, verified: readonly string[]): Promise<unknown[]> {
  const now = billing.time.now();
  const due = await run<{ id: string; userId: string; subscriptionId: string; renewsAt: Date; fromPriceId: string; toPriceId: string }>(
    billing.db,
    `SELECT n.id, n."userId", n."subscriptionId", n."renewsAt", c."fromPriceId", c."toPriceId"
    FROM public.dormouse_billing_notices n
    JOIN pgstencil_billing.subscriptions s ON s.id = n."subscriptionId"
    JOIN public.dormouse_price_changes c ON c.id = n."priceChangeId"
    WHERE n.kind = 'price_change' AND n."appliedAt" IS NULL
      AND n."sentAt" <= n."renewsAt" - make_interval(days => $2)
      AND c.id = ANY ($3::text[])
      AND s.price_id = c."fromPriceId" AND s.period_end = n."renewsAt"
      AND s.status = 'active' AND NOT s.cancel_at_period_end AND n."renewsAt" > $1::timestamptz
    ORDER BY n."renewsAt", n.id LIMIT $4`,
    [now, PRICE_NOTICE_MIN_DAYS, verified, BATCH],
  );
  const failed: unknown[] = [];
  for (const notice of due)
    try {
      const subscription = await billing.stripe.subscriptions.retrieve(notice.subscriptionId);
      const item = subscription.items.data[0];
      if (
        subscription.items.data.length !== 1 ||
        item?.price.id !== notice.fromPriceId ||
        item.current_period_end * 1000 !== notice.renewsAt.getTime() ||
        subscription.status !== "active" ||
        subscription.cancel_at_period_end
      ) {
        // Stripe has moved on; the synchronized row catches up.
        await billing.reconcile(notice.userId);
        continue;
      }
      await billing.stripe.subscriptions.update(
        notice.subscriptionId,
        { items: [{ id: item.id, price: notice.toPriceId }], proration_behavior: "none" },
        { idempotencyKey: `dormouse-price-change-${notice.id}` },
      );
      await billing.reconcile(notice.userId);
      await run(billing.db, `UPDATE public.dormouse_billing_notices SET "appliedAt" = $2 WHERE id = $1`, [
        notice.id,
        billing.time.now(),
      ]);
    } catch (error) {
      failed.push(error);
    }
  return failed;
}

/**
 * The cron's notice pass: records each renewal notice, annual reminder, and
 * price-change notice that has come due, sends every unsent one that still
 * applies, then applies each price change whose notice went out in time.
 * A refused change, or one Stripe's Prices contradict, gets no notice and
 * moves no one. Answers the failures, and one more while any withdrawal's
 * acknowledgement is overdue ({@link ACKNOWLEDGEMENT_OVERDUE_DAYS}).
 */
export async function runNotices(
  billing: Billing<Plan>,
  catalog: PriceCatalog,
  mail: () => EmailSender,
): Promise<unknown[]> {
  const failed: unknown[] = [];
  const now = billing.time.now();
  const { usable, refused } = catalog;
  for (const change of refused)
    failed.push(new Error(`Price change ${change.id} names a founding Price or another plan's; it is ignored`));
  // Checked against Stripe only while someone is still on its old Price.
  const held = await run<{ price: string }>(
    billing.db,
    `SELECT DISTINCT price_id AS price FROM pgstencil_billing.subscriptions
    WHERE price_id = ANY ($1::text[]) AND status = 'active'`,
    [usable.map((change) => change.fromPriceId)],
  );
  const verified: string[] = [];
  for (const change of usable.filter((change) => held.some(({ price }) => price === change.fromPriceId)))
    await verifyChange(billing, change).then(
      () => verified.push(change.id),
      (error: unknown) => failed.push(error),
    );
  // A yearly term's renewal notice is its annual reminder too; a monthly
  // plan's is due before each renewal that ends a year of the subscription.
  await run(
    billing.db,
    `INSERT INTO public.dormouse_billing_notices (id, "userId", kind, "subscriptionId", "renewsAt", "createdAt")
    SELECT gen_random_uuid()::text, s.owner_id, CASE WHEN s.price_id = ANY ($2::text[]) THEN 'renewal' ELSE 'annual' END,
      s.id, s.period_end, $1
    FROM pgstencil_billing.subscriptions s,
      LATERAL (SELECT (extract(year FROM s.period_end AT TIME ZONE 'UTC') - extract(year FROM s.started_at AT TIME ZONE 'UTC')) * 12
        + extract(month FROM s.period_end AT TIME ZONE 'UTC') - extract(month FROM s.started_at AT TIME ZONE 'UTC') AS months) term
    WHERE s.status = 'active' AND NOT s.cancel_at_period_end
      AND s.period_end > $1::timestamptz AND s.period_end <= $1::timestamptz + make_interval(days => $4)
      AND (s.price_id = ANY ($2::text[]) OR (s.price_id = ANY ($3::text[]) AND term.months >= 12 AND mod(term.months, 12) = 0))
    ON CONFLICT DO NOTHING`,
    [now, [...catalog.recognized("yearly"), ...catalog.recognized("founding")], catalog.recognized("monthly"), RENEWAL_NOTICE_DAYS],
  );
  // A price change's notice, for the first renewal on or after its date that
  // is still far enough off for the notice to count.
  await run(
    billing.db,
    `INSERT INTO public.dormouse_billing_notices
      (id, "userId", kind, "subscriptionId", "renewsAt", "priceChangeId", "createdAt")
    SELECT gen_random_uuid()::text, s.owner_id, 'price_change', s.id, s.period_end, c.id, $1
    FROM pgstencil_billing.subscriptions s JOIN public.dormouse_price_changes c ON c."fromPriceId" = s.price_id
    WHERE c.id = ANY ($2::text[]) AND s.status = 'active' AND NOT s.cancel_at_period_end
      AND s.period_end >= c."effectiveAt"
      AND s.period_end > $1::timestamptz + make_interval(days => $3) AND s.period_end <= $1::timestamptz + make_interval(days => $4)
    ON CONFLICT DO NOTHING`,
    [now, verified, PRICE_SEND_BY_DAYS, PRICE_NOTICE_DAYS],
  );
  failed.push(...(await sendNotices(billing, mail, { catalog, origin: billing.config.origin }, { verified })));
  const [overdue] = await run<{ ids: string[] | null }>(
    billing.db,
    `SELECT array_agg("withdrawalId" ORDER BY "createdAt") AS ids FROM public.dormouse_billing_notices
    WHERE kind = 'withdrawal' AND "sentAt" IS NULL AND "createdAt" <= $1`,
    [new Date(now.getTime() - ACKNOWLEDGEMENT_OVERDUE_DAYS * DAY_MS)],
  );
  if (overdue?.ids) failed.push(new BillingOverdue(`Withdrawal acknowledgement unsent after a day: withdrawal ${overdue.ids.join(", ")}`));
  failed.push(...(await applyPriceChanges(billing, verified)));
  return failed;
}
