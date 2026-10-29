// Rules: docs/specs/hosted.md -> "Billing".
import { Billing, BillingError, Stripe, type BillingDB } from "@pgstencil/stripe";
import { SecureRandom, SystemTime, type EmailSender } from "pgstencil";
import { connectDatabase, queryDatabase } from "pgstencil/postgres";
import { FOUNDING_COHORT_SIZE, FOUNDING_LADDER, LIST_ANNUAL, LIST_MONTHLY } from "../../website/src/lib/hosted-pricing";
import type { BillingEnv } from "./bindings";
import { grantsAccessSql } from "./entitlement";
import { retryWithdrawals } from "./withdrawal";
import { BILLING_PLANS, BILLING_RETURN_PATH } from "./policy-constants";

/** The plans checkout sells, by the names `status()` and a checkout use. */
export type Plan = (typeof BILLING_PLANS)[number];

/** A purchase that ends within this many days of starting is a refund: its seat returns to its cohort. */
export const REFUND_DAYS = 30;

/** A deployment's billing configuration, read from its bindings. */
export interface BillingSetup {
  secretKey: string;
  webhookSecret: string;
  live: boolean;
  monthly: string;
  yearly: string;
  /** One Price per `FOUNDING_LADDER` step, in cohort order. */
  founding: readonly string[];
  /** StripeDev's client in place of Stripe's API, for tests and the dev loop; never from bindings. */
  stripe?: Stripe;
}

const PRICE = /^price_[A-Za-z0-9_]{1,200}$/;

/**
 * The setup `env` carries, or null while any binding is missing: billing is
 * then closed. A ladder whose length differs from the published
 * `FOUNDING_LADDER`, or a malformed or repeated Price, throws, since the page
 * and checkout would disagree on a price.
 */
export function billingSetup(env: BillingEnv): BillingSetup | null {
  const {
    STRIPE_SECRET_KEY: secretKey,
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    STRIPE_PRICE_MONTHLY: monthly,
    STRIPE_PRICE_YEARLY: yearly,
    STRIPE_PRICES_FOUNDING: ladder,
  } = env;
  if (!secretKey || !webhookSecret || !monthly || !yearly || !ladder) return null;
  const founding = ladder.split(",").map((price) => price.trim());
  if (founding.length !== FOUNDING_LADDER.length)
    throw new Error(
      `STRIPE_PRICES_FOUNDING names ${founding.length} Prices; the published ladder has ${FOUNDING_LADDER.length}`,
    );
  const prices = [monthly, yearly, ...founding];
  if (!prices.every((price) => PRICE.test(price)) || new Set(prices).size !== prices.length)
    throw new Error("Stripe Prices must be distinct price_ ids");
  return {
    secretKey,
    webhookSecret,
    live: /^(?:sk|rk)_live_/.test(secretKey),
    monthly,
    yearly,
    founding,
  };
}

/**
 * What `priceId` charges per interval, in whole US dollars, as the published
 * prices say each configured Price does; null for a Price not configured.
 */
export function publishedPrice(setup: BillingSetup, priceId: string): number | null {
  if (priceId === setup.monthly) return LIST_MONTHLY;
  if (priceId === setup.yearly) return LIST_ANNUAL;
  const step = setup.founding.indexOf(priceId);
  return step === -1 ? null : FOUNDING_LADDER[step]!;
}

/** The open cohort and its seats left; null once founding has closed. */
export interface OpenCohort {
  /** Its index in `FOUNDING_LADDER`: how many cohorts have closed. */
  cohort: number;
  seatsLeft: number;
}

/**
 * The open cohort, from purchases per ladder step: `gross` counts every
 * completed purchase, refunded or not, and `net` leaves refunds out. A cohort
 * closes when its gross count fills, so a refund after it closed never
 * reopens the cheaper step; seats left in the open one come from its net
 * count, so a refund there returns the seat.
 */
export function openCohort(gross: readonly number[], net: readonly number[]): OpenCohort | null {
  const cohort = gross.findIndex((sold) => sold < FOUNDING_COHORT_SIZE);
  if (cohort === -1) return null;
  return { cohort, seatsLeft: Math.max(0, FOUNDING_COHORT_SIZE - (net[cohort] ?? 0)) };
}

