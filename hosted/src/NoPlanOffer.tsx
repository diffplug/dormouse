import { useState, type ReactNode } from "react";
import { PlanCards } from "../../website/src/components/PlanCards.tsx";
import { useCohort } from "../../website/src/lib/hosted-cohorts.ts";
import { foundingTier } from "../../website/src/lib/hosted-pricing.ts";
import { SITE_ORIGIN } from "../../website/src/lib/site-meta.ts";
import type { BillingSummary } from "../server/billing-summary";
import type { Plan } from "../server/policy-constants";
import { foundingOffer } from "./billing";
import { TEXT_BUTTON_CLASS } from "./classes";

/**
 * The Hosted page's plan cards, for the account that could not approve this
 * computer; a buy button opens checkout for its plan here. Stripe returns to
 * `/billing`, leaving the code behind, so Dormouse's link opens this page
 * again afterwards.
 */
export function NoPlanOffer({
  billing,
  checkout,
}: {
  /** Null while billing is closed or unread. */
  billing: BillingSummary | null;
  /** Checkout for the plan a card's button chose. */
  checkout: (plan: Plan) => ReactNode;
}) {
  const [buying, setBuying] = useState<Plan | null>(null);
  const cohort = useCohort();

  if (buying)
    return (
      <div className="max-w-[30rem]">
        {checkout(buying)}
        <button type="button" className={`mt-6 flex ${TEXT_BUTTON_CLASS}`} onClick={() => setBuying(null)}>
          Back to the plans
        </button>
      </div>
    );
  return (
    <PlanCards
      site={SITE_ORIGIN}
      // Founding as checkout sells it to this account, with that cohort's seats.
      founding={billing ? foundingOffer(billing.founding) : foundingTier()}
      cohort={billing?.founding ? { ...cohort, seatsLeft: billing.founding.seatsLeft } : cohort}
      buy={{ onBuy: (tier) => setBuying(tier.id), href: () => null }}
      free={{ label: "Self-host", path: "/self-host", footnote: "Run your own Relay" }}
    />
  );
}
