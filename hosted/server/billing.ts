// Rules: docs/specs/hosted.md -> "Billing".
import { Billing, BillingError, Stripe, type BillingDB } from "@pgstencil/stripe";
import { CompiledQuery, type Kysely } from "kysely";
import { SecureRandom, SystemTime, type EmailSender, type Time } from "pgstencil";
import { connectDatabase } from "pgstencil/postgres";
import { FOUNDING_COHORT_SIZE, FOUNDING_LADDER, LIST_ANNUAL, LIST_MONTHLY } from "../../website/src/lib/hosted-pricing";
import type { BillingEnv } from "./bindings";
import { resyncDisputes } from "./billing-routes";
import { retryClosures } from "./closure";
import { grantsAccessSql } from "./entitlement";
import { runNotices } from "./notices";
import { settleWithdrawals } from "./withdrawal";
import { BILLING_RETURN_PATH, REFUND_DAYS, type Plan } from "./policy-constants";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The id of a Stripe reference that may arrive expanded; null without one. */
export const idOf = (ref: string | { id: string } | null | undefined) => (typeof ref === "string" ? ref : (ref?.id ?? null));

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
  /** A test's clock in place of the system's; never from bindings. */
  time?: Time;
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

/** A scheduled list price change, as the operator recorded it in `dormouse_price_changes`. */
export interface PriceChange {
  id: string;
  plan: "monthly" | "yearly";
  fromPriceId: string;
  toPriceId: string;
  fromUsd: number;
  toUsd: number;
  effectiveAt: Date;
}

/** One statement on `db`, answering its rows. */
export const run = <Row>(db: Pick<Kysely<any>, "executeQuery">, text: string, values: readonly unknown[]) =>
  db.executeQuery<Row>(CompiledQuery.raw(text, [...values])).then((result) => result.rows);

/** Every scheduled price change, oldest first. */
const priceChanges = (db: Kysely<any>) =>
  run<PriceChange>(
    db,
    `SELECT id, plan, "fromPriceId", "toPriceId", "fromUsd", "toUsd", "effectiveAt"
    FROM public.dormouse_price_changes ORDER BY "createdAt", id`,
    [],
  );

/** Every Price billing recognizes, by id, and the price changes it acts on or refuses. */
export interface PriceCatalog {
  /**
   * Each recognized Price's plan, and what it charges per interval in whole
   * US dollars: a configured Price as the published prices say, another as
   * its usable change says, its new Price before its old.
   */
  prices: ReadonlyMap<string, { plan: Plan; usd: number }>;
  /** `plan`'s Prices, configured first. */
  recognized(plan: Plan): string[];
  usable: readonly PriceChange[];
  /** A change naming a founding Price, whose lock no change may touch, or a Price another plan's configuration or change already holds: refused whole. */
  refused: readonly PriceChange[];
}

/** The catalog `setup` configures, with the price changes `changes` schedules. */
export function priceCatalog(setup: BillingSetup, changes: readonly PriceChange[]): PriceCatalog {
  const prices = new Map<string, { plan: Plan; usd: number }>([
    [setup.monthly, { plan: "monthly", usd: LIST_MONTHLY }],
    [setup.yearly, { plan: "yearly", usd: LIST_ANNUAL }],
    ...setup.founding.map((price, step) => [price, { plan: "founding", usd: FOUNDING_LADDER[step]! }] as const),
  ]);
  const owner = new Map([...prices].map(([price, { plan }]) => [price, plan]));
  const usable: PriceChange[] = [];
  const refused: PriceChange[] = [];
  for (const change of changes) {
    const ids = [change.fromPriceId, change.toPriceId];
    if (ids.some((price) => (owner.get(price) ?? change.plan) !== change.plan)) refused.push(change);
    else {
      for (const price of ids) owner.set(price, change.plan);
      usable.push(change);
    }
  }
  for (const side of ["to", "from"] as const)
    for (const change of usable)
      if (!prices.has(change[`${side}PriceId`]))
        prices.set(change[`${side}PriceId`], { plan: change.plan, usd: change[`${side}Usd`] });
  return {
    prices,
    recognized: (plan) => [...prices].filter(([, price]) => price.plan === plan).map(([id]) => id),
    usable,
    refused,
  };
}

/** The open cohort and its seats left; null once founding has closed. */
export interface OpenCohort {
  /** Its index in `FOUNDING_LADDER`: how many cohorts have closed. */
  cohort: number;
  seatsLeft: number;
}

