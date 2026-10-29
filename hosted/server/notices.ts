// Rules: docs/specs/hosted.md -> "Billing notices"; docs/specs/pricing.md ->
// "Checkout and entitlement".
import type { Billing, Stripe } from "@pgstencil/stripe";
import { escape } from "@pgstencil/auth/email";
import type { EmailMessage, EmailSender } from "pgstencil";
import { PLAN_NAMES, planInterval } from "../../website/src/lib/hosted-pricing";
import { DIFFPLUG_POSTAL_ADDRESS, SUPPORT_EMAIL } from "../../website/src/lib/hosted-withdrawal";
import { DAY_MS, run, type PriceCatalog, type PriceChange } from "./billing";
import { BILLING_RETURN_PATH, type Plan } from "./policy-constants";
import { billingContact } from "./withdrawal";

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
/** How long the cron retries a dispute notice. */
const DISPUTE_RETRY_DAYS = 30;
/** One send attempt holds its notice this long before another may try it. */
const LEASE_MS = 5 * 60 * 1000;
/** How many notices one pass sends, and how many price changes it applies, at most. */
const BATCH = 50;

/** Prices a Stripe client confirmed, by id, amount, interval, and mode: Stripe never changes a Price's amount or interval. */
const confirmedPrices = new WeakMap<Stripe, Set<string>>();

/** Throws unless Stripe holds both of `change`'s Prices at its amounts, in USD, per its plan's interval. */
async function verifyChange(billing: Billing<Plan>, change: PriceChange) {
  const interval = planInterval(change.plan);
  let confirmed = confirmedPrices.get(billing.stripe);
  if (!confirmed) confirmedPrices.set(billing.stripe, (confirmed = new Set()));
  for (const [id, usd] of [
    [change.fromPriceId, change.fromUsd],
    [change.toPriceId, change.toUsd],
  ] as const) {
    const key = `${id} ${usd} ${interval} ${billing.config.live}`;
    if (confirmed.has(key)) continue;
    const price = await billing.stripe.prices.retrieve(id);
    if (
      price.currency !== "usd" ||
      price.unit_amount !== usd * 100 ||
      price.recurring?.interval !== interval ||
      price.recurring.interval_count !== 1 ||
      price.livemode !== billing.config.live
    )
      throw new Error(`Price change ${change.id}: Stripe's ${id} is not ${usd} USD every ${interval}`);
    confirmed.add(key);
  }
}

type Kind = "renewal" | "annual" | "price_change" | "dispute_suspended" | "dispute_restored";

/** A notice to send, with what its text needs. */
interface Pending {
  id: string;
  userId: string;
  kind: Kind;
  renewsAt: Date | null;
  priceId: string | null;
  priceChangeId: string | null;
}

/** What composing a notice reads beyond its row. */
export interface NoticeContext {
  catalog: PriceCatalog;
  /** The account origin, whose billing page a notice links. */
  origin: string;
}

const DAY = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

