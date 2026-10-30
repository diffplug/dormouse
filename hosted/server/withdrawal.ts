// Rules: docs/specs/hosted.md -> "Billing"; docs/specs/pricing.md ->
// "Checkout and entitlement".
import { SUBSCRIBED, type Billing, type Stripe } from "@pgstencil/stripe";
import { DAY_MS, END_REASONS, idOf, run } from "./billing";
import type { WithdrawalOffer } from "./billing-summary";
import type { Plan } from "./policy-constants";

/**
 * How long after a subscription starts the online withdrawal stays open. The
 * statutory period ends at the end of the 14th day after the contract, in
 * the consumer's time zone, and later when that day is a weekend or public
 * holiday; three weeks outlasts every such end.
 */
export const WITHDRAWAL_OPEN_DAYS = 21;

/**
 * Billing countries whose consumers hold the EEA or UK withdrawal right: the
 * EU's members and its outermost regions Stripe lists apart, Iceland,
 * Liechtenstein, Norway, and the United Kingdom, plus the Crown Dependencies
 * and Gibraltar, offered rather than ruled out. A customer with no country
 * is offered it too.
 */
const WITHDRAWAL_COUNTRIES: ReadonlySet<string> = new Set([
  ...["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU"],
  ...["LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"],
  ...["AX", "GF", "GP", "MF", "MQ", "RE", "YT"],
  ...["IS", "LI", "NO"],
  ...["GB", "GG", "GI", "IM", "JE"],
]);

type Held = NonNullable<Awaited<ReturnType<Billing<Plan>["status"]>>["subscription"]>;

/** The online withdrawal the billing page offers for the held subscription, and the billing country it was offered for. */
type Offer = WithdrawalOffer & { country: string | null };

/** A recorded withdrawal, as `dormouse_withdrawals` holds it. */
export interface WithdrawalRow {
  id: string;
  userId: string;
  subscriptionId: string;
  plan: string;
  contractStartedAt: Date;
  submittedAt: Date;
  settledAt: Date | null;
}

/** How long the billing page reuses a customer's contact Stripe answered, per isolate and Stripe client. */
const CONTACT_CACHE_MS = 10 * 60 * 1000;

/** A Stripe customer's billing email and address country; null when Stripe cannot say. */
export type Contact = { email: string | null; country: string | null } | null;
const contacts = new WeakMap<Stripe, Map<string, { at: number; contact: Contact }>>();

/**
 * The Stripe customer's billing email and address country, or null when
 * Stripe cannot say. `cached` reuses an answer Stripe gave within
 * {@link CONTACT_CACHE_MS}, for the billing page's reads; what sends mail or
 * refuses a withdrawal reads Stripe fresh.
 */
export async function billingContact(billing: Billing<Plan>, ownerId: string, { cached = false } = {}): Promise<Contact> {
  const customerId = await billing.customerOf(ownerId);
  if (!customerId) return null;
  const now = billing.time.now().getTime();
  let known = contacts.get(billing.stripe);
  if (!known) contacts.set(billing.stripe, (known = new Map()));
  const hit = known.get(customerId);
  if (cached && hit && now - hit.at < CONTACT_CACHE_MS) return hit.contact;
  try {
    const customer = await billing.stripe.customers.retrieve(customerId);
    const contact = customer.deleted
      ? null
      : { email: customer.email ?? null, country: customer.address?.country?.toUpperCase() ?? null };
    known.set(customerId, { at: now, contact });
    return contact;
  } catch (error) {
    console.warn(`Reading Stripe customer ${customerId} failed`, error);
    return null;
  }
}

/**
 * The online withdrawal from `subscription`, or null: offered while it is
 * current, within {@link WITHDRAWAL_OPEN_DAYS} of its start, and its billing
 * country is in {@link WITHDRAWAL_COUNTRIES} or unknown, a Stripe that cannot
 * say included; `cached` as {@link billingContact} takes it. Whether it was
 * withdrawn already is the caller's.
 */
export async function withdrawalOffer(
  billing: Billing<Plan>,
  ownerId: string,
  subscription: Held | null,
  { cached = false } = {},
): Promise<Offer | null> {
  if (!subscription?.started_at || !SUBSCRIBED.includes(subscription.status)) return null;
  const startedAt = new Date(subscription.started_at);
  const until = new Date(startedAt.getTime() + WITHDRAWAL_OPEN_DAYS * DAY_MS);
  if (billing.time.now() >= until) return null;
  const contact = await billingContact(billing, ownerId, { cached });
  if (contact?.country && !WITHDRAWAL_COUNTRIES.has(contact.country)) return null;
  return {
    subscription: subscription.id,
    startedAt: startedAt.toISOString(),
    until: until.toISOString(),
    email: contact?.email ?? null,
    country: contact?.country ?? null,
  };
}

