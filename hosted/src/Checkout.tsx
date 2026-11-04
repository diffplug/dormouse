import { useState, type FormEvent } from "react";
import {
  ACCENT_BORDER_CLASS,
  CARD_CLASS,
  DASHED_ROW_CLASS,
  LINK_CLASS,
  MUTED_TEXT_CLASS,
} from "dormouse-lib/site/docs-tokens";
import { disclosure, renewalAgreement } from "../server/disclosure";
import { TERMS_VERSION, termsArchiveUrl, type Plan } from "../server/policy-constants";
import { planInterval, type Tier } from "../../website/src/lib/hosted-pricing.ts";
import type { BillingSummary } from "../server/billing-summary";
import { planOffers } from "./billing";
import { CHECK_CLASS, HELP_CLASS, PRIMARY_CLASS } from "./classes";
import { WithdrawalRight } from "./Withdrawal";

/** `$50/year`. */
export const perInterval = (price: number, interval: "month" | "year") => `$${price}/${interval}`;

/**
 * What the buyer agrees to beside the purchase action
 * (docs/specs/pricing.md -> "Checkout and entitlement"), for the chosen plan.
 */
function Terms({ offer }: { offer: Tier }) {
  return (
    <ul className={`mt-6 text-sm ${MUTED_TEXT_CLASS}`}>
      {Object.values(disclosure(offer.id, offer.price)).map((line) => (
        <li key={line} className={`py-2 leading-snug ${DASHED_ROW_CLASS}`}>
          {line}
        </li>
      ))}
    </ul>
  );
}

/**
 * The plans on sale, what each commits the buyer to, and the purchase action
 * behind affirmative agreement to the current terms and to automatic renewal.
 */
export function Checkout({
  billing,
  plan,
  busy,
  onPurchase,
}: {
  billing: BillingSummary;
  /** The plan the link named, chosen first when on sale. */
  plan: Plan | null;
  busy: string;
  /** With the price shown beside the renewal the buyer agreed to. */
  onPurchase: (plan: Plan, price: number) => void;
}) {
  const offers = planOffers(billing.founding);
  const [chosen, setChosen] = useState<Plan>(
    offers.find((offer) => offer.id === plan)?.id ?? offers[0]!.id,
  );
  const [terms, setTerms] = useState(false);
  const [renewal, setRenewal] = useState(false);
  const offer = offers.find((each) => each.id === chosen)!;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (terms && renewal && !busy) onPurchase(chosen, offer.price);
  }
  return (
    <form onSubmit={submit}>
      <fieldset>
        <legend className="mb-3 font-display text-xl">Choose a plan</legend>
        {billing.foundingLapsed && (
          <p className={HELP_CLASS}>Your founding price ended with your earlier subscription, so subscribing again is at the list price.</p>
        )}
        {offers.map((each) => (
          <label
            key={each.id}
            className={`${CARD_CLASS} mb-2 flex cursor-pointer items-start gap-3 ${each.id === chosen ? ACCENT_BORDER_CLASS : ""}`}
          >
            <input
              id={`${each.id}-plan`}
              type="radio"
              name="plan"
              value={each.id}
              className={CHECK_CLASS}
              checked={each.id === chosen}
              disabled={!!busy}
              onChange={() => {
                setChosen(each.id);
                // Renewal was agreed at the other plan's price and interval.
                setRenewal(false);
              }}
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-display text-lg">{each.name}</span>
                <span>
                  {each.listPrice && <s className={`mr-2 ${MUTED_TEXT_CLASS}`}>${each.listPrice}</s>}
                  <span className="font-display text-lg">{perInterval(each.price, planInterval(each.id))}</span>
                </span>
              </span>
              {each.id === "founding" && billing.founding && (
                <span className={`block text-sm ${MUTED_TEXT_CLASS}`}>
                  Locked while you stay subscribed. {billing.founding.seatsLeft} left at this price.
                </span>
              )}
              {each.id === "yearly" && (
                <span className={`block text-sm ${MUTED_TEXT_CLASS}`}>Two months free against monthly.</span>
              )}
            </span>
          </label>
        ))}
      </fieldset>
      <Terms offer={offer} />
      <WithdrawalRight />
      <label className="mt-6 flex items-start gap-3">
        <input
          id="agree-terms"
          type="checkbox"
          className={CHECK_CLASS}
          checked={terms}
          disabled={!!busy}
          onChange={(event) => setTerms(event.target.checked)}
        />
        <span>
          I agree to the{" "}
          <a className={LINK_CLASS} href={termsArchiveUrl(TERMS_VERSION)} target="_blank" rel="noreferrer">
            Dormouse Hosted Terms
          </a>{" "}
          (version {TERMS_VERSION}).
        </span>
      </label>
      <label className="mt-3 flex items-start gap-3">
        <input
          id="agree-renewal"
          type="checkbox"
          className={CHECK_CLASS}
          checked={renewal}
          disabled={!!busy}
          onChange={(event) => setRenewal(event.target.checked)}
        />
        <span>{renewalAgreement(offer.id, offer.price)}</span>
      </label>
      <button className={PRIMARY_CLASS} type="submit" disabled={!!busy || !terms || !renewal}>
        {busy === "checkout" ? "Opening checkout…" : "Continue to payment"}
      </button>
      <p className={`mt-3 ${HELP_CLASS}`}>
        You pay on Stripe’s checkout page. Dormouse never sees your card number.
      </p>
    </form>
  );
}
