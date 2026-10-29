// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://hosted.example.test/"}
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CHECKOUT_KEY, CHECKOUT_TTL_MS, planOffers, takeCheckout, takeConfirmation } from "./billing";
import { FOUNDING_LADDER, LIST_ANNUAL, LIST_MONTHLY } from "../../website/src/lib/hosted-pricing.ts";

const at = (path: string) => history.replaceState(null, "", path);
const path = () => location.pathname + location.search;

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
});
afterEach(() => vi.useRealTimers());

it("takes a checkout link's plan and ref off the address bar, an unknown ref as other", () => {
  at("/checkout?plan=yearly&ref=settings-voice");
  expect(takeCheckout()).toEqual({ plan: "yearly", ref: "settings-voice" });
  expect(path()).toBe("/checkout");
  at("/checkout?plan=lifetime&ref=attacker-chosen");
  expect(takeCheckout()).toEqual({ plan: null, ref: "other" });
  expect(path()).toBe("/checkout");
});

it("keeps the checkout through a provider's sign-in for ten minutes, and nowhere else", () => {
  at("/checkout?plan=founding&ref=hosted-no-plan");
  takeCheckout();
  expect(Object.keys(JSON.parse(sessionStorage.getItem(CHECKOUT_KEY)!)).sort()).toEqual(["at", "plan", "ref"]);
  at("/enroll");
  expect(takeCheckout()).toBeNull();
  at("/billing");
  expect(takeCheckout()).toBeNull();
  for (const back of ["/account", "/login", "/checkout"]) {
    at(back);
    expect(takeCheckout(), back).toEqual({ plan: "founding", ref: "hosted-no-plan" });
  }
  vi.advanceTimersByTime(CHECKOUT_TTL_MS);
  at("/account");
  expect(takeCheckout()).toBeNull();
  expect(sessionStorage.getItem(CHECKOUT_KEY)).toBeNull();
  // A bare checkout link starts one of its own.
  at("/checkout");
  expect(takeCheckout()).toEqual({ plan: null, ref: null });
  at("/account");
  expect(takeCheckout()).toEqual({ plan: null, ref: null });
});

it("takes the checkout Stripe returned from off the address bar, ending the kept checkout", () => {
  at("/checkout?plan=monthly");
  takeCheckout();
  at("/billing?checkout=op_123");
  expect(takeConfirmation()).toBe("op_123");
  expect(path()).toBe("/billing");
  expect(sessionStorage.getItem(CHECKOUT_KEY)).toBeNull();
  at("/billing");
  expect(takeConfirmation()).toBeNull();
  at("/account?checkout=op_123");
  expect(takeConfirmation()).toBeNull();
  expect(path()).toBe("/account?checkout=op_123");
});

it("offers founding at the open cohort's step, and drops it once founding closes", () => {
  expect(planOffers({ cohort: 2, seatsLeft: 7 }).map(({ id, price }) => [id, price])).toEqual([
    ["founding", FOUNDING_LADDER[2]],
    ["yearly", LIST_ANNUAL],
    ["monthly", LIST_MONTHLY],
  ]);
  expect(planOffers(null).map(({ id }) => id)).toEqual(["yearly", "monthly"]);
});