/**
 * The open cohort, from purchases per ladder step: `gross` counts every
 * completed purchase, refunded or not, and `net` leaves refunds out. The open
 * cohort is the last step anyone bought at while its net count is short of
 * full, else the step after it, so a refund there returns the seat; an
 * earlier step closed for good once a purchase landed after it, so a refund
 * there never reopens the cheaper price.
 */
export function openCohort(gross: readonly number[], net: readonly number[]): OpenCohort | null {
  let bought = gross.length - 1;
  while (bought >= 0 && !gross[bought]) bought--;
  const cohort = bought !== -1 && (net[bought] ?? 0) >= FOUNDING_COHORT_SIZE ? bought + 1 : Math.max(bought, 0);
  if (cohort >= FOUNDING_LADDER.length) return null;
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

/**
 * One Stripe client per key for the isolate's life: it holds no I/O of its
 * own, and the caches keyed by it (`withdrawalOffer`'s contact, a price
 * change's checked Prices) then outlive a request.
 */
const clients = new Map<string, Stripe>();
function stripeClient(secretKey: string): Stripe {
  let client = clients.get(secretKey);
  if (!client) {
    client = new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 1 });
    clients.set(secretKey, client);
  }
  return client;
}

// The system clock: a test bundle's injected `Date` scopes it to the test's.
const time = new SystemTime();
const random = new SecureRandom();

/**
 * Runs `action` with a `Billing` over `databaseUrl` for the account origin
 * `origin`, and the price catalog, closing its connections after.
 * No trial; DiffPlug is the merchant of record on Stripe Billing, never
 * Managed Payments, with Stripe Tax on every Checkout; founding checkout
 * offers the open cohort's Price and refuses once founding has closed.
 * Monthly and yearly checkout offer the configured Price, and each also
 * grants the Prices its usable price changes move between.
 */
export async function withBilling<T>(
  setup: BillingSetup,
  databaseUrl: string,
  origin: string,
  action: (billing: Billing<Plan>, catalog: PriceCatalog) => Promise<T>,
): Promise<T> {
  const db = connectDatabase<BillingDB>(databaseUrl);
  try {
    const catalog = priceCatalog(setup, await priceChanges(db));
    const prices = (plan: "monthly" | "yearly") => ({ recognized: catalog.recognized(plan), offer: () => setup[plan] });
    const billing = new Billing<Plan>(
      db,
      setup.stripe ?? stripeClient(setup.secretKey),
      setup.time ?? time,
      random,
      {
        prices: {
          monthly: prices("monthly"),
          yearly: prices("yearly"),
          founding: {
            recognized: catalog.recognized("founding"),
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
    return await action(billing, catalog);
  } finally {
    await db.destroy();
  }
}

/** How many owners one resync reconciles at most. */
const RESYNC_OWNERS = 20;

/**
 * The account Worker's Cron Trigger: reconciles up to {@link RESYNC_OWNERS}
 * random owners whose `active` or `trialing` row no longer grants access, so
 * a missed renewal webhook costs a member one run at most, then settles any
 * withdrawal whose settlement failed and any closure whose refunds failed,
 * then rereads a batch of open disputes from Stripe, then runs the notices,
 * a withdrawal's acknowledgement among them, and the price changes they allow.
 * Billing closed does nothing. Every owner, withdrawal, closure, dispute,
 * and notice is tried; any failure fails the invocation after.
 */
export async function resyncBilling(
  setup: BillingSetup | null,
  databaseUrl: string,
  origin: string,
  mail: () => EmailSender,
) {
  if (!setup) return;
  const failed: unknown[] = [];
  await withBilling(
    setup,
    databaseUrl,
    origin,
    async (billing, catalog) => {
      const due = await run<{ owner: string }>(
        billing.db,
        `SELECT owner_id AS owner FROM pgstencil_billing.subscriptions s
        WHERE s.status IN ('active', 'trialing') AND NOT ${grantsAccessSql("s")}
        GROUP BY owner_id ORDER BY random() LIMIT $1`,
        [RESYNC_OWNERS],
      );
      for (const { owner } of due) await billing.reconcile(owner).catch((error: unknown) => failed.push(error));
      failed.push(...(await settleWithdrawals(billing)));
      failed.push(...(await retryClosures(billing)));
      failed.push(...(await resyncDisputes(billing)));
      failed.push(...(await runNotices(billing, catalog, mail)));
    },
  );
  if (failed.length) throw new AggregateError(failed, `${failed.length} billing resyncs failed`);
}
