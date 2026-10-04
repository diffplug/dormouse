// Node-side only: StripeDev runs an HTTP server, so no Worker entry imports this.
import { createStripeDev } from "@pgstencil/stripe/testing";
import type { RandomSource, Time } from "pgstencil";
import { FOUNDING_LADDER } from "../../website/src/lib/hosted-pricing";
import type { BillingSetup } from "./billing";

/** StripeDev's founding Prices, one per ladder step. */
export const DEV_FOUNDING_PRICES = FOUNDING_LADDER.map((price) => `price_founding_${price}`);

/**
 * StripeDev, a local Stripe stand-in that takes no card and charges nothing,
 * with the founding ladder's Prices, and the billing setup that runs on it:
 * the dev loop's and the tests'.
 */
export async function stripeDevBilling(time: Time, random: RandomSource, statePath?: string) {
  const dev = await createStripeDev(time, random, statePath, {
    recurring: Object.fromEntries(DEV_FOUNDING_PRICES.map((price) => [price, "year" as const])),
  });
  const setup: BillingSetup = {
    secretKey: "sk_test_dormouse_local_only",
    webhookSecret: dev.webhookSecret,
    live: false,
    monthly: dev.prices.monthly,
    yearly: dev.prices.yearly,
    founding: DEV_FOUNDING_PRICES,
    stripe: dev.stripe,
  };
  return { dev, setup };
}
