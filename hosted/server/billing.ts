// Rules: docs/specs/hosted.md -> "Billing".
import { Billing, BillingError, Stripe, type BillingDB } from "@pgstencil/stripe";
import { SecureRandom, SystemTime } from "pgstencil";
import { connectDatabase } from "pgstencil/postgres";
import {
  FOUNDING_COHORT_SIZE,
  FOUNDING_LADDER,
  type CheckoutPlan,
} from "../../website/src/lib/hosted-pricing";
import { BILLING_RETURN_PATH } from "./policy-constants";

/** The plans checkout sells, by the names a buy link and `status()` use. */
export type Plan = CheckoutPlan;

/** A refund inside this window, which also cancels, returns the seat to its cohort. */
export const REFUND_DAYS = 30;


/** The account Worker's billing bindings; billing is off unless all are set. */
export interface BillingEnv {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_MONTHLY?: string;
  STRIPE_PRICE_YEARLY?: string;
  /** The founding ladder's Prices, comma-separated, in cohort order. */
  STRIPE_PRICES_FOUNDING?: string;
}

// The system clock: a test bundle's injected `Date` scopes it to the test's.
const time = new SystemTime();
const random = new SecureRandom();

/** A deployment's billing configuration, read from its bindings. */
export interface BillingSetup {
  secretKey: string;
  webhookSecret: string;
  live: boolean;
  monthly: string;
  yearly: string;
  /** One Price per `FOUNDING_LADDER` step, in cohort order. */
  founding: readonly string[];
  /** The dev loop's StripeDev client in place of Stripe's API; never from bindings. */
  stripe?: Stripe;
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

/** The plan `price` grants under `setup`, or null for a Price it does not sell. */
export function planOfPrice(setup: BillingSetup, price: string | undefined): Plan | null {
  if (price === setup.monthly) return "monthly";
  if (price === setup.yearly) return "yearly";
  return price !== undefined && setup.founding.includes(price) ? "founding" : null;
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
