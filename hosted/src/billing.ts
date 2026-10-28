import { HOSTED_REF_PARAM, isHostedRef, type HostedRef } from "dormouse-lib/lib/hosted-links";
import {
  FOUNDING_LADDER,
  HOSTED_MONTHLY,
  HOSTED_YEARLY,
  LIST_ANNUAL,
} from "../../website/src/lib/hosted-pricing.ts";
import { BILLING_PLANS } from "../server/policy-constants";

export type Plan = (typeof BILLING_PLANS)[number];
export const isPlan = (plan: unknown): plan is Plan => (BILLING_PLANS as readonly unknown[]).includes(plan);

/** `GET /api/billing` (docs/specs/hosted.md -> "Billing"). */
export interface BillingSummary {
  /** The subscription Stripe still holds, paid up or not; null without one. */
  plan: Plan | null;
  /** What that subscription charges per interval, in whole US dollars. */
  price: number | null;
  /** Whether that subscription grants access now. */
  active: boolean;
  until: string | null;
  renews: boolean;
  /** Whether the account has Hosted now, by its subscription or a comp. */
  entitled: boolean;
  /** A payment dispute is open, which pauses the subscription. */
  suspended: boolean;
  /** The founding cohort on sale; null once founding has closed. */
  founding: { cohort: number; seatsLeft: number } | null;
  /** `offered` while a founding subscription grants access; `name` while shown in the founders row. */
  founder: { offered: boolean; name: string | null };
  /** What the account agreed to when it bought the held subscription. */
  consent: { termsVersion: string; consentedAt: string } | null;
}

/** What `/checkout` arrived with, kept through a provider's sign-in. */
export interface CheckoutIntent {
  plan: Plan | null;
  /** Which link sent the buyer: one of `HOSTED_REFS`, `other`, or none. */
  ref: HostedRef | "other" | null;
}

// Provider sign-in returns to `/account`, so the plan and ref ride this tab's
// storage for a little while; nothing else does.
export const CHECKOUT_KEY = "dormouse-hosted-checkout";
export const CHECKOUT_TTL_MS = 10 * 60_000;

function save(intent: CheckoutIntent) {
  try {
    sessionStorage.setItem(CHECKOUT_KEY, JSON.stringify({ ...intent, at: Date.now() }));
  } catch {
    // Storage blocked: provider sign-in lands on the account page instead.
  }
}

function stored(): CheckoutIntent | null {
  let value: unknown;
  try {
    value = JSON.parse(sessionStorage.getItem(CHECKOUT_KEY) ?? "null");
  } catch {
    return null;
  }
  const { plan, ref, at } = (value ?? {}) as { plan?: unknown; ref?: unknown; at?: unknown };
  const age = typeof at === "number" ? Date.now() - at : Infinity;
  if (!(age >= 0 && age < CHECKOUT_TTL_MS)) {
    forgetCheckout();
    return null;
  }
  return { plan: isPlan(plan) ? plan : null, ref: isHostedRef(ref) || ref === "other" ? ref : null };
}

/** Ends the checkout this tab was on, so the account page stays the account page. */
export function forgetCheckout() {
  try {
    sessionStorage.removeItem(CHECKOUT_KEY);
  } catch {
    // Nothing was kept.
  }
}

/**
 * The checkout this load continues, or null. On `/checkout` its `plan` and
 * `ref` come off the address bar, so a copied link never carries the ref;
 * back from a provider's sign-in (`/account`, or `/login` after a failed
 * one), they come from storage while still fresh.
 */
export function takeCheckout(): CheckoutIntent | null {
  const { pathname, search } = location;
  if (pathname === "/checkout") {
    const params = new URLSearchParams(search);
    const kept = !params.has("plan") && !params.has(HOSTED_REF_PARAM) && stored();
    if (kept) return kept;
    const plan = params.get("plan");
    const ref = params.get(HOSTED_REF_PARAM);
    const intent: CheckoutIntent = {
      plan: isPlan(plan) ? plan : null,
      ref: ref === null ? null : isHostedRef(ref) ? ref : "other",
    };
    history.replaceState(null, "", pathname);
    save(intent);
    return intent;
  }
  return pathname === "/account" || pathname === "/login" ? stored() : null;
}

/**
 * The checkout Stripe returned from on `/billing?checkout=`, taken off the
 * address bar so a reload or a bookmark never confirms it again; null
 * anywhere else.
 */
export function takeConfirmation(): string | null {
  if (location.pathname !== "/billing") return null;
  const checkout = new URLSearchParams(location.search).get("checkout");
  history.replaceState(null, "", location.pathname);
  if (checkout !== null) forgetCheckout();
  return checkout || null;
}

/** One plan as the checkout page offers it, at today's price. */
export interface PlanOffer {
  plan: Plan;
  name: string;
  price: number;
  interval: "month" | "year";
  /** The list price struck beside founding. */
  listPrice?: number;
}

/**
 * Each plan on sale, founding first while open, at the price checkout will
 * charge: founding at the open cohort's step, which the server reads.
 */
export function planOffers(founding: BillingSummary["founding"]): PlanOffer[] {
  const step = founding && FOUNDING_LADDER[founding.cohort];
  return [
    ...(step ? [{ plan: "founding" as const, name: "Founding", price: step, interval: "year" as const, listPrice: LIST_ANNUAL }] : []),
    { plan: "yearly", name: HOSTED_YEARLY.name, price: HOSTED_YEARLY.price, interval: "year" },
    { plan: "monthly", name: HOSTED_MONTHLY.name, price: HOSTED_MONTHLY.price, interval: "month" },
  ];
}

/** A plan's name as the account page shows it. */
export const planName = (plan: Plan) =>
  plan === "founding" ? "Founding" : plan === "yearly" ? HOSTED_YEARLY.name : HOSTED_MONTHLY.name;
