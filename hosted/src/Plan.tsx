import { useState, type FormEvent, type ReactNode } from "react";
import { CARD_CLASS, LINK_CLASS, MUTED_TEXT_CLASS } from "dormouse-lib/site/docs-tokens";
import { isFounderName } from "../server/policy-constants";
import { planName, type BillingSummary } from "./billing";
import { perInterval } from "./Checkout";
import { BUTTON_CLASS, HEADING_CLASS, HELP_CLASS, INPUT_CLASS, LABEL_CLASS, LABEL_TEXT_CLASS } from "./classes";

const SUPPORT = "support@dormouse.sh";
const day = (iso: string) => new Date(iso).toLocaleDateString();
const interval = (billing: BillingSummary) => (billing.plan === "monthly" ? "month" : "year");

/** The held plan's state in one sentence; its lapsed copy branches on `entitled`. */
export function planStatus(billing: BillingSummary): string {
  if (billing.suspended)
    return "Paused while a payment dispute is open. It resumes if the dispute closes in your favor.";
  if (!billing.active)
    return billing.entitled
      ? "Your last payment did not go through. Your account keeps Hosted at no charge; update your card in Manage billing."
      : "Your last payment did not go through, so Natural Voice and the Hosted Relay are paused. Update your card in Manage billing.";
  if (!billing.until) return "Active.";
  return billing.renews
    ? `Renews automatically on ${day(billing.until)}${billing.price ? ` at $${billing.price} plus any applicable tax` : ""}, until you cancel.`
    : `Ends on ${day(billing.until)}. It will not renew.`;
}

function ManageBilling({ busy, onManage }: { busy: string; onManage: () => void }) {
  return (
    <button className={BUTTON_CLASS} disabled={!!busy} onClick={onManage}>
      {busy === "portal" ? "Opening…" : "Manage billing"}
    </button>
  );
}

/**
 * The founders row's opt-in: unticked until the account ticks it, and
 * offered only while a founding subscription grants access. One already
 * shown may always leave.
 */
export function FoundersOptIn({
  billing,
  defaultName,
  busy,
  onSave,
}: {
  billing: BillingSummary;
  /** The account's own name, offered while it is one the row can show. */
  defaultName: string;
  busy: string;
  onSave: (shown: boolean, name: string) => void;
}) {
  const { offered, name: shownAs } = billing.founder;
  const [shown, setShown] = useState(shownAs !== null);
  const [name, setName] = useState(shownAs ?? (isFounderName(defaultName.trim()) ? defaultName.trim() : ""));
  if (!offered && shownAs === null) return null;
  const valid = !shown || isFounderName(name.trim());
  const unchanged = shown === (shownAs !== null) && (!shown || name.trim() === shownAs);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (valid && !unchanged && !busy) onSave(shown, name.trim());
  }
  if (!offered)
    return (
      <div className="mt-6">
        <p className={HELP_CLASS}>You are in the founders row as {shownAs}.</p>
        <button className={BUTTON_CLASS} disabled={!!busy} onClick={() => onSave(false, "")}>
          {busy === "founder" ? "Saving…" : "Leave the founders row"}
        </button>
      </div>
    );
  return (
    <form className="mt-6" onSubmit={submit} aria-label="Founders row">
      <label className="flex items-start gap-3">
        <input
          id="founder-shown"
          type="checkbox"
          className="mt-1 size-4 shrink-0 accent-[var(--docs-accent)]"
          checked={shown}
          disabled={!!busy}
          onChange={(event) => setShown(event.target.checked)}
        />
        <span>Show me in the founders row on the Hosted page</span>
      </label>
      {shown && (
        <>
          <label htmlFor="founder-name" className={LABEL_CLASS}>
            Name to show
          </label>
          <input
            id="founder-name"
            className={INPUT_CLASS}
            value={name}
            autoComplete="name"
            disabled={!!busy}
            onChange={(event) => setName(event.target.value)}
          />
        </>
      )}
      <p className={`mt-3 ${HELP_CLASS}`}>
        {valid
          ? "The row shows the name you choose and your profile picture, if you have one. Untick to leave it at any time."
          : "Use 1 to 64 characters."}
      </p>
      <button className={BUTTON_CLASS} type="submit" disabled={!!busy || !valid || unchanged}>
        {busy === "founder" ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

/** The account page's plan section; billing closed, the page has none. */
export function PlanSection({
  billing,
  busy,
  onManage,
  children,
}: {
  billing: BillingSummary;
  busy: string;
  onManage: () => void;
  /** The founders opt-in. */
  children?: ReactNode;
}) {
  return (
    <>
      <h2 id="plan" className={HEADING_CLASS}>Plan</h2>
      {billing.plan ? (
        <>
          <p className="mb-1">
            {planName(billing.plan)}
            {billing.price ? ` · ${perInterval(billing.price, interval(billing))}` : ""}
          </p>
          <p className={HELP_CLASS}>{planStatus(billing)}</p>
          <ManageBilling busy={busy} onManage={onManage} />
          {children}
        </>
      ) : billing.entitled ? (
        <p className={HELP_CLASS}>Your account has Hosted at no charge.</p>
      ) : (
        <>
          <p className={HELP_CLASS}>
            No plan yet. Hosted adds Natural Voice and the Hosted Relay to every computer you sign in on.
          </p>
          <a className={BUTTON_CLASS} href="/checkout">
            Choose a plan
          </a>
          {children}
        </>
      )}
    </>
  );
}

/**
 * The durable confirmation `/billing` shows for the held plan, as long as the
 * account holds it (docs/specs/pricing.md -> "Paid-launch requirements"):
 * the plan and price, renewal, what was agreed and when, how to cancel, and
 * refunds.
 */
export function PlanConfirmation({
  billing,
  busy,
  onManage,
}: {
  billing: BillingSummary & { plan: NonNullable<BillingSummary["plan"]> };
  busy: string;
  onManage: () => void;
}) {
  const rows: [string, ReactNode][] = [
    ["Plan", `${planName(billing.plan)}${billing.price ? ` · ${perInterval(billing.price, interval(billing))}` : ""}`],
    ["Status", planStatus(billing)],
    ...(billing.consent
      ? ([
          [
            "You agreed",
            `To the Terms (version ${billing.consent.termsVersion}) and to automatic renewal, on ${new Date(
              billing.consent.consentedAt,
            ).toLocaleString()}.`,
          ],
        ] as [string, ReactNode][])
      : []),
    [
      "Cancel",
      "Any time in Manage billing. You keep Hosted until the end of the period you paid for.",
    ],
    [
      "Refunds",
      <>
        {billing.plan === "monthly"
          ? "Within 30 days of your first payment"
          : "Within 30 days of your first payment or of a yearly renewal"}
        , email{" "}
        <a className={LINK_CLASS} href={`mailto:${SUPPORT}`}>
          {SUPPORT}
        </a>{" "}
        for a full refund, which ends the plan.
      </>,
    ],
    ["Receipt", "Stripe emails a receipt for each payment to your billing email."],
  ];
  return (
    <div className={CARD_CLASS}>
      <dl>
        {rows.map(([term, detail], index) => (
          <div key={term} className={index ? "mt-4" : ""}>
            <dt className={LABEL_TEXT_CLASS}>{term}</dt>
            <dd className={`[overflow-wrap:anywhere] ${term === "Plan" ? "" : MUTED_TEXT_CLASS}`}>{detail}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-6">
        <ManageBilling busy={busy} onManage={onManage} />
      </div>
    </div>
  );
}
