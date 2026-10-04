// Rules: docs/specs/hosted.md -> "Billing".
import { Billing, BillingError, Stripe, type BillingDB } from "@pgstencil/stripe";
import { SecureRandom, SystemTime, type RandomSource, type Time } from "pgstencil";
import { connectDatabase } from "pgstencil/postgres";
import {
  FOUNDING_COHORT_SIZE,
  FOUNDING_LADDER,
} from "../../website/src/lib/hosted-pricing";

/** The plans checkout sells, by the names a buy link and `status()` use. */
export const PLANS = ["monthly", "yearly", "founding"] as const;
export type Plan = (typeof PLANS)[number];

/** A refund inside this window, which also cancels, returns the seat to its cohort. */
export const REFUND_DAYS = 30;

/** Where Stripe returns the browser: checkout success and cancel, and the portal. */
export const BILLING_RETURN_PATH = "/billing";

/** The account Worker's billing bindings; billing is off unless all are set. */
export interface BillingEnv {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_MONTHLY?: string;
  STRIPE_PRICE_YEARLY?: string;
  /** The founding ladder's Prices, comma-separated, in cohort order. */
  STRIPE_PRICES_FOUNDING?: string;
}

/** The clock and randomness billing runs on: the system's, or a test's. */
export interface Clock {
  time: Time;
  random: RandomSource;
}

/** Every deployed entry's clock. */
export const SYSTEM_CLOCK: Clock = { time: new SystemTime(), random: new SecureRandom() };

/** A deployment's billing configuration, read from its bindings. */
export interface BillingSetup {
  secretKey: string;
  webhookSecret: string;
  live: boolean;
  monthly: string;
  yearly: string;
  /** One Price per `FOUNDING_LADDER` step, in cohort order. */
  founding: readonly string[];
}

const PRICE = /^price_[A-Za-z0-9_]{1,200}$/;

/**
 * The setup `env` carries, or null while any binding is missing. A ladder
 * whose length differs from the published `FOUNDING_LADDER`, or a malformed
 * or repeated Price, throws: the page and checkout would disagree on price.
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

/** The open cohort and its seats left; null once founding has closed. */
export interface OpenCohort {
  /** Its index in `FOUNDING_LADDER`: how many cohorts have closed. */
  cohort: number;
  seatsLeft: number;
}

/**
 * The open cohort, from completed purchases per ladder step. It is the
 * highest step anyone has bought at, or the one after it once that is full,
 * so a refund in a closed cohort never reopens a lower step.
 */
export function openCohort(sold: readonly number[]): OpenCohort | null {
  let last = 0;
  sold.forEach((count, step) => {
    if (count > 0) last = step;
  });
  const cohort = (sold[last] ?? 0) >= FOUNDING_COHORT_SIZE ? last + 1 : last;
  if (cohort >= sold.length) return null;
  return { cohort, seatsLeft: FOUNDING_COHORT_SIZE - (sold[cohort] ?? 0) };
}

/** Completed purchases at each founding step, in cohort order. */
export async function foundingSold(billing: Billing<Plan>, setup: BillingSetup) {
  const counts = await billing.purchaseCounts(setup.founding, { refundDays: REFUND_DAYS });
  return setup.founding.map((price) => counts[price] ?? 0);
}

/**
 * Runs `action` with a `Billing` over `databaseUrl` for the account origin
 * `origin`, closing its connections after. No trial; Stripe Managed Payments
 * is the merchant of record; founding checkout offers the open cohort's Price
 * and refuses once founding has closed.
 */
export async function withBilling<T>(
  setup: BillingSetup,
  databaseUrl: string,
  clock: Clock,
  origin: string,
  action: (billing: Billing<Plan>) => Promise<T>,
): Promise<T> {
  const db = connectDatabase<BillingDB>(databaseUrl);
  try {
    const billing = new Billing<Plan>(
      db,
      new Stripe(setup.secretKey, {
        httpClient: Stripe.createFetchHttpClient(),
        maxNetworkRetries: 1,
      }),
      clock.time,
      clock.random,
      {
        prices: {
          monthly: setup.monthly,
          yearly: setup.yearly,
          founding: {
            recognized: setup.founding,
            async offer(billing) {
              const open = openCohort(await foundingSold(billing as Billing<Plan>, setup));
              if (!open) throw new BillingError("Founding is closed.", 409);
              return setup.founding[open.cohort]!;
            },
          },
        },
        trialDays: 0,
        managedPayments: true,
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

export { BillingError };