const COLUMNS = `id, "userId", "subscriptionId", plan, "contractStartedAt", "submittedAt", "settledAt"`;

/** The withdrawal recorded from `subscriptionId` by `ownerId`, if any. */
export async function recordedWithdrawal(billing: Billing<Plan>, ownerId: string, subscriptionId: string) {
  const [row] = await run<WithdrawalRow>(
    billing.db,
    `SELECT ${COLUMNS} FROM public.dormouse_withdrawals WHERE "subscriptionId" = $1 AND "userId" = $2`,
    [subscriptionId, ownerId],
  );
  return row ?? null;
}

/**
 * Records `ownerId`'s withdrawal from `subscription` under `offer`, submitted
 * now, and in the same statement its acknowledgement, a `withdrawal` notice
 * the notice pass sends; answers the row, and a second submission the first's.
 */
export async function recordWithdrawal(
  billing: Billing<Plan>,
  ownerId: string,
  plan: Plan,
  subscription: Held,
  offer: Offer,
): Promise<WithdrawalRow> {
  const [recorded] = await run<WithdrawalRow>(
    billing.db,
    `WITH recorded AS (
      INSERT INTO public.dormouse_withdrawals
        (id, "userId", "subscriptionId", plan, "priceId", "contractStartedAt", country, "submittedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT ("subscriptionId") DO NOTHING
      RETURNING ${COLUMNS}),
    acknowledgement AS (
      INSERT INTO public.dormouse_billing_notices (id, "userId", kind, "withdrawalId", "createdAt")
      SELECT gen_random_uuid()::text, "userId", 'withdrawal', id, "submittedAt" FROM recorded)
    SELECT * FROM recorded`,
    [
      crypto.randomUUID(),
      ownerId,
      subscription.id,
      plan,
      subscription.price_id,
      offer.startedAt,
      offer.country,
      billing.time.now(),
    ],
  );
  return recorded ?? (await recordedWithdrawal(billing, ownerId, subscription.id))!;
}

/** What a refund is for, named in its metadata and its idempotency key: a withdrawal by its id, a closure by its subscription's. */
export interface RefundFor {
  kind: "withdrawal" | "closure";
  id: string;
}

/** A paid payment Stripe can refund: its PaymentIntent, or its charge when it has none. */
type Refundable = { payment_intent: string } | { charge: string };
const paymentId = (payment: Refundable) => ("payment_intent" in payment ? payment.payment_intent : payment.charge);

/**
 * Where a payment's refund stands: `refunded` in full by refunds that
 * succeeded, `waiting` on Stripe for one in flight or for another pass, or
 * `action` while one waits on the customer.
 */
type RefundState = "refunded" | "waiting" | "action";

/**
 * Refunds, for `refund`, the part of `amount` paid by `payment` that its
 * succeeded refunds leave, deciding from the refunds Stripe holds for it, by
 * an earlier attempt or by hand, and never from a create's answer alone. A
 * refund in flight or awaiting the customer's action is waited on; one that
 * failed or was canceled is made again under a key that counts them, as
 * Stripe answers a repeated key with the refund it made for it.
 */
async function refundInFull(
  billing: Billing<Plan>,
  refund: RefundFor,
  payment: Refundable,
  amount: number,
): Promise<RefundState> {
  const paid = paymentId(payment);
  const refunds = await billing.stripe.refunds.list({ ...payment, limit: 100 });
  if (refunds.has_more) throw new Error(`Payment ${paid} has more refunds than one page`);
  const of = (...statuses: string[]) => refunds.data.filter((made) => statuses.includes(made.status ?? ""));
  const succeeded = of("succeeded").reduce((sum, made) => sum + made.amount, 0);
  if (succeeded >= amount) return "refunded";
  if (of("requires_action").length) return "action";
  if (of("pending").length) return "waiting";
  const made = await billing.stripe.refunds.create(
    {
      ...payment,
      amount: amount - succeeded,
      reason: "requested_by_customer",
      metadata: { [`dormouse_${refund.kind}`]: refund.id },
    },
    { idempotencyKey: `dormouse-${refund.kind}-${refund.id}-${paid}-${of("failed", "canceled").length}` },
  );
  return made.status === "succeeded" ? "refunded" : made.status === "requires_action" ? "action" : "waiting";
}

/** What Stripe can refund of invoice payment `payment`: a PaymentIntent, or a charge without one; null for one paid outside Stripe. */
function refundable({ payment }: Stripe.InvoicePayment): Refundable | null {
  const intent = payment.type === "payment_intent" ? idOf(payment.payment_intent) : null;
  if (intent) return { payment_intent: intent };
  const charge = payment.type === "charge" ? idOf(payment.charge) : null;
  return charge ? { charge } : null;
}

