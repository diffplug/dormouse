import { BILLING_RETURN_PATH } from "../server/policy-constants";
import { isCheckoutPlan as isPlan, type CheckoutPlan as Plan } from "../../website/src/lib/hosted-pricing";
import { HOSTED_REF_PARAM, isHostedRef, type HostedRef } from "../../lib/src/lib/hosted-links";

// The plan a `/checkout?plan=` link asks for survives provider sign-in, which
// leaves the page, in this tab's session storage: a plan name and the
// allowlisted ref the link carried, nothing else.
const KEY = "dormouse-hosted-checkout";

/** How long a pending plan waits for a provider sign-in to come back. */
const PENDING_MS = 10 * 60 * 1000;

/** A pending checkout: its plan (null for a link naming none sold) and its link's allowlisted ref, counted when it starts (docs/specs/hosted.md -> "Metrics"). */
export interface PendingCheckout {
  plan: Plan | null;
  ref?: HostedRef;
}

const refOf = (ref: unknown) => (isHostedRef(ref) ? ref : undefined);

function remember(pending: PendingCheckout | null) {
  try {
    if (pending?.plan) sessionStorage.setItem(KEY, JSON.stringify({ ...pending, at: Date.now() }));
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
export function takeCheckout(): PendingCheckout | undefined {
  const { pathname, search } = location;
  if (pathname === "/checkout") {
    const query = new URLSearchParams(search);
    const plan = query.get("plan");
    const pending = { plan: isPlan(plan) ? plan : null, ref: refOf(query.get(HOSTED_REF_PARAM)) };
    remember(pending);
    return pending;
  }
  if (pathname !== "/account") return undefined;
  try {
    const { plan, ref, at } = JSON.parse(sessionStorage.getItem(KEY) ?? "{}");
    remember(null);
    return isPlan(plan) && Date.now() - at < PENDING_MS ? { plan, ref: refOf(ref) } : undefined;
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
