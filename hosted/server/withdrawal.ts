// Rules: docs/specs/hosted.md -> "Billing"; docs/specs/pricing.md ->
// "Checkout and entitlement".
import type { Billing, Stripe } from "@pgstencil/stripe";
import { escape } from "@pgstencil/auth/email";
import { CompiledQuery } from "kysely";
import type { EmailMessage, EmailSender } from "pgstencil";
import { HOSTED_MONTHLY, HOSTED_YEARLY } from "../../website/src/lib/hosted-pricing";
import { DIFFPLUG_POSTAL_ADDRESS, SUPPORT_EMAIL, WITHDRAWAL_STATEMENT } from "../../website/src/lib/hosted-withdrawal";
import type { Plan } from "./billing";
import { CURRENT_STATUSES, ENDED_STATUSES } from "./entitlement";

const DAY_MS = 24 * 60 * 60 * 1000;

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
export const WITHDRAWAL_COUNTRIES: ReadonlySet<string> = new Set([
  ...["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU"],
  ...["LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"],
  ...["AX", "GF", "GP", "MF", "MQ", "RE", "YT"],
  ...["IS", "LI", "NO"],
  ...["GB", "GG", "GI", "IM", "JE"],
]);

/** The cancellation comment a subscription ended by withdrawal carries. */
export const ENDED_FOR_WITHDRAWAL = "dormouse: EEA or UK withdrawal";

/** How long the cron keeps retrying a withdrawal's acknowledgement or settlement. */
const RETRY_DAYS = 30;

/** Each plan's name, as the emails billing sends name it. */
export const PLAN_NAMES: Record<Plan, string> = {
  monthly: HOSTED_MONTHLY.name,
  yearly: HOSTED_YEARLY.name,
  founding: "Founding",
};

type Held = NonNullable<Awaited<ReturnType<Billing<Plan>["status"]>>["subscription"]>;

/** The online withdrawal the billing page offers for the held subscription. */
export interface WithdrawalOffer {
  subscription: string;
  startedAt: string;
  /** When the online withdrawal closes. */
  until: string;
  /** Where the acknowledgement goes: the Stripe customer's email, null when Stripe could not say. */
  email: string | null;
  country: string | null;
}

/** A recorded withdrawal, as `dormouse_withdrawals` holds it. */
export interface WithdrawalRow {
  id: string;
  userId: string;
  subscriptionId: string;
  plan: string;
  contractStartedAt: Date;
  submittedAt: Date;
  acknowledgedAt: Date | null;
  settledAt: Date | null;
}

/** The Stripe customer's billing email and address country, or null when Stripe cannot say. */
export async function billingContact(billing: Billing<Plan>, ownerId: string) {
  const account = await billing.db
    .selectFrom("accounts")
    .select("customer_id")
    .where("owner_id", "=", ownerId)
    .executeTakeFirst();
  if (!account?.customer_id) return null;
  try {
    const customer = await billing.stripe.customers.retrieve(account.customer_id);
    if (customer.deleted) return null;
    return { email: customer.email ?? null, country: customer.address?.country?.toUpperCase() ?? null };
  } catch (error) {
    console.warn(`Reading Stripe customer ${account.customer_id} failed`, error);
    return null;
  }
}

/**
 * The online withdrawal from `subscription`, or null: offered while it is
 * current, within {@link WITHDRAWAL_OPEN_DAYS} of its start, and its billing
 * country is in {@link WITHDRAWAL_COUNTRIES} or unknown, a Stripe that cannot
 * say included. Whether it was withdrawn already is the caller's.
 */
export async function withdrawalOffer(
  billing: Billing<Plan>,
  ownerId: string,
  subscription: Held | null,
): Promise<WithdrawalOffer | null> {
  if (!subscription?.started_at || !CURRENT_STATUSES.includes(subscription.status)) return null;
  const startedAt = new Date(subscription.started_at);
  const until = new Date(startedAt.getTime() + WITHDRAWAL_OPEN_DAYS * DAY_MS);
  if (billing.time.now() >= until) return null;
  const contact = await billingContact(billing, ownerId);
  if (contact?.country && !WITHDRAWAL_COUNTRIES.has(contact.country)) return null;
  return {
    subscription: subscription.id,
    startedAt: startedAt.toISOString(),
    until: until.toISOString(),
    email: contact?.email ?? null,
    country: contact?.country ?? null,
  };
}

const run = <Row>(billing: Billing<Plan>, text: string, values: unknown[]) =>
  billing.db.executeQuery<Row>(CompiledQuery.raw(text, values)).then((result) => result.rows);

const COLUMNS = `id, "userId", "subscriptionId", plan, "contractStartedAt", "submittedAt", "acknowledgedAt", "settledAt"`;

/** The withdrawal recorded from `subscriptionId` by `ownerId`, if any. */
export async function recordedWithdrawal(billing: Billing<Plan>, ownerId: string, subscriptionId: string) {
  const [row] = await run<WithdrawalRow>(
    billing,
    `SELECT ${COLUMNS} FROM public.dormouse_withdrawals WHERE "subscriptionId" = $1 AND "userId" = $2`,
    [subscriptionId, ownerId],
  );
  return row ?? null;
}