/**
 * Refunds in full, for `refund`, every payment of each paid invoice of
 * subscription `subscriptionId` that `covers` accepts: no use deduction, tax
 * included. Safe to repeat. Returns once every such payment is refunded by
 * refunds that succeeded; else throws, after refunding the rest, so the
 * caller stamps nothing: while a refund is in flight, which a later pass
 * reads again; while one awaits the customer's action in Stripe; or while an
 * invoice was paid in part outside Stripe (out of band, or a payment record),
 * which Stripe cannot refund. Those last two the operator settles by hand
 * (`hosted/README.md`).
 */
export async function refundPaidInvoices(
  billing: Billing<Plan>,
  subscriptionId: string,
  refund: RefundFor,
  covers: (invoice: Stripe.Invoice) => boolean = () => true,
) {
  const label = `${refund.kind === "withdrawal" ? "Withdrawal" : "Closure"} ${refund.id}`;
  const invoices = await billing.stripe.invoices.list({ subscription: subscriptionId, status: "paid", limit: 100 });
  if (invoices.has_more) throw new Error(`${label}: more paid invoices than one page`);
  const byHand: string[] = [];
  const awaitingAction: string[] = [];
  const waiting: string[] = [];
  for (const invoice of invoices.data.filter(covers)) {
    const payments = await billing.stripe.invoicePayments.list({ invoice: invoice.id!, status: "paid", limit: 100 });
    if (payments.has_more) throw new Error(`${label}: invoice ${invoice.id} has more payments than one page`);
    let collected = 0;
    for (const payment of payments.data) {
      const paid = refundable(payment);
      if (!paid) continue;
      const amount = payment.amount_paid ?? 0;
      const state = await refundInFull(billing, refund, paid, amount);
      const named = `${invoice.id} (${paymentId(paid)})`;
      if (state === "action") awaitingAction.push(named);
      else if (state === "waiting") waiting.push(named);
      collected += amount;
    }
    // Whatever Stripe did not collect itself: an invoice marked paid out of band has no payment to refund.
    if (collected < invoice.amount_due) byHand.push(`${invoice.id} (${invoice.amount_due - collected} of ${invoice.amount_due} ${invoice.currency})`);
  }
  const unsettled = [
    ...(byHand.length ? [`paid outside Stripe, refund by hand, then mark it settled: invoice ${byHand.join(", ")}`] : []),
    ...(awaitingAction.length ? [`refund awaits the customer's action in Stripe: invoice ${awaitingAction.join(", ")}`] : []),
    ...(waiting.length ? [`refund not yet succeeded, retried by the cron: invoice ${waiting.join(", ")}`] : []),
  ];
  if (unsettled.length) throw new Error(`${label}: ${unsettled.join("; ")}`);
}

/**
 * Ends withdrawal `row`'s subscription at once, without proration or a final
 * invoice (`billing.end`, which does nothing to one already ended), then
 * refunds in full every payment its paid invoices received: no use
 * deduction, tax included. Each step is safe to repeat.
 */
async function settle(billing: Billing<Plan>, row: WithdrawalRow) {
  await billing.end(row.userId, row.subscriptionId, { reason: END_REASONS.withdrawal });
  await refundPaidInvoices(billing, row.subscriptionId, { kind: "withdrawal", id: row.id });
}

/**
 * Settles withdrawal `row` unless it was ({@link settle}), and stamps it
 * settled. Throws on a failure; the cron tries again.
 */
export async function settleWithdrawal(billing: Billing<Plan>, row: WithdrawalRow) {
  if (row.settledAt) return;
  await settle(billing, row);
  await run(billing.db, `UPDATE public.dormouse_withdrawals SET "settledAt" = $2 WHERE id = $1`, [row.id, billing.time.now()]);
}

/** How many withdrawals one cron run settles at most. */
const RETRY_BATCH = 20;

/**
 * The cron's pass: tries to settle up to {@link RETRY_BATCH} unsettled
 * withdrawals, however old, the least recently tried first, so one that keeps
 * failing never starves the rest; answers the failures, so every run that
 * tries one still unsettled fails. Its acknowledgement is the notice pass's.
 */
export async function settleWithdrawals(billing: Billing<Plan>): Promise<unknown[]> {
  const rows = await run<WithdrawalRow>(
    billing.db,
    `WITH due AS (
      SELECT id FROM public.dormouse_withdrawals WHERE "settledAt" IS NULL
      ORDER BY "attemptedAt" NULLS FIRST, "submittedAt", id LIMIT $2)
    UPDATE public.dormouse_withdrawals SET "attemptedAt" = $1 WHERE id IN (SELECT id FROM due)
    RETURNING ${COLUMNS}`,
    [billing.time.now(), RETRY_BATCH],
  );
  const failed: unknown[] = [];
  for (const row of rows) await settleWithdrawal(billing, row).catch((error: unknown) => failed.push(error));
  return failed;
}
