/**
 * The tiers Dormouse Hosted sells, and the structured data that republishes
 * them.
 *
 * One owner for every price on the site. The page renders from this table, the
 * JSON-LD is derived from it, and `website/src/pages/Hosted.test.tsx` reads it
 * rather than restating the numbers — a price written twice is a price that
 * will eventually disagree with itself.
 *
 * See docs/specs/pricing.md -> Tiers and -> The Hosted page.
 */

/** A founding ladder whose remaining seats the page shows live. */
export type CohortId = "founding-annual" | "founding-permanent";

/**
 * List prices, which the founding ladders climb toward and are struck against.
 *
 * Annual is two months free against monthly, and monthly is the reference
 * price every other number is read against (docs/specs/pricing.md -> Tiers).
 */
export const LIST_MONTHLY = 10;
export const LIST_ANNUAL = 100;

/** Seats in one founding-annual cohort, and the step between cohorts. */
export const ANNUAL_COHORT_SIZE = 100;
const ANNUAL_LADDER_BASE = 50;
const ANNUAL_LADDER_STEP = 10;

/** Seats in one founding-permanent cohort, and the two prices they sell at. */
export const PERMANENT_COHORT_SIZE = 50;
const PERMANENT_LADDER = [299, 399] as const;

/**
 * Every price the founding-annual ladder passes through, in cohort order.
 *
 * The ladder climbs $10 per cohort of 100 and stops on reaching list, which is
 * where founding annual closes for good — so the last step is the one below
 * list, never list itself.
 */
export const ANNUAL_LADDER: readonly number[] = Array.from(
  { length: (LIST_ANNUAL - ANNUAL_LADDER_BASE) / ANNUAL_LADDER_STEP },
  (_, i) => ANNUAL_LADDER_BASE + i * ANNUAL_LADDER_STEP,
);

/**
 * How many cohorts of each ladder have closed.
 *
 * Prerendered rather than fetched, because the price is prerendered text: a
 * cohort selling out raises the price at the next deploy, while the seat
 * counter beside it is live (docs/specs/pricing.md -> The Hosted page). Bump
 * these when a cohort closes.
 */
export const COHORTS_CLOSED: Record<CohortId, number> = {
  "founding-annual": 0,
  "founding-permanent": 0,
};

/** One purchasable plan, at the price it is on sale at today. */
export type Tier = {
  id: string;
  name: string;
  /** What the buyer pays today, in whole US dollars. */
  price: number;
  /** How the page says the cadence, beneath the price. */
  cadence: string;
  /** UN/CEFACT unit for a recurring charge; absent for the one-time tier. */
  billingUnit?: "MON" | "ANN";
  /** The list price struck through beside this one, where there is one. */
  listPrice?: number;
  /** The ladder whose remaining seats show beside this tier. */
  cohort?: CohortId;
  /** Exactly one tier carries this; the page marks it out. */
  recommended?: boolean;
  /** One line under the name, saying what the price buys. */
  blurb: string;
};

/**
 * The tiers on sale, in the order the table lists them.
 *
 * Annual at list is deliberately absent: it opens only once the founding
 * annual cohorts close, and a tier not yet on sale gets no row and no counter
 * (docs/specs/pricing.md -> Tiers). It appears on the page as the struck price
 * founding annual is read against.
 */
export function tiersOnSale(): Tier[] {
  const annualStep = Math.min(COHORTS_CLOSED["founding-annual"], ANNUAL_LADDER.length - 1);
  const permanentStep = Math.min(
    COHORTS_CLOSED["founding-permanent"],
    PERMANENT_LADDER.length - 1,
  );
  return [
    {
      id: "monthly",
      name: "Monthly",
      price: LIST_MONTHLY,
      cadence: "per month",
      billingUnit: "MON",
      blurb: "The Individual plan, month to month. Cancel any time.",
    },
    {
      id: "founding-annual",
      name: "Founding annual",
      price: ANNUAL_LADDER[annualStep],
      cadence: "per year",
      billingUnit: "ANN",
      listPrice: LIST_ANNUAL,
      cohort: "founding-annual",
      recommended: true,
      blurb: "The Individual plan at a price locked for as long as you stay subscribed.",
    },
    {
      id: "founding-permanent",
      name: "Founding permanent",
      price: PERMANENT_LADDER[permanentStep],
      cadence: "once",
      cohort: "founding-permanent",
      blurb: "The Individual plan forever, including everything later added to it.",
    },
  ];
}

/** Seats in one cohort of the given ladder. */
export function cohortSize(cohort: CohortId): number {
  return cohort === "founding-annual" ? ANNUAL_COHORT_SIZE : PERMANENT_COHORT_SIZE;
}

/**
 * `Product` / `Offer` structured data for the tiers, at the prices the page
 * prints.
 *
 * Prerendered with the rest of the prices so an assistant fetching the page
 * can quote them without running the counters. Availability is `PreOrder`
 * until checkout opens — the buttons explain what is left to build, so
 * claiming `InStock` here would be the page's only false statement.
 */
export function pricingJsonLd(pageUrl: string): string {
  const data = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Dormouse Hosted",
    description:
      "The Individual plan for Dormouse: the managed Relay for Pocket and managed voices "
      + "for spoken alarms. The terminal itself stays free.",
    brand: { "@type": "Brand", name: "Dormouse" },
    url: pageUrl,
    offers: tiersOnSale().map((tier) => ({
      "@type": "Offer",
      name: tier.name,
      price: String(tier.price),
      priceCurrency: "USD",
      url: `${pageUrl}#pricing`,
      availability: "https://schema.org/PreOrder",
      ...(tier.billingUnit
        ? {
            priceSpecification: {
              "@type": "UnitPriceSpecification",
              price: String(tier.price),
              priceCurrency: "USD",
              billingDuration: 1,
              unitCode: tier.billingUnit,
            },
          }
        : {}),
    })),
  };
  // `<` cannot appear in any value above, but a later edit should not be the
  // thing that discovers an inline script ends at the first `</`.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
