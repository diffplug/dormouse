import { BILLING_RETURN_PATH } from "../server/policy-constants";
import { isCheckoutPlan as isPlan, type CheckoutPlan as Plan } from "../../website/src/lib/hosted-pricing";

// The plan a `/checkout?plan=` link asks for survives provider sign-in, which
// leaves the page, in this tab's session storage: a plan name, nothing else.
const KEY = "dormouse-hosted-checkout";

function remember(plan: Plan | null) {
  try {
    if (plan) sessionStorage.setItem(KEY, plan);
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
    const plan = new URLSearchParams(search).get("plan");
    const sold = isPlan(plan) ? plan : null;
    remember(sold);
    return sold;
  }
  if (pathname !== "/account") return undefined;
  try {
    const plan = sessionStorage.getItem(KEY);
    return isPlan(plan) ? plan : undefined;
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