/**
 * Records `ownerId`'s withdrawal from `subscription` under `offer`, submitted
 * now, and answers the row: a second submission answers the first's.
 */
export async function recordWithdrawal(
  billing: Billing<Plan>,
  ownerId: string,
  plan: Plan,
  subscription: Held,
  offer: WithdrawalOffer,
): Promise<WithdrawalRow> {
  await run(
    billing,
    `INSERT INTO public.dormouse_withdrawals
      (id, "userId", "subscriptionId", plan, "priceId", "contractStartedAt", country, "submittedAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT ("subscriptionId") DO NOTHING`,
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
  return (await recordedWithdrawal(billing, ownerId, subscription.id))!;
}

const UTC = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "long", timeZone: "UTC" });
const UTC_DAY = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" });

/** The durable acknowledgement of withdrawal `row`, emailed to `to`. */
export function withdrawalAcknowledgement(to: string, row: WithdrawalRow): EmailMessage {
  const plan = PLAN_NAMES[row.plan as Plan] ?? row.plan;
  const facts: [string, string][] = [
    ["Your statement", WITHDRAWAL_STATEMENT],
    ["Submitted", UTC.format(row.submittedAt)],
    ["Contract", `Dormouse Hosted, ${plan}, ordered on ${UTC_DAY.format(row.contractStartedAt)}`],
    ["Reference", row.id],
  ];
  const refund =
    "Your subscription ends with this withdrawal and will not renew. We refund every payment you made for it in full, including tax, to your original payment method within 14 days of your withdrawal, with no deduction. Your bank or card provider decides when the credit appears.";
  const keep = `Keep this email as your record. Questions: ${SUPPORT_EMAIL}.`;
  const intro = "DiffPlug LLC received your withdrawal from your Dormouse Hosted subscription contract.";
  return {
    from: `Dormouse Hosted <${SUPPORT_EMAIL}>`,
    to: [to],
    replyTo: SUPPORT_EMAIL,
    subject: "We received your withdrawal from Dormouse Hosted",
    text: [intro, facts.map(([term, value]) => `${term}: ${value}`).join("\n"), refund, keep, DIFFPLUG_POSTAL_ADDRESS].join(
      "\n\n",
    ),
    html: `<html lang="en"><body><p>${escape(intro)}</p><dl>${facts
      .map(([term, value]) => `<dt>${escape(term)}</dt><dd>${escape(value)}</dd>`)
      .join("")}</dl><p>${escape(refund)}</p><p>${escape(keep)}</p><p>${escape(DIFFPLUG_POSTAL_ADDRESS)}</p></body></html>`,
  };
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
      const intent = typeof payment.payment_intent === "string" ? payment.payment_intent : payment.payment_intent?.id;
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
  if (synced && !ENDED_STATUSES.includes(synced.status)) {
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
 * Finishes withdrawal `row`: emails its acknowledgement to the billing email,
 * then settles it, each step skipped once done and stamped once it is. Throws
 * after both were tried if either failed; the cron tries again.
 */
export async function completeWithdrawal(billing: Billing<Plan>, mail: () => EmailSender, row: WithdrawalRow) {
  const failed: unknown[] = [];
  const stamp = (column: "acknowledgedAt" | "settledAt") =>
    run(billing, `UPDATE public.dormouse_withdrawals SET "${column}" = $2 WHERE id = $1`, [row.id, billing.time.now()]);
  if (!row.acknowledgedAt)
    try {
      const email = (await billingContact(billing, row.userId))?.email;
      if (!email) throw new Error(`Withdrawal ${row.id}: Stripe gave no billing email to acknowledge to`);
      await mail().send(withdrawalAcknowledgement(email, row));
      await stamp("acknowledgedAt");
    } catch (error) {
      failed.push(error);
    }
  if (!row.settledAt)
    try {
      await settle(billing, row);
      await stamp("settledAt");
    } catch (error) {
      failed.push(error);
    }
  if (failed.length) throw new AggregateError(failed, `Withdrawal ${row.id} is not complete`);
}

/** How many withdrawals one cron run finishes at most. */
const RETRY_BATCH = 20;

/**
 * The cron's pass: finishes every withdrawal submitted in the last
 * {@link RETRY_DAYS} days whose acknowledgement or settlement failed, up to
 * {@link RETRY_BATCH}; answers the failures.
 */
export async function retryWithdrawals(billing: Billing<Plan>, mail: () => EmailSender): Promise<unknown[]> {
  const rows = await run<WithdrawalRow>(
    billing,
    `SELECT ${COLUMNS} FROM public.dormouse_withdrawals
    WHERE ("acknowledgedAt" IS NULL OR "settledAt" IS NULL) AND "submittedAt" > $1
    ORDER BY "submittedAt" LIMIT $2`,
    [new Date(billing.time.now().getTime() - RETRY_DAYS * DAY_MS), RETRY_BATCH],
  );
  const failed: unknown[] = [];
  for (const row of rows) await completeWithdrawal(billing, mail, row).catch((error: unknown) => failed.push(error));
  return failed;
}
