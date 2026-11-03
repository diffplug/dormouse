// Rules: docs/specs/pricing.md -> "Checkout and entitlement". One statement of
// what a buyer is told at the purchase action, which the checkout page shows,
// the consent records, and the purchase email repeats. No I/O: the account
// page's bundle imports this as well as the account Worker.
import { planInterval } from "../../website/src/lib/hosted-pricing";
import { MODEL_FORM_INTRO, MODEL_WITHDRAWAL_FORM, WITHDRAWAL_RIGHT } from "../../website/src/lib/hosted-withdrawal";
import { REFUND_DAYS, VOICE_DAILY_CAP, type Plan } from "./policy-constants";

/** How long after which payments of `plan` the 30-day guarantee refunds it, as the pages say it. */
export const refundWindow = (plan: Plan) =>
  `${REFUND_DAYS} days of your first payment${plan === "monthly" ? "" : " or of a yearly renewal"}`;

const renewalCadence = (plan: Plan) => (planInterval(plan) === "year" ? "every year" : "every month");

/** `$50 a year in US dollars, plus any applicable tax.` */
export const priceInUsd = (plan: Plan, price: number) =>
  `$${price} a ${planInterval(plan)} in US dollars, plus any applicable tax.`;

/** What the page lists beside the purchase action for `plan` at `price`, in its order. */
export const disclosure = (plan: Plan, price: number) => ({
  price: `${priceInUsd(plan, price)} Stripe shows the total before you pay.`,
  renewal: `Renews automatically ${renewalCadence(plan)} at $${price} until you cancel.${
    plan === "founding" ? " Your founding price stays for as long as your subscription does." : ""
  }`,
  cancel: "Cancel any time from your account page. You keep Hosted until the end of the period you paid for.",
  refund: `Ask within ${refundWindow(plan)} for a full refund, which ends the plan.${
    plan === "monthly" ? " Monthly renewals are outside this guarantee." : ""
  }`,
  limits: `For one person, including work use, with no device limit. Natural Voice speaks up to ${VOICE_DAILY_CAP} alarms a day; past that, alarms use the system voice.`,
});

/** The box that agrees to the terms version `version`. */
export const termsAgreement = (version: string) => `I agree to the Dormouse Hosted Terms (version ${version}).`;

/** The box that agrees to automatic renewal for `plan` at `price`. */
export const renewalAgreement = (plan: Plan, price: number) =>
  `I agree that my subscription renews automatically ${renewalCadence(plan)} at $${price} plus any applicable tax until I cancel.`;

/**
 * Everything the checkout page states for `plan` at `price` under terms
 * version `version`, line by line, as its consent record keeps it.
 */
export const presentedLines = (plan: Plan, price: number, version: string) => [
  ...Object.values(disclosure(plan, price)),
  WITHDRAWAL_RIGHT,
  MODEL_FORM_INTRO,
  MODEL_WITHDRAWAL_FORM,
  termsAgreement(version),
  renewalAgreement(plan, price),
];
