// Node-side only: StripeDev runs an HTTP server, so no Worker entry imports this.
import { createStripeDev } from "@pgstencil/stripe/testing";
import type { RandomSource, Time } from "pgstencil";
import { FOUNDING_LADDER, LIST_ANNUAL, LIST_MONTHLY } from "../../website/src/lib/hosted-pricing";
import type { BillingSetup } from "./billing";

/** StripeDev's founding Prices, one per ladder step. */
export const DEV_FOUNDING_PRICES = FOUNDING_LADDER.map((price) => `price_founding_${price}`);

/**
 * StripeDev, a local Stripe stand-in that takes no card and charges nothing,
 * with the founding ladder's yearly Prices and any `recurring` beside them,
 * and the billing setup that runs on it.
 */
export async function stripeDevBilling(
  time: Time,
  random: RandomSource,
  statePath?: string,
  recurring: Record<string, "month" | "year"> = {},
) {
  const dev = await createStripeDev(time, random, statePath, {
    recurring: { ...Object.fromEntries(DEV_FOUNDING_PRICES.map((price) => [price, "year" as const])), ...recurring },
  });
  // StripeDev models no Price retrieval, which checkout reads what it would
  // charge from; its Prices are the published ones.
  const published = new Map<string, [number, "month" | "year"]>([
    [dev.prices.monthly, [LIST_MONTHLY, "month"]],
    [dev.prices.yearly, [LIST_ANNUAL, "year"]],
    ...DEV_FOUNDING_PRICES.map((price, step) => [price, [FOUNDING_LADDER[step]!, "year"]] as [string, [number, "year"]]),
  ]);
  dev.stripe.prices.retrieve = (async (id: string) => {
    const [usd, interval] = published.get(id) ?? [];
    if (!usd) throw new Error(`StripeDev holds no Price ${id}`);
    return { id, currency: "usd", unit_amount: usd * 100, livemode: false, recurring: { interval, interval_count: 1 } };
  }) as never;
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
