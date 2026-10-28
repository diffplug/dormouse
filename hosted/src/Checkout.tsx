import { useState, type FormEvent } from "react";
import {
  ACCENT_BORDER_CLASS,
  CARD_CLASS,
  DASHED_ROW_CLASS,
  LINK_CLASS,
  MUTED_TEXT_CLASS,
} from "dormouse-lib/site/docs-tokens";
import { TERMS_VERSION, VOICE_DAILY_CAP } from "../server/policy-constants";
import { planOffers, type BillingSummary, type Plan, type PlanOffer } from "./billing";
import { HELP_CLASS, PRIMARY_CLASS } from "./classes";
import { WithdrawalRight } from "./Withdrawal";

const TERMS_URL = "https://dormouse.sh/terms/";
const CHECK_CLASS = "mt-1 size-4 shrink-0 accent-[var(--docs-accent)]";

/** `$50/year`. */
export const perInterval = (price: number, interval: "month" | "year") => `$${price}/${interval}`;

/**
 * What the buyer agrees to beside the purchase action
 * (docs/specs/pricing.md -> "Checkout and entitlement"): price and tax,
 * renewal, cancellation, refunds, and material limits, for the chosen plan.
 */
function Terms({ offer }: { offer: PlanOffer }) {
  const every = offer.interval === "year" ? "every year" : "every month";
  return (
    <ul className={`mt-6 text-sm ${MUTED_TEXT_CLASS}`}>
      {[
        `$${offer.price} a ${offer.interval}, plus any applicable tax. Stripe shows the total before you pay.`,
        `Renews automatically ${every} at $${offer.price} until you cancel.${
          offer.plan === "founding" ? " Your founding price stays for as long as your subscription does." : ""
        }`,
        "Cancel any time from your account page. You keep Hosted until the end of the period you paid for.",
        offer.interval === "year"
          ? "Ask within 30 days of your first payment or of a yearly renewal for a full refund, which ends the plan."
          : "Ask within 30 days of your first payment for a full refund, which ends the plan. Monthly renewals are outside this guarantee.",
        `For one person, including work use, with no device limit. Natural Voice speaks up to ${VOICE_DAILY_CAP} alarms a day; past that, alarms use the system voice.`,
      ].map((line) => (
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
    offers.find((offer) => offer.plan === plan)?.plan ?? offers[0]!.plan,
  );
  const [terms, setTerms] = useState(false);
  const [renewal, setRenewal] = useState(false);
  const offer = offers.find((each) => each.plan === chosen)!;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (terms && renewal && !busy) onPurchase(chosen, offer.price);
  }
  return (
    <form onSubmit={submit}>
      <fieldset>
        <legend className="mb-3 font-display text-xl">Choose a plan</legend>
        {offers.map((each) => (
          <label
            key={each.plan}
            className={`${CARD_CLASS} mb-2 flex cursor-pointer items-start gap-3 ${each.plan === chosen ? ACCENT_BORDER_CLASS : ""}`}
          >
            <input
              id={`${each.plan}-plan`}
              type="radio"
              name="plan"
              value={each.plan}
              className={CHECK_CLASS}
              checked={each.plan === chosen}
              disabled={!!busy}
              onChange={() => {
                setChosen(each.plan);
                // Renewal was agreed at the other plan's price and interval.
                setRenewal(false);
              }}
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-display text-lg">{each.name}</span>
                <span>
                  {each.listPrice && <s className={`mr-2 ${MUTED_TEXT_CLASS}`}>${each.listPrice}</s>}
                  <span className="font-display text-lg">{perInterval(each.price, each.interval)}</span>
                </span>
              </span>
              {each.plan === "founding" && billing.founding && (
                <span className={`block text-sm ${MUTED_TEXT_CLASS}`}>
                  Locked while you stay subscribed. {billing.founding.seatsLeft} left at this price.
                </span>
              )}
              {each.plan === "yearly" && (
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
          <a className={LINK_CLASS} href={TERMS_URL} target="_blank" rel="noreferrer">
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
        <span>
          I agree that my subscription renews automatically {offer.interval === "year" ? "every year" : "every month"} at $
          {offer.price} plus any applicable tax until I cancel.
        </span>
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
