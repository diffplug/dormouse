import { useState, type FormEvent, type ReactNode } from "react";
import {
  FOUNDING_LADDER,
  HOSTED_MONTHLY,
  HOSTED_YEARLY,
  LIST_ANNUAL,
  foundingTier,
} from "../../website/src/lib/hosted-pricing";
import type { BillingSummary, Plan, SurveyAnswers } from "./api";
import { ADD_A_COMPUTER } from "./enrollment";

// The account pages billing adds (docs/specs/hosted.md -> "Billing"). Prices
// come from the website's one owner of them; the founding step from the
// server's open cohort.

export const PLAN_NAMES: Record<Plan, string> = {
  monthly: HOSTED_MONTHLY.name,
  yearly: HOSTED_YEARLY.name,
  founding: foundingTier().name,
};

/** What `plan` costs now, or null for founding once it has closed. */
function priceOf(plan: Plan, cohort: number | null): string | null {
  if (plan === "monthly") return `$${HOSTED_MONTHLY.price} a month`;
  if (plan === "yearly") return `$${HOSTED_YEARLY.price} a year`;
  const step = cohort === null ? undefined : FOUNDING_LADDER[cohort];
  return step === undefined ? null : `$${step} a year, against $${LIST_ANNUAL} list`;
}

/** The plans, on the marketing site, whose buy buttons come back to `/checkout`. */
export const PLANS_PAGE = "https://dormouse.sh/hosted#pricing";
const date = (iso: string) => new Date(iso).toLocaleDateString();

interface Shared {
  busy: string;
  act: (label: string, action: () => Promise<void>) => Promise<void>;
}

/** Opens the customer portal. */
function PortalButton({ busy, act, onPortal, primary }: Shared & { onPortal: () => Promise<void>; primary?: boolean }) {
  return (
    <button className={primary ? "primary" : undefined} disabled={!!busy} onClick={() => void act("portal", onPortal)}>
      {busy === "portal" ? "Opening…" : "Manage billing"}
    </button>
  );
}

/** `/checkout?plan=`: the plan and its price now, then Stripe. */
export function CheckoutView({
  plan,
  summary,
  busy,
  act,
  onBuy,
  onPortal,
  onDecline,
}: Shared & {
  plan: Plan | null;
  /** Null while this deployment does not sell. */
  summary: BillingSummary | null;
  onBuy: (plan: Plan) => Promise<void>;
  onPortal: () => Promise<void>;
  onDecline: () => void;
}) {
  const page = (body: ReactNode, action?: ReactNode) => (
    <section className="enroll">
      {body}
      {action}
      <button type="button" className="text-button" disabled={!!busy} onClick={onDecline}>
        Not now
      </button>
    </section>
  );
  const price = plan && priceOf(plan, summary?.founding?.cohort ?? null);
  if (!plan) return page(<p>This link names no plan. See <a href={PLANS_PAGE}>the plans</a>.</p>);
  if (!summary) return page(<p>Checkout is not open yet. Nothing was charged.</p>);
  if (summary.plan)
    return page(
      <p>
        This account already has {PLAN_NAMES[summary.plan]}. Change or cancel it in Manage billing.
      </p>,
      <PortalButton busy={busy} act={act} onPortal={onPortal} primary />,
    );
  if (!price)
    return page(
      <p>
        Founding has closed. {HOSTED_YEARLY.name} is ${HOSTED_YEARLY.price} a year; see{" "}
        <a href={PLANS_PAGE}>the plans</a>.
      </p>,
    );
  return page(
    <>
      <dl className="identity">
        <dt>Plan</dt>
        <dd>{PLAN_NAMES[plan]}</dd>
        <dt>Price</dt>
        <dd>{price}, in USD; tax is added where it applies</dd>
      </dl>
      <p className="help terms">
        No trial: you pay today, cancel any time, and every plan has a 30-day
        refund.{plan === "founding" && " The founding price stays yours while the subscription does."}
      </p>
    </>,
    <button className="primary" disabled={!!busy} onClick={() => void act("buy", () => onBuy(plan))}>
      {busy === "buy" ? "Opening Stripe…" : "Continue to payment"}
    </button>,
  );
}

/** The plan line: its name and when it renews or ends. */
function PlanLine({ summary }: { summary: BillingSummary }) {
  if (!summary.plan)
    return (
      <p className="help">
        {summary.entitled
          ? "Hosted is included with this account."
          : "No plan. Hosted adds managed voices and the Hosted Relay."}{" "}
        {!summary.entitled && <a href={PLANS_PAGE}>See the plans</a>}
      </p>
    );
  return (
    <div className="method">
      <span>
        {PLAN_NAMES[summary.plan]}
        <span className="detail">
          {!summary.active
            ? "A payment is due. Update your card in Manage billing."
            : summary.until && `${summary.renews ? "Renews" : "Ends"} ${date(summary.until)}`}
        </span>
      </span>
    </div>
  );
}

