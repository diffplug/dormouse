/**
 * The plans Dormouse Hosted sells, and the structured data that republishes
 * them.
 *
 * One owner for every price on the site. The page renders from this table, the
 * JSON-LD is derived from it, and `website/src/pages/Hosted.test.tsx` reads it
 * rather than restating the numbers — a price written twice is a price that
 * will eventually disagree with itself.
 *
 * See docs/specs/pricing.md -> Published prices and -> The Hosted page.
 */

// Relative, not `dormouse-lib`: Hosted bundles this module too.
import { HOSTED_REF_PARAM } from "../../../lib/src/lib/hosted-links";

/**
 * List prices, which the founding ladder climbs toward and is struck against.
 *
 * Annual is two months free against monthly, and monthly is the reference
 * price every other number is read against (docs/specs/pricing.md -> Tiers).
 */
export const LIST_MONTHLY = 10;
export const LIST_ANNUAL = 100;

/** What a year of Hosted saves against twelve months of it. */
export const YEARLY_SAVING = LIST_MONTHLY * 12 - LIST_ANNUAL;

/** Seats in one founding cohort, and the step between cohorts. */
export const FOUNDING_COHORT_SIZE = 100;
const FOUNDING_LADDER_BASE = 50;
const FOUNDING_LADDER_STEP = 10;

/**
 * Every price the founding ladder passes through, in cohort order.
 *
 * The ladder climbs $10 per cohort of 100 and stops on reaching list, which is
 * where founding closes for good — so the last step is the one below list,
 * never list itself.
 */
export const FOUNDING_LADDER: readonly number[] = Array.from(
  { length: (LIST_ANNUAL - FOUNDING_LADDER_BASE) / FOUNDING_LADDER_STEP },
  (_, i) => FOUNDING_LADDER_BASE + i * FOUNDING_LADDER_STEP,
);

/**
 * How many founding cohorts have closed.
 *
 * Prerendered rather than fetched, because the price is prerendered text: a
 * cohort selling out raises the price at the next deploy, while the seat
 * counter beside it is live (docs/specs/pricing.md -> The Hosted page). Bump
 * this when a cohort closes.
 */
export const FOUNDING_COHORTS_CLOSED = 0;

/**
 * Whether the buy buttons link to checkout on the Hosted account origin.
 * False keeps the unbuilt-checkout notice and `PreOrder` offers; flip it once
 * billing is on (docs/specs/hosted.md -> "Billing").
 */
export const CHECKOUT_OPEN = false;

/** Where a buy button sends the buyer: the account origin's checkout page. */
export const CHECKOUT_PAGE = "https://hosted.dormouse.sh/checkout";

/** The plans on sale, by the names checkout sells under, which a buy link and the account Worker share. */
export const CHECKOUT_PLANS = ["monthly", "yearly", "founding"] as const;
export type CheckoutPlan = (typeof CHECKOUT_PLANS)[number];
export const isCheckoutPlan = (value: unknown): value is CheckoutPlan =>
  CHECKOUT_PLANS.includes(value as CheckoutPlan);

/** One purchasable plan, at the price it is on sale at today. */
export type Tier = {
  /** The plan checkout sells it under. */
  id: CheckoutPlan;
  /** What the buy button and the checkout notice call it. */
  name: string;
  /** What the buyer pays today, in whole US dollars. */
  price: number;
  /** The unit after the price: "/month", "/year". */
  per: string;
  /** UN/CEFACT unit for the recurring charge. */
  billingUnit: "MON" | "ANN";
  /** The list price struck through beside this one, where there is one. */
  listPrice?: number;
};

/** The two ways to pay for Hosted at list, which the Hosted card toggles between. */
export const HOSTED_MONTHLY: Tier = {
  id: "monthly",
  name: "Hosted monthly",
  price: LIST_MONTHLY,
  per: "/month",
  billingUnit: "MON",
};

export const HOSTED_YEARLY: Tier = {
  id: "yearly",
  name: "Hosted yearly",
  price: LIST_ANNUAL,
  per: "/year",
  billingUnit: "ANN",
};

/** Founding, at the open cohort's step, read against annual list. */
export function foundingTier(): Tier {
  return {
    id: "founding",
    name: "Founding",
    price: FOUNDING_LADDER[Math.min(FOUNDING_COHORTS_CLOSED, FOUNDING_LADDER.length - 1)],
    per: "/year",
    billingUnit: "ANN",
    listPrice: LIST_ANNUAL,
  };
}

/** The checkout link for `tier`, carrying the visit's allowlisted `ref` (docs/specs/pricing.md -> "The Hosted page"). */
export const checkoutUrl = (tier: Tier, ref?: string) =>
  `${CHECKOUT_PAGE}?plan=${tier.id}${ref ? `&${HOSTED_REF_PARAM}=${ref}` : ""}`;

/** Every paid plan on sale, in the order the page shows them. */
export function tiersOnSale(): Tier[] {
  return [HOSTED_MONTHLY, HOSTED_YEARLY, foundingTier()];
}

/**
 * `Product` / `Offer` structured data for the paid plans, at the prices the
 * page prints.
 *
 * Prerendered with the rest of the prices so an assistant fetching the page
 * can quote them without running the counters. Availability follows
 * `checkoutOpen`: `PreOrder` while the buttons explain what is left to build,
 * since claiming `InStock` then would be the page's only false statement.
 */
export function pricingJsonLd(pageUrl: string, checkoutOpen = CHECKOUT_OPEN): string {
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
      availability: `https://schema.org/${checkoutOpen ? "InStock" : "PreOrder"}`,
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: String(tier.price),
        priceCurrency: "USD",
        billingDuration: 1,
        unitCode: tier.billingUnit,
      },
    })),
  };
  // `<` cannot appear in any value above, but a later edit should not be the
  // thing that discovers an inline script ends at the first `</`.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
