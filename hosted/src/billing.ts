import { HOSTED_REF_PARAM, isHostedRef, type HostedRef } from "dormouse-lib/lib/hosted-links";
import {
  FOUNDING_LADDER,
  HOSTED_MONTHLY,
  HOSTED_YEARLY,
  foundingTier,
  type Tier,
} from "../../website/src/lib/hosted-pricing.ts";
import type { BillingSummary } from "../server/billing-summary";
import { REFUND_DAYS, isPlan, type Plan } from "../server/policy-constants";

/** A date as the account pages show it, in the reader's locale. */
export const day = (iso: string) => new Date(iso).toLocaleDateString();

/** How long after which payments of `plan` the 30-day guarantee refunds it, as the pages say it. */
export const refundWindow = (plan: Plan) =>
  `${REFUND_DAYS} days of your first payment${plan === "monthly" ? "" : " or of a yearly renewal"}`;

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

/**
 * Each plan on sale, founding first while open, at the price checkout will
 * charge: founding at the open cohort's step, which the server reads.
 */
export function planOffers(founding: BillingSummary["founding"]): Tier[] {
  const step = founding && FOUNDING_LADDER[founding.cohort];
  return [...(step ? [{ ...foundingTier(), price: step }] : []), HOSTED_YEARLY, HOSTED_MONTHLY];
}
