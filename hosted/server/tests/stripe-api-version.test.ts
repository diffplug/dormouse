import { expect, test } from "vitest";
import { STRIPE_API_VERSION } from "@pgstencil/stripe";

/** The Stripe API version production's webhook endpoint renders events at. */
const PINNED = "2026-08-26.dahlia";

test("the Stripe API version the webhook accepts is the one production's endpoint sends", () => {
  expect(
    STRIPE_API_VERSION,
    `The installed stripe SDK's pinned API version moved from ${PINNED} to ${STRIPE_API_VERSION}. ` +
      `Production's webhook endpoint still renders events at ${PINNED}, and the webhook refuses every other version, ` +
      `so deploying this would refuse every billing event. Follow hosted/README.md -> "Move the Stripe API version"; ` +
      `change this literal only as part of that procedure.`,
  ).toBe(PINNED);
});