/** The founders-row opt-in: unticked until the founder ticks it. */
function FounderForm({
  shown,
  defaultName,
  busy,
  act,
  onSave,
}: Shared & {
  shown: string | null;
  defaultName: string;
  onSave: (name: string | null) => Promise<void>;
}) {
  const [checked, setChecked] = useState(shown !== null);
  const [name, setName] = useState(shown ?? defaultName);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void act("founder", () => onSave(checked ? name.trim() : null));
  };
  const unchanged = checked ? name.trim() === shown : shown === null;
  return (
    <form onSubmit={submit} className="founder">
      <label className="check">
        <input
          type="checkbox"
          checked={checked}
          disabled={!!busy}
          onChange={(event) => setChecked(event.target.checked)}
        />
        Show me in the founders row on dormouse.sh
      </label>
      {checked && (
        <>
          <label htmlFor="founder-name">Name to show</label>
          <input
            id="founder-name"
            required
            maxLength={64}
            value={name}
            disabled={!!busy}
            onChange={(event) => setName(event.target.value)}
          />
        </>
      )}
      <button disabled={!!busy || unchanged} type="submit">
        {busy === "founder" ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

const QUESTIONS: [keyof SurveyAnswers, string][] = [
  ["tooExpensive", "At what yearly price would Hosted be too expensive to consider?"],
  ["tooCheap", "At what price would it be so cheap you would doubt it?"],
  ["expensive", "At what price is it getting expensive, though you would still consider it?"],
  ["bargain", "At what price is it a bargain?"],
];

/** The four Van Westendorp questions: optional, sent only when the buyer sends them. */
function SurveyForm({
  busy,
  act,
  onSend,
}: Shared & { onSend: (answers: SurveyAnswers) => Promise<void> }) {
  const [values, setValues] = useState<Partial<Record<keyof SurveyAnswers, string>>>({});
  const [sent, setSent] = useState(false);
  const answers = Object.fromEntries(
    QUESTIONS.map(([key]) => [key, values[key] ? Number(values[key]) : null]),
  ) as Record<keyof SurveyAnswers, number | null>;
  const answered = Object.values(answers).some((answer) => answer !== null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void act("survey", async () => {
      await onSend(answers);
      setSent(true);
    });
  };
  if (sent) return <p className="notice">Thank you. Your answers shape later prices.</p>;
  return (
    <form onSubmit={submit}>
      <p className="help">
        Four optional questions about price, in whole US dollars a year. Nothing
        is sent unless you send it.
      </p>
      {QUESTIONS.map(([key, question]) => (
        <div key={key}>
          <label htmlFor={`survey-${key}`}>{question}</label>
          <input
            id={`survey-${key}`}
            type="number"
            inputMode="numeric"
            min={0}
            max={100000}
            step={1}
            value={values[key] ?? ""}
            disabled={!!busy}
            onChange={(event) => setValues({ ...values, [key]: event.target.value })}
          />
        </div>
      ))}
      <button disabled={!!busy || !answered} type="submit">
        {busy === "survey" ? "Sending…" : "Send answers"}
      </button>
    </form>
  );
}

/** Stripe's return: the plan bought, the founders-row opt-in, and the survey. */
export function WelcomeView({
  summary,
  defaultName,
  busy,
  act,
  onFounder,
  onSurvey,
  onDone,
}: Shared & {
  summary: BillingSummary;
  defaultName: string;
  onFounder: (name: string | null) => Promise<void>;
  onSurvey: (answers: SurveyAnswers) => Promise<void>;
  onDone: () => void;
}) {
  return (
    <>
      <PlanLine summary={summary} />
      <p className="help">{ADD_A_COMPUTER}</p>
      {summary.plan === "founding" && (
        <section aria-labelledby="founders">
          <h2 id="founders">Founders row</h2>
          <FounderForm shown={summary.founder} defaultName={defaultName} busy={busy} act={act} onSave={onFounder} />
        </section>
      )}
      <section aria-labelledby="survey">
        <h2 id="survey">What is Hosted worth?</h2>
        <SurveyForm busy={busy} act={act} onSend={onSurvey} />
      </section>
      <button className="primary" disabled={!!busy} onClick={onDone}>
        Go to your account
      </button>
    </>
  );
}

/** The account page's Plan section. */
export function PlanSection({
  summary,
  defaultName,
  busy,
  act,
  onPortal,
  onFounder,
}: Shared & {
  summary: BillingSummary;
  defaultName: string;
  onPortal: () => Promise<void>;
  onFounder: (name: string | null) => Promise<void>;
}) {
  return (
    <section aria-labelledby="plan">
      <h2 id="plan">Plan</h2>
      <PlanLine summary={summary} />
      {summary.plan && <PortalButton busy={busy} act={act} onPortal={onPortal} />}
      {summary.plan === "founding" && (
        <FounderForm shown={summary.founder} defaultName={defaultName} busy={busy} act={act} onSave={onFounder} />
      )}
    </section>
  );
}
