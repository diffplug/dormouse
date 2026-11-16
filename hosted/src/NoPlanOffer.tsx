import { useEffect, useState, type ReactNode } from "react";
import { ACTION_CLASS } from "dormouse-lib/site/docs-tokens";
import { PlanCards } from "../../website/src/components/PlanCards.tsx";
import { fetchCohort, type Cohort } from "../../website/src/lib/hosted-cohorts.ts";
import { foundingTier } from "../../website/src/lib/hosted-pricing.ts";
import { SITE_ORIGIN } from "../../website/src/lib/site-meta.ts";
import type { BillingSummary } from "../server/billing-summary";
import type { Plan } from "../server/policy-constants";
import { planOffers } from "./billing";
import { Checkout } from "./Checkout";
import { TEXT_BUTTON_CLASS } from "./classes";

const SELF_HOST_URL = `${SITE_ORIGIN}/self-host/`;

/**
 * The Hosted page's plan cards, for the account that could not approve this
 * computer; a buy button opens checkout for its plan here. Stripe returns to
 * `/billing`, leaving the code behind, so Dormouse's link opens this page
 * again afterwards.
 */
export function NoPlanOffer({
  billing,
  busy,
  unread,
  onPurchase,
}: {
  billing: BillingSummary | null;
  busy: string;
  /** What shows in place of checkout while billing is closed or unread. */
  unread: ReactNode;
  onPurchase: (plan: Plan, price: number) => void;
}) {
  const [buying, setBuying] = useState<Plan | null>(null);
  const [cohort, setCohort] = useState<Cohort>({ seatsLeft: null, founders: null });
  useEffect(() => {
    const controller = new AbortController();
    void fetchCohort(controller.signal).then(setCohort);
    return () => controller.abort();
  }, []);

  if (buying)
    return (
      <div className="max-w-[30rem]">
        {billing ? (
          <Checkout key={billing.founding?.cohort ?? "closed"} billing={billing} plan={buying} busy={busy} onPurchase={onPurchase} />
        ) : (
          unread
        )}
        <button type="button" className={`mt-6 flex ${TEXT_BUTTON_CLASS}`} disabled={!!busy} onClick={() => setBuying(null)}>
          Back to the plans
        </button>
      </div>
    );
  // Founding as checkout sells it to this account: at the server's open
  // cohort, and never to a lapsed founder or once the ladder has closed.
  const founding = billing ? (planOffers(billing.founding).find((offer) => offer.id === "founding") ?? null) : foundingTier();
  return (
    <PlanCards
      site={SITE_ORIGIN}
      cohort={billing?.founding ? { ...cohort, seatsLeft: billing.founding.seatsLeft } : cohort}
      founding={founding}
      buy={{ onBuy: (tier) => setBuying(tier.id), href: () => null }}
      free={{
        action: (
          <a className={ACTION_CLASS} href={SELF_HOST_URL} target="_blank" rel="noopener">
            Self-host
          </a>
        ),
        footnote: "Run your own Relay",
      }}
    />
  );
}
