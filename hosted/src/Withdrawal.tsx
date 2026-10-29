import { useState, type ReactNode } from "react";
import { CARD_ACCENT_CLASS, CARD_CLASS, LINK_CLASS, MUTED_TEXT_CLASS } from "dormouse-lib/site/docs-tokens";
import { MODEL_WITHDRAWAL_FORM, SUPPORT_EMAIL, WITHDRAWAL_STATEMENT } from "../../website/src/lib/hosted-withdrawal";
import { PLAN_NAMES } from "../../website/src/lib/hosted-pricing.ts";
import type { WithdrawalOffer, Withdrawn } from "../server/billing-summary";
import { isPlan } from "../server/policy-constants";
import { BUTTON_CLASS, HEADING_CLASS, HELP_CLASS, LABEL_TEXT_CLASS, PRIMARY_CLASS } from "./classes";

const TERMS_WITHDRAWAL_URL = "https://dormouse.sh/terms/#withdrawal";
const day = (iso: string) => new Date(iso).toLocaleDateString();
const contract = (plan: string, startedAt: string) =>
  `Dormouse Hosted, ${isPlan(plan) ? PLAN_NAMES[plan] : plan}, ordered on ${day(startedAt)}`;

export const SupportLink = () => (
  <a className={LINK_CLASS} href={`mailto:${SUPPORT_EMAIL}`}>
    {SUPPORT_EMAIL}
  </a>
);

/** The optional model withdrawal form, folded, with the Terms' section beside it. */
export function ModelForm() {
  return (
    <details className="mt-2">
      <summary className={`cursor-pointer ${LINK_CLASS}`}>Model withdrawal form</summary>
      <p className="mt-2">You may copy this into an email or a letter. Using it is optional.</p>
      <blockquote className="mt-2 border-l-2 border-[var(--color-text)]/25 pl-3 [overflow-wrap:anywhere]">
        {MODEL_WITHDRAWAL_FORM}
      </blockquote>
      <p className="mt-2">
        The{" "}
        <a className={LINK_CLASS} href={TERMS_WITHDRAWAL_URL} target="_blank" rel="noreferrer">
          Terms
        </a>{" "}
        describe the right in full.
      </p>
    </details>
  );
}

/**
 * The EEA and UK withdrawal right as checkout discloses it before purchase
 * (docs/specs/pricing.md -> "Checkout and entitlement"): what it gives, where
 * the online withdrawal is, the support path, and the model form.
 */
export function WithdrawalRight() {
  return (
    <div className={`mt-4 text-sm ${MUTED_TEXT_CLASS}`}>
      <p>
        In the EEA or UK, you can withdraw within 14 days of buying without giving a reason, and we refund every payment,
        including tax, with no deduction for the time you used. Use Withdraw from contract on your billing page, or email{" "}
        <SupportLink />, even if you can no longer sign in.
      </p>
      <ModelForm />
    </div>
  );
}

/**
 * The online withdrawal function the billing page offers while the
 * withdrawal is open: the consumer sees which contract it ends, where the
 * acknowledgement goes, and the statement, then confirms. Distinct from
 * cancelling renewal, which the portal does.
 */
export function WithdrawalFunction({
  offer,
  plan,
  busy,
  onWithdraw,
}: {
  offer: WithdrawalOffer;
  plan: string;
  busy: string;
  onWithdraw: (subscription: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const rows: [string, ReactNode][] = [
    ["Contract", contract(plan, offer.startedAt)],
    ["Contract reference", offer.subscription],
    ["Your statement", WITHDRAWAL_STATEMENT],
    ["Acknowledgement sent to", offer.email ?? "the email on your Stripe receipts"],
  ];
  return (
    <section id="withdraw" aria-labelledby="withdraw-title" className={`mt-6 ${CARD_ACCENT_CLASS}`}>
      <h2 id="withdraw-title" className={HEADING_CLASS}>
        Withdraw from contract
      </h2>
      <p className={HELP_CLASS}>
        You can withdraw from this contract until {day(offer.until)}, without giving a reason. Your plan ends straight away,
        and we refund every payment for it in full, including tax, within 14 days. This is not the same as cancelling
        renewal in Manage billing, which keeps Hosted until the end of the period you paid for.
      </p>
      {confirming ? (
        <>
          <dl className="mb-2">
            {rows.map(([term, detail]) => (
              <div key={term} className="mt-3">
                <dt className={LABEL_TEXT_CLASS}>{term}</dt>
                <dd className="[overflow-wrap:anywhere]">{detail}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap items-center gap-3">
            <button className={PRIMARY_CLASS} disabled={!!busy} onClick={() => onWithdraw(offer.subscription)}>
              {busy === "withdraw" ? "Withdrawing…" : "Confirm withdrawal"}
            </button>
            <button className={`mt-5 ${BUTTON_CLASS}`} disabled={!!busy} onClick={() => setConfirming(false)}>
              Keep my plan
            </button>
          </div>
        </>
      ) : (
        <button className={BUTTON_CLASS} disabled={!!busy} onClick={() => setConfirming(true)}>
          Withdraw from contract
        </button>
      )}
    </section>
  );
}

/** The acknowledgement of the account's latest withdrawal, kept on the billing page. */
export function WithdrawalAcknowledgement({ withdrawn }: { withdrawn: Withdrawn }) {
  const rows: [string, string][] = [
    ["Your statement", WITHDRAWAL_STATEMENT],
    ["Submitted", new Date(withdrawn.submittedAt).toLocaleString(undefined, { timeZoneName: "short" })],
    ["Contract", contract(withdrawn.plan, withdrawn.startedAt)],
    ["Reference", withdrawn.reference],
  ];
  return (
    <section aria-labelledby="withdrawn-title" className={`mb-6 ${CARD_CLASS}`}>
      <h2 id="withdrawn-title" className={HEADING_CLASS}>
        Withdrawal received
      </h2>
      <dl>
        {rows.map(([term, detail]) => (
          <div key={term} className="mt-3">
            <dt className={LABEL_TEXT_CLASS}>{term}</dt>
            <dd className="[overflow-wrap:anywhere]">{detail}</dd>
          </div>
        ))}
      </dl>
      <p className={`mt-4 ${MUTED_TEXT_CLASS}`}>
        {withdrawn.settled
          ? "Your plan has ended. We refunded every payment for it in full, including tax; your bank or card provider decides when the credit appears."
          : "Your plan ends with this withdrawal. We refund every payment for it in full, including tax, within 14 days."}
      </p>
      <p className={`mt-2 ${MUTED_TEXT_CLASS}`}>
        {withdrawn.acknowledged
          ? "We emailed this acknowledgement to your billing email. Keep it as your record."
          : "We are emailing this acknowledgement to your billing email. You can also print or save this page."}{" "}
        Questions: <SupportLink />.
      </p>
    </section>
  );
}
