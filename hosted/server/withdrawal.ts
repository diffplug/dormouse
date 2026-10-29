// Rules: docs/specs/hosted.md -> "Billing"; docs/specs/pricing.md ->
// "Checkout and entitlement".
import type { Billing, Stripe } from "@pgstencil/stripe";
import { DAY_MS, idOf, run } from "./billing";
import type { WithdrawalOffer } from "./billing-summary";
import type { Plan } from "./policy-constants";
import { CURRENT_STATUSES } from "./entitlement";

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

/** The cancellation comment a subscription ended by withdrawal carries. */
export const ENDED_FOR_WITHDRAWAL = "dormouse: EEA or UK withdrawal";

/** How long the cron keeps retrying a withdrawal's settlement. */
const RETRY_DAYS = 30;

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
  const account = await billing.db
    .selectFrom("accounts")
    .select("customer_id")
    .where("owner_id", "=", ownerId)
    .executeTakeFirst();
  if (!account?.customer_id) return null;
  const now = billing.time.now().getTime();
  let known = contacts.get(billing.stripe);
  if (!known) contacts.set(billing.stripe, (known = new Map()));
  const hit = known.get(account.customer_id);
  if (cached && hit && now - hit.at < CONTACT_CACHE_MS) return hit.contact;
  try {
    const customer = await billing.stripe.customers.retrieve(account.customer_id);
    const contact = customer.deleted
      ? null
      : { email: customer.email ?? null, country: customer.address?.country?.toUpperCase() ?? null };
    known.set(account.customer_id, { at: now, contact });
    return contact;
  } catch (error) {
    console.warn(`Reading Stripe customer ${account.customer_id} failed`, error);
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
  if (!subscription?.started_at || !CURRENT_STATUSES.includes(subscription.status)) return null;
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

/** Refunds what is left of PaymentIntent `intent` for `refund`, once however often it is asked. */
async function refundInFull(billing: Billing<Plan>, refund: RefundFor, intent: string) {
  try {
    await billing.stripe.refunds.create(
      { payment_intent: intent, reason: "requested_by_customer", metadata: { [`dormouse_${refund.kind}`]: refund.id } },
      { idempotencyKey: `dormouse-${refund.kind}-${refund.id}-${intent}` },
    );
  } catch (error) {
    // Refunded in full already, by an earlier attempt or by hand.
    if ((error as { code?: unknown }).code === "charge_already_refunded") return;
    throw error;
  }
}

/**
 * Refunds in full, for `refund`, every payment of each paid invoice of
 * subscription `subscriptionId` that `covers` accepts: no use deduction, tax
 * included. Safe to repeat.
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
  for (const invoice of invoices.data.filter(covers)) {
    const payments = await billing.stripe.invoicePayments.list({ invoice: invoice.id!, status: "paid", limit: 100 });
    for (const { payment } of payments.data) {
      const intent = idOf(payment.payment_intent);
      if (intent) await refundInFull(billing, refund, intent);
      else console.warn(`${label}: invoice ${invoice.id} has a payment Stripe cannot refund here; refund it by hand`);
    }
  }
}

/**
 * Ends withdrawal `row`'s subscription at once, without proration or a final
 * invoice, then refunds in full every payment its paid invoices received:
 * no use deduction, tax included. Each step is safe to repeat.
 */
async function settle(billing: Billing<Plan>, row: WithdrawalRow) {
  await billing.reconcile(row.userId);
  const synced = await billing.db
    .selectFrom("subscriptions")
    .select("status")
    .where("id", "=", row.subscriptionId)
    .executeTakeFirst();
  if (synced && CURRENT_STATUSES.includes(synced.status)) {
    await billing.stripe.subscriptions.cancel(row.subscriptionId, {
      cancellation_details: { comment: ENDED_FOR_WITHDRAWAL },
      prorate: false,
      invoice_now: false,
    });
    await billing.reconcile(row.userId);
  }
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
 * The cron's pass: settles every withdrawal submitted in the last
 * {@link RETRY_DAYS} days whose settlement failed, up to {@link RETRY_BATCH};
 * answers the failures. Its acknowledgement is the notice pass's.
 */
export async function settleWithdrawals(billing: Billing<Plan>): Promise<unknown[]> {
  const rows = await run<WithdrawalRow>(
    billing.db,
    `SELECT ${COLUMNS} FROM public.dormouse_withdrawals
    WHERE "settledAt" IS NULL AND "submittedAt" > $1
    ORDER BY "submittedAt" LIMIT $2`,
    [new Date(billing.time.now().getTime() - RETRY_DAYS * DAY_MS), RETRY_BATCH],
  );
  const failed: unknown[] = [];
  for (const row of rows) await settleWithdrawal(billing, row).catch((error: unknown) => failed.push(error));
  return failed;
}
