// Rules: docs/specs/hosted.md -> "Metrics". No I/O: the admin view's bundle
// imports these as well as the Workers.
import { isHostedRef, HOSTED_REFS } from "../../lib/src/lib/hosted-links";
import { CHECKOUT_PLANS, isCheckoutPlan } from "../../website/src/lib/hosted-pricing";
import { providerIds } from "./providers.js";

/** The label an unknown value counts under. */
export const OTHER = "other";
/** The ref label of a visit or checkout that named none. */
export const NO_REF = "none";

/** Every ref label: the allowlist, then `other` and `none`. */
export const REF_LABELS = [...Object.values(HOSTED_REFS), OTHER, NO_REF];
/** Every plan label: the plans checkout sells, then `other`. */
export const PLAN_LABELS = [...CHECKOUT_PLANS, OTHER];
const PLAN_REFS = [...PLAN_LABELS.flatMap((plan) => REF_LABELS.map((ref) => `${plan}:${ref}`)), OTHER];
/** Login methods: the providers, and the emailed code. */
export const LOGIN_METHODS: readonly string[] = [...providerIds, "email"];

/**
 * Every event Hosted counts, and the only labels each may carry; `[""]` for
 * one counted without a label. A label outside its list counts as `other`.
 */
export const METRIC_LABELS = {
  "account.created": [""],
  login: LOGIN_METHODS,
  "checkout.started": PLAN_REFS,
  "checkout.completed": PLAN_REFS,
  "subscription.canceled": PLAN_LABELS,
  "subscription.refunded": PLAN_LABELS,
  "enroll.approved": [""],
  "burrow.enrolled": [""],
  "voice.speak": ["ok", "capped", "error"],
  "voice.fallback-cap": [""],
  "push.sent": [""],
  "pocket.signin": [""],
  "hosted_page.ref": REF_LABELS,
} as const satisfies Record<string, readonly string[]>;
export type MetricEvent = keyof typeof METRIC_LABELS;

/** The allowlisted label `label` counts under for `event`, or null when it has none. */
export function metricLabel(event: MetricEvent, label: string): string | null {
  const allowed: readonly string[] = METRIC_LABELS[event];
  if (allowed.includes(label)) return label;
  return allowed.includes(OTHER) ? OTHER : null;
}

/** A `ref` as a label: allowlisted, `none` when absent, `other` otherwise. */
export const refLabel = (ref: unknown): string =>
  isHostedRef(ref) ? ref : ref === undefined || ref === null || ref === "" ? NO_REF : OTHER;

/** A plan name as a label: a plan checkout sells, else `other`. */
export const planLabel = (plan: unknown): string => (isCheckoutPlan(plan) ? plan : OTHER);

/** The admin metrics view's JSON route; the account app's `/admin/metrics` reads it. */
export const ADMIN_METRICS_PATH = "/api/admin/metrics";

/** How many UTC days, today included, the admin view's daily rows cover. */
export const METRICS_DAYS = 30;

/** One day's count, as the admin view reads them. */
export interface MetricRow {
  day: string;
  event: MetricEvent;
  label: string;
  count: number;
}

/** `GET /api/admin/metrics`. */
export interface AdminMetricsBody {
  days: number;
  recent: MetricRow[];
  totals: Omit<MetricRow, "day">[];
  /** Founding purchases per cohort and the open one; null while billing is off. */
  founding: { sold: number[]; open: { cohort: number; seatsLeft: number } | null } | null;
}