/** The email for notice `notice`, to the billing email `to`. */
function noticeMessage(to: string, notice: Pending, plan: Plan | null, context: NoticeContext): EmailMessage {
  const billingPage = new URL(BILLING_RETURN_PATH, context.origin).href;
  const name = plan ? PLAN_NAMES[plan] : "Dormouse Hosted";
  const interval = plan ? planInterval(plan) : null;
  const usd = notice.priceId ? (context.catalog.prices.get(notice.priceId)?.usd ?? null) : null;
  const on = notice.renewsAt ? DAY.format(notice.renewsAt) : "";
  const cancel = `To stop it renewing, cancel before ${on} in Manage billing on your billing page: ${billingPage}. You keep Hosted until ${on}. If you cannot sign in, email ${SUPPORT_EMAIL} and we will cancel it for you.`;
  const yearlyRefund = `Ask within 30 days of a yearly renewal payment and we refund it in full, including tax.`;
  const help = `Questions: ${SUPPORT_EMAIL}.`;
  let subject: string;
  let paragraphs: string[];
  switch (notice.kind) {
    case "renewal":
      subject = `Your Dormouse Hosted subscription renews on ${on}`;
      paragraphs = [
        `Your ${name} subscription renews automatically on ${on}${usd ? `, for another year at $${usd} plus any applicable tax, charged to your payment method on file` : ", for another year"}.`,
        cancel,
        yearlyRefund,
        help,
      ];
      break;
    case "annual":
      subject = "Your yearly reminder about your Dormouse Hosted subscription";
      paragraphs = [
        `This is your yearly reminder that your ${name} subscription renews automatically every month${usd ? ` at $${usd} plus any applicable tax, charged to your payment method on file` : ""}, until you cancel. Your next renewal is on ${on}.`,
        `To cancel, use Manage billing on your billing page: ${billingPage}. You keep Hosted until the end of the month you paid for. If you cannot sign in, email ${SUPPORT_EMAIL} and we will cancel it for you.`,
        help,
      ];
      break;
    case "price_change": {
      const change = context.catalog.usable.find((candidate) => candidate.id === notice.priceChangeId)!;
      subject = `Your Dormouse Hosted price changes on ${on}`;
      paragraphs = [
        `The price of your ${name} subscription changes from $${change.fromUsd} to $${change.toUsd} a ${interval}, plus any applicable tax, starting with your renewal on ${on}. Nothing changes before then.`,
        `If you do not want to pay the new price, ${cancel.charAt(0).toLowerCase()}${cancel.slice(1)}`,
        ...(interval === "year" ? [yearlyRefund] : []),
        help,
      ];
      break;
    }
    case "dispute_suspended":
      subject = "Dormouse Hosted is paused during a payment dispute";
      paragraphs = [
        "A payment for your Dormouse Hosted subscription is being disputed with your bank or card provider. While the dispute is open, we have paused the paid features it covers, Natural Voice and the Hosted Relay. Your subscription is not cancelled, and Dormouse keeps working, with spoken alarms in your system voice.",
        "If the disputed payment is restored, or the pause was a mistake, we restore your remaining paid access and any founding price you held. If the payment is finally reversed, we may end the access it paid for and stop future renewals.",
        `This does not limit your right to dispute a charge, or any refund or remedy owed to you. To reach us about the dispute, email ${SUPPORT_EMAIL}.`,
      ];
      break;
    case "dispute_restored":
      subject = "Your Dormouse Hosted access is restored";
      paragraphs = [
        "The payment dispute on your Dormouse Hosted subscription has closed with the payment in place, and we have restored your paid access. Your subscription continues as before, including any founding price you held.",
        `This does not limit any refund or remedy owed to you. ${help}`,
      ];
      break;
  }
  paragraphs.push(DIFFPLUG_POSTAL_ADDRESS);
  return {
    from: `Dormouse Hosted <${SUPPORT_EMAIL}>`,
    to: [to],
    replyTo: SUPPORT_EMAIL,
    subject,
    text: paragraphs.join("\n\n"),
    html: `<html lang="en"><body>${paragraphs.map((paragraph) => `<p>${escape(paragraph)}</p>`).join("")}</body></html>`,
  };
}

/**
 * Sends each unsent notice that still applies, up to {@link BATCH}, to its
 * billing email, and stamps it sent; `userId` narrows it to one account's.
 * A renewal-type notice still applies while its subscription renews at that
 * renewal, a price change's only while it is further off than
 * {@link PRICE_SEND_BY_DAYS} and its change is among `verified`; a suspension
 * while its dispute is open; a dispute notice for {@link DISPUTE_RETRY_DAYS}.
 * Each is leased before it is sent, so two passes never send one twice.
 * Never-tried notices go first, then the least recently tried, so ones that
 * keep failing never starve newer ones past their deadlines. Answers the
 * failures.
 */
export async function sendNotices(
  billing: Billing<Plan>,
  mail: () => EmailSender,
  context: NoticeContext,
  { userId = null, verified = [] }: { userId?: string | null; verified?: readonly string[] } = {},
): Promise<unknown[]> {
  const now = billing.time.now();
  const pending = await run<Pending>(
    billing.db,
    `SELECT n.id, n."userId", n.kind, n."renewsAt", s.price_id AS "priceId", n."priceChangeId"
    FROM public.dormouse_billing_notices n
    LEFT JOIN pgstencil_billing.subscriptions s ON s.id = n."subscriptionId"
    LEFT JOIN public.dormouse_price_changes c ON c.id = n."priceChangeId"
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
        ELSE n."createdAt" > $4
      END
    ORDER BY n."attemptedAt" NULLS FIRST, n."createdAt", n.id LIMIT $5`,
    [
      now,
      new Date(now.getTime() - LEASE_MS),
      userId,
      new Date(now.getTime() - DISPUTE_RETRY_DAYS * DAY_MS),
      BATCH,
      verified,
      PRICE_SEND_BY_DAYS,
    ],
  );
  const failed: unknown[] = [];
  for (const notice of pending)
    try {
      const [leased] = await run(
        billing.db,
        `UPDATE public.dormouse_billing_notices SET "attemptedAt" = $2
        WHERE id = $1 AND "sentAt" IS NULL AND ("attemptedAt" IS NULL OR "attemptedAt" < $3) RETURNING id`,
        [notice.id, billing.time.now(), new Date(billing.time.now().getTime() - LEASE_MS)],
      );
      if (!leased) continue;
      const email = (await billingContact(billing, notice.userId))?.email;
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
 * moves no one. Answers the failures.
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
  failed.push(...(await applyPriceChanges(billing, verified)));
  return failed;
}