/**
 * Founding purchases per ladder step, from the synchronized subscriptions:
 * `gross` and `net` as {@link openCohort} reads them.
 */
export async function foundingPurchases(billing: Billing<Plan>, founding: readonly string[]) {
  // A refund window of 0 counts every completed purchase, refunded or not.
  const [gross, net] = await Promise.all(
    [0, REFUND_DAYS].map(async (refundDays) => {
      const counts = await billing.purchaseCounts(founding, { refundDays });
      return founding.map((price) => counts[price] ?? 0);
    }),
  );
  return { gross: gross!, net: net! };
}

/** The open founding cohort, from the synchronized subscriptions. */
export async function foundingCohort(billing: Billing<Plan>, founding: readonly string[]) {
  const { gross, net } = await foundingPurchases(billing, founding);
  return openCohort(gross, net);
}

// The system clock: a test bundle's injected `Date` scopes it to the test's.
const time = new SystemTime();
const random = new SecureRandom();

/**
 * Runs `action` with a `Billing` over `databaseUrl` for the account origin
 * `origin`, closing its connections after. No trial; DiffPlug is the merchant
 * of record on Stripe Billing, never Managed Payments, with Stripe Tax on
 * every Checkout; founding checkout offers the open cohort's Price and
 * refuses once founding has closed.
 */
export async function withBilling<T>(
  setup: BillingSetup,
  databaseUrl: string,
  origin: string,
  action: (billing: Billing<Plan>) => Promise<T>,
): Promise<T> {
  const db = connectDatabase<BillingDB>(databaseUrl);
  try {
    const billing = new Billing<Plan>(
      db,
      setup.stripe ??
        new Stripe(setup.secretKey, {
          httpClient: Stripe.createFetchHttpClient(),
          maxNetworkRetries: 1,
        }),
      time,
      random,
      {
        prices: {
          monthly: setup.monthly,
          yearly: setup.yearly,
          founding: {
            recognized: setup.founding,
            async offer(billing) {
              const open = await foundingCohort(billing as Billing<Plan>, setup.founding);
              if (!open) throw new BillingError("Founding is closed.", 409);
              return setup.founding[open.cohort]!;
            },
          },
        },
        trialDays: 0,
        managedPayments: false,
        automaticTax: true,
        webhookSecret: setup.webhookSecret,
        live: setup.live,
        origin,
        returnPath: BILLING_RETURN_PATH,
      },
    );
    return await action(billing);
  } finally {
    await db.destroy();
  }
}

/** How many owners one resync reconciles at most. */
const RESYNC_OWNERS = 20;

/**
 * The account Worker's Cron Trigger: reconciles up to {@link RESYNC_OWNERS}
 * random owners whose `active` or `trialing` row no longer grants access, so
 * a missed renewal webhook costs a member one run at most, then finishes
 * any withdrawal whose acknowledgement or settlement failed. Billing closed
 * does nothing. Every owner and withdrawal is tried; any failure fails the
 * invocation after.
 */
export async function resyncBilling(
  setup: BillingSetup | null,
  databaseUrl: string,
  origin: string,
  mail: () => EmailSender,
) {
  if (!setup) return;
  const due = await queryDatabase<{ owner: string }>(
    databaseUrl,
    `SELECT owner_id AS owner FROM pgstencil_billing.subscriptions s
    WHERE s.status IN ('active', 'trialing') AND NOT ${grantsAccessSql("s")}
    GROUP BY owner_id ORDER BY random() LIMIT $1`,
    [RESYNC_OWNERS],
  );
  const failed: unknown[] = [];
  await withBilling(setup, databaseUrl, origin, async (billing) => {
    for (const { owner } of due)
      await billing.reconcile(owner).catch((error: unknown) => failed.push(error));
    failed.push(...(await retryWithdrawals(billing, mail)));
  });
  if (failed.length) throw new AggregateError(failed, `${failed.length} billing resyncs failed`);
}
