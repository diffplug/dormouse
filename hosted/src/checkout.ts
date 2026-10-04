import { BILLING_RETURN_PATH } from "../server/policy-constants";
import { isCheckoutPlan as isPlan, type CheckoutPlan as Plan } from "../../website/src/lib/hosted-pricing";
import { HOSTED_REF_PARAM, isHostedRef, type HostedRef } from "../../lib/src/lib/hosted-links";

// The plan a `/checkout?plan=` link asks for survives provider sign-in, which
// leaves the page, in this tab's session storage: a plan name and the
// allowlisted ref the link carried, nothing else.
const KEY = "dormouse-hosted-checkout";

/** The allowlisted ref the pending checkout's link carried, counted when it starts (docs/specs/hosted.md -> "Metrics"). */
let pendingRef: HostedRef | undefined;

/** The ref {@link takeCheckout} found, for the checkout it starts. */
export const checkoutRef = () => pendingRef;

/** How long a pending plan waits for a provider sign-in to come back. */
const PENDING_MS = 10 * 60 * 1000;

function remember(plan: Plan | null) {
  try {
    if (plan) sessionStorage.setItem(KEY, JSON.stringify({ plan, ref: pendingRef, at: Date.now() }));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Without storage, provider sign-in returns to the account page instead.
  }
}

/**
 * The checkout this load asks for: a plan from a `/checkout?plan=` link (null
 * for a link naming no plan sold), or one a provider sign-in carried back to
 * `/account`; undefined when none is pending.
 */
export function takeCheckout(): Plan | null | undefined {
  const { pathname, search } = location;
  if (pathname === "/checkout") {
    const query = new URLSearchParams(search);
    const plan = query.get("plan");
    const ref = query.get(HOSTED_REF_PARAM);
    pendingRef = isHostedRef(ref) ? ref : undefined;
    const sold = isPlan(plan) ? plan : null;
    remember(sold);
    return sold;
  }
  if (pathname !== "/account") return undefined;
  try {
    const { plan, ref, at } = JSON.parse(sessionStorage.getItem(KEY) ?? "{}");
    remember(null);
    if (!isPlan(plan) || !(Date.now() - at < PENDING_MS)) return undefined;
    pendingRef = isHostedRef(ref) ? ref : undefined;
    return plan;
  } catch {
    return undefined;
  }
}

/** Ends a pending checkout: bought, declined, or never valid. */
export const forgetCheckout = () => remember(null);

/** The checkout operation Stripe's return names (`/billing?checkout=`), taken off the address bar. */
export function takeReturn(): string | null {
  if (location.pathname !== BILLING_RETURN_PATH) return null;
  const checkout = new URLSearchParams(location.search).get("checkout");
  history.replaceState(null, "", BILLING_RETURN_PATH);
  return checkout;
}
