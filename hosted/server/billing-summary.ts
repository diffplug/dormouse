// Rules: docs/specs/hosted.md -> "Billing". No I/O: the account page's bundle
// imports this as well as the account Worker.
import type { Plan } from "./policy-constants";

/** `GET /api/billing` while billing is closed: not an outage, so not a 5xx. */
export interface BillingClosed {
  closed: true;
}

/** `GET /api/billing` while billing is open, and every billing mutation's answer. */
export interface BillingSummary {
  /** The subscription Stripe still holds, paid up or not; null without one. */
  plan: Plan | null;
  /** What that subscription charges per interval, in whole US dollars. */
  price: number | null;
  /** Whether that subscription grants access now. */
  active: boolean;
  until: string | null;
  renews: boolean;
  /** Whether the account has Hosted now, by its subscription or a comp. */
  entitled: boolean;
  /** A payment dispute is open, which pauses the subscription. */
  suspended: boolean;
  /** The founding cohort on sale; null once founding has closed. */
  founding: { cohort: number; seatsLeft: number } | null;
  /** `offered` while a founding subscription grants access; `name` while shown in the founders row. */
  founder: { offered: boolean; name: string | null };
  /** What the account agreed to when it bought the held subscription. */
  consent: { termsVersion: string; consentedAt: string } | null;
  /** The EEA or UK online withdrawal from the held subscription, while it is open. */
  withdrawal: WithdrawalOffer | null;
  /**
   * The account's latest withdrawal, kept on the page as its acknowledgement:
   * the server sends it only while no plan is held or it is the held plan's.
   */
  withdrawn: Withdrawn | null;
}

/** The held subscription's online withdrawal. */
export interface WithdrawalOffer {
  /** The contract: the Stripe subscription it ends. */
  subscription: string;
  startedAt: string;
  /** When the online withdrawal closes. */
  until: string;
  /** Where the acknowledgement is emailed; null when Stripe could not say. */
  email: string | null;
}

/** A recorded withdrawal. */
export interface Withdrawn {
  reference: string;
  subscription: string;
  plan: string;
  startedAt: string;
  submittedAt: string;
  /** Its acknowledgement was emailed. */
  acknowledged: boolean;
  /** The subscription ended and every payment for it was refunded. */
  settled: boolean;
}
