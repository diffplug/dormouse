// The text of each billing notice, apart from the database and mail that send
// it, so `hosted/src/stories/Emails.stories.tsx` can show what a customer gets.
// Rules: docs/specs/hosted.md -> "Billing notices".
import { escapeHtml, type EmailMessage } from "pgstencil/email";
import { PLAN_NAMES, planInterval } from "../../website/src/lib/hosted-pricing";
import {
  DIFFPLUG_POSTAL_ADDRESS,
  MODEL_FORM_INTRO,
  MODEL_WITHDRAWAL_FORM,
  SUPPORT_EMAIL,
  WITHDRAWAL_RIGHT,
  WITHDRAWAL_STATEMENT,
} from "../../website/src/lib/hosted-withdrawal";
import type { PriceCatalog } from "./billing";
import { disclosure, priceLine } from "./disclosure";
import { BILLING_RETURN_PATH, isPlan, termsArchiveUrl, type Plan } from "./policy-constants";

/** Who a notice is from, so a customer's reply and a sign-in code's sender stay apart. */
export const NOTICE_FROM = `Dormouse Hosted <${SUPPORT_EMAIL}>`;

export type Kind = "renewal" | "annual" | "price_change" | "dispute_suspended" | "dispute_restored" | "withdrawal" | "purchase";

/** A notice to send, with what its text needs. */
export interface Pending {
  id: string;
  userId: string;
  kind: Kind;
  renewsAt: Date | null;
  priceId: string | null;
  priceChangeId: string | null;
  /** A withdrawal's: its reference, plan, when its contract started, and when it was submitted. */
  withdrawalId: string | null;
  withdrawalPlan: string | null;
  contractStartedAt: Date | null;
  submittedAt: Date | null;
  /** A purchase's: what its checkout's consent recorded. */
  consentPlan: string | null;
  shownUsd: number | null;
  termsVersion: string | null;
  consentedAt: Date | null;
}

/** What composing a notice reads beyond its row. */
export interface NoticeContext {
  catalog: PriceCatalog;
  /** The account origin, whose billing page a notice links. */
  origin: string;
}

const DAY = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });
const UTC = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "long", timeZone: "UTC" });
const UTC_DAY = new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" });

/** A paragraph, or a list of terms and their values. */
type Block = string | readonly (readonly [string, string])[];

