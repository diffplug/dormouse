import { useRef, type ReactNode } from "react";
import { MUTED_TEXT_CLASS, PANEL_CLASS, siteButton } from "dormouse-lib/site/docs-tokens";
import { RECENT_LOGIN_WINDOW } from "../server/policy-constants";
import { planName, type BillingSummary } from "./billing";
import { BUTTON_CLASS, HEADING_CLASS, HELP_CLASS } from "./classes";
import { SupportLink } from "./Withdrawal";

const day = (iso: string) => new Date(iso).toLocaleDateString();

/**
 * What closing does to the account's plan, said before it is confirmed
 * (docs/specs/hosted.md -> "Account closure"): when access ends, that
 * renewal stops, which refunds stay open, and the alternative of cancelling
 * renewal. Null while the plan could not be read, so closing waits for it.
 */
export function closureTerms(billing: BillingSummary | "closed" | null): ReactNode[] | null {
  if (billing === null) return null;
  if (billing === "closed" || !billing.plan) return ["You have no plan, so nothing is charged or refunded."];
  const name = planName(billing.plan);
  return [
    billing.until && billing.active
      ? `Your ${name} plan ends now instead of on ${day(billing.until)}, and it never renews. The time left is not refunded.`
      : `Your ${name} plan ends now, and it never renews.`,
    <>
      {billing.plan === "monthly"
        ? "Within 30 days of your first payment"
        : "Within 30 days of your first payment or of a yearly renewal"}
      , you can still ask <SupportLink /> for a full refund after closing.
    </>,
    ...(billing.withdrawal
      ? [
          <>
            In the EEA or UK, you can withdraw from this contract until {day(billing.withdrawal.until)} for a full refund
            of every payment. Closing does not withdraw: use Withdraw from contract on your billing page first, or email{" "}
            <SupportLink /> afterwards.
          </>,
        ]
      : []),
    ...(billing.until && billing.active && billing.renews
      ? [`To keep Hosted until ${day(billing.until)} instead, cancel renewal in Manage billing.`]
      : []),
  ];
}

/** The account page's last section: closing the account, explained and confirmed in a dialog. */
export function CloseAccount({
  billing,
  fresh,
  busy,
  onClose,
}: {
  billing: BillingSummary | "closed" | null;
  /** The login is recent enough to close the account. */
  fresh: boolean;
  busy: string;
  onClose: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const terms = closureTerms(billing);
  return (
    <>
      <h2 id="close" className={HEADING_CLASS}>
        Close account
      </h2>
      <p className={HELP_CLASS}>
        Closing deletes your account: its sign-in methods, computers, passkeys, and Natural Voice. We keep billing records
        as the privacy policy describes. If you cannot sign in, email <SupportLink /> to close it.
      </p>
      {!fresh && (
        <p className={HELP_CLASS}>
          Closing needs a login from the last {RECENT_LOGIN_WINDOW}. Sign out and sign in again first.
        </p>
      )}
      <button className={BUTTON_CLASS} disabled={!!busy || !fresh} onClick={() => dialog.current?.showModal()}>
        Close account…
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="close-title"
        className="m-auto w-[calc(100%-2rem)] max-w-lg bg-transparent p-0 backdrop:bg-black/70"
        onCancel={(event) => busy && event.preventDefault()}
      >
        <div className={PANEL_CLASS}>
          <h2 id="close-title" className="mb-2 font-display text-2xl">
            Close your account?
          </h2>
          {terms ? (
            <ul className={`list-disc space-y-2 pl-5 ${MUTED_TEXT_CLASS}`}>
              {[...terms, "Your account and everything on it are deleted. This cannot be undone."].map((term, index) => (
                <li key={index}>{term}</li>
              ))}
            </ul>
          ) : (
            <p className={MUTED_TEXT_CLASS}>
              Your plan could not load, so this page cannot tell you what closing does to it. Retry before closing.
            </p>
          )}
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <button className={BUTTON_CLASS} disabled={!!busy} onClick={() => dialog.current?.close()}>
              Keep my account
            </button>
            <button
              className={siteButton({ size: "fit" })}
              disabled={!!busy || !terms}
              onClick={() => void onClose().finally(() => dialog.current?.close())}
            >
              {busy === "close" ? "Closing…" : "Close account"}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