/** The email for notice `notice`, to the billing email `to`. */
export function noticeMessage(to: string, notice: Pending, plan: Plan | null, context: NoticeContext): EmailMessage {
  const billingPage = new URL(BILLING_RETURN_PATH, context.origin).href;
  const name = plan ? PLAN_NAMES[plan] : "Dormouse Hosted";
  const interval = plan ? planInterval(plan) : null;
  const usd = notice.priceId ? (context.catalog.prices.get(notice.priceId)?.usd ?? null) : null;
  const on = notice.renewsAt ? DAY.format(notice.renewsAt) : "";
  const cancel = `To stop it renewing, cancel before ${on} in Manage billing on your billing page: ${billingPage}. You keep Hosted until ${on}. If you cannot sign in, email ${SUPPORT_EMAIL} and we will cancel it for you.`;
  const yearlyRefund = `Ask within 30 days of a yearly renewal payment and we refund it in full, including tax.`;
  const help = `Questions: ${SUPPORT_EMAIL}.`;
  let subject: string;
  let paragraphs: Block[];
  switch (notice.kind) {
    case "renewal":
      subject = `Your Dormouse Hosted subscription renews on ${on}`;
      paragraphs = [
        `Your ${name} subscription renews automatically on ${on}${usd ? `, for another year at $${usd} plus any applicable tax, charged to your payment method on file` : ", for another year"}.`,
        cancel,
        yearlyRefund,
        help,
      ];
      break;
    case "annual":
      subject = "Your yearly reminder about your Dormouse Hosted subscription";
      paragraphs = [
        `This is your yearly reminder that your ${name} subscription renews automatically every month${usd ? ` at $${usd} plus any applicable tax, charged to your payment method on file` : ""}, until you cancel. Your next renewal is on ${on}.`,
        `To cancel, use Manage billing on your billing page: ${billingPage}. You keep Hosted until the end of the month you paid for. If you cannot sign in, email ${SUPPORT_EMAIL} and we will cancel it for you.`,
        help,
      ];
      break;
    case "price_change": {
      const change = context.catalog.usable.find((candidate) => candidate.id === notice.priceChangeId)!;
      subject = `Your Dormouse Hosted price changes on ${on}`;
      paragraphs = [
        `The price of your ${name} subscription changes from $${change.fromUsd} to $${change.toUsd} a ${interval}, plus any applicable tax, starting with your renewal on ${on}. Nothing changes before then.`,
        `If you do not want to pay the new price, ${cancel.charAt(0).toLowerCase()}${cancel.slice(1)}`,
        ...(interval === "year" ? [yearlyRefund] : []),
        help,
      ];
      break;
    }
    case "dispute_suspended":
      subject = "Dormouse Hosted is paused during a payment dispute";
      paragraphs = [
        "A payment for your Dormouse Hosted subscription is being disputed with your bank or card provider. While the dispute is open, we have paused the paid features it covers, Natural Voice and the Hosted Relay. Your subscription is not cancelled, and Dormouse keeps working, with spoken alarms in your system voice.",
        "If the disputed payment is restored, or the pause was a mistake, we restore your remaining paid access and any founding price you held. If the payment is finally reversed, we may end the access it paid for and stop future renewals.",
        `This does not limit your right to dispute a charge, or any refund or remedy owed to you. To reach us about the dispute, email ${SUPPORT_EMAIL}.`,
      ];
      break;
    case "dispute_restored":
      subject = "Your Dormouse Hosted access is restored";
      paragraphs = [
        "The payment dispute on your Dormouse Hosted subscription has closed with the payment in place, and we have restored your paid access. Your subscription continues as before, including any founding price you held.",
        `This does not limit any refund or remedy owed to you. ${help}`,
      ];
      break;
    case "withdrawal": {
      // The durable acknowledgement docs/specs/pricing.md -> "Checkout and entitlement" requires.
      const contract = isPlan(notice.withdrawalPlan) ? PLAN_NAMES[notice.withdrawalPlan] : notice.withdrawalPlan;
      subject = "We received your withdrawal from Dormouse Hosted";
      paragraphs = [
        "DiffPlug LLC received your withdrawal from your Dormouse Hosted subscription contract.",
        [
          ["Your statement", WITHDRAWAL_STATEMENT],
          ["Submitted", UTC.format(notice.submittedAt!)],
          ["Contract", `Dormouse Hosted, ${contract}, ordered on ${UTC_DAY.format(notice.contractStartedAt!)}`],
          ["Reference", notice.withdrawalId!],
        ],
        "Your subscription ends with this withdrawal and will not renew. We refund every payment you made for it in full, including tax, to your original payment method within 14 days of your withdrawal, with no deduction. Your bank or card provider decides when the credit appears.",
        `Keep this email as your record. Questions: ${SUPPORT_EMAIL}.`,
      ];
      break;
    }
    case "purchase": {
      // The durable confirmation docs/specs/pricing.md -> "Checkout and entitlement" requires.
      const { consentPlan, shownUsd, termsVersion, consentedAt } = notice;
      if (!isPlan(consentPlan) || !shownUsd || !termsVersion || !consentedAt)
        throw new Error(`Notice ${notice.id}: its checkout recorded no consent to confirm`);
      const agreed = disclosure(consentPlan, shownUsd);
      subject = "Your Dormouse Hosted subscription confirmation";
      paragraphs = [
        "Thank you for subscribing to Dormouse Hosted. Keep this email as your record of what you agreed to.",
        [
          ["Seller", "DiffPlug LLC"],
          ["Plan", `Dormouse Hosted, ${PLAN_NAMES[consentPlan]}`],
          ["Price", priceLine(consentPlan, shownUsd)],
          ["Automatic renewal", agreed.renewal],
          ["Terms", `Version ${termsVersion}, which you agreed to on ${UTC.format(consentedAt)}: ${termsArchiveUrl(termsVersion)}`],
          [
            "Cancel",
            `${agreed.cancel} Use Manage billing on your billing page: ${billingPage}. If you cannot sign in, email ${SUPPORT_EMAIL} and we will cancel it for you.`,
          ],
          ["Refunds", `${agreed.refund} Email ${SUPPORT_EMAIL} to ask.`],
          ["Limits", agreed.limits],
        ],
        `${WITHDRAWAL_RIGHT} Your billing page: ${billingPage}.`,
        `Model withdrawal form. ${MODEL_FORM_INTRO} ${MODEL_WITHDRAWAL_FORM}`,
        help,
      ];
      break;
    }
  }
  paragraphs.push(DIFFPLUG_POSTAL_ADDRESS);
  return {
    from: NOTICE_FROM,
    to: [to],
    replyTo: SUPPORT_EMAIL,
    subject,
    text: paragraphs
      .map((block) => (typeof block === "string" ? block : block.map(([term, value]) => `${term}: ${value}`).join("\n")))
      .join("\n\n"),
    html: `<html lang="en"><body>${paragraphs
      .map((block) =>
        typeof block === "string"
          ? `<p>${escapeHtml(block)}</p>`
          : `<dl>${block.map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`,
      )
      .join("")}</body></html>`,
  };
}
