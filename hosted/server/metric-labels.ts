// Rules: docs/specs/hosted.md -> "Metrics". No I/O: the admin page's bundle
// imports this as well as the Workers.
import { HOSTED_REFS, isHostedRef } from "dormouse-lib/lib/hosted-links";
import { BILLING_PLANS } from "./policy-constants";
import { providerIds } from "./providers.js";

/** A checkout's attribution: one of `HOSTED_REFS`, `other` for any other value, `none` without one. */
export const checkoutRef = (ref: unknown) =>
  ref === undefined || ref === null ? "none" : isHostedRef(ref) ? ref : "other";

/** Every `plan:ref` label a checkout count may carry. */
const PLAN_REFS = BILLING_PLANS.flatMap((plan) =>
  [...Object.values(HOSTED_REFS), "other", "none"].map((ref) => `${plan}:${ref}`),
);

/**
 * Every event Hosted counts, and the only labels each may carry; `[""]` for
 * one counted without a label. `dormouse_metrics_daily`'s CHECK holds the same
 * lists, so a change here needs a migration replacing it.
 */
export const METRIC_LABELS = {
  "account.created": [""],
  login: ["email", ...providerIds],
  "enroll.approved": ["remote", "voice"],
  "burrow.enrolled": [""],
  "voice.speak": ["ok", "capped", "error"],
  "voice.fallback-cap": [""],
  "push.sent": [""],
  "pocket.signin": [""],
  "checkout.started": PLAN_REFS,
  "checkout.completed": PLAN_REFS,
  "subscription.canceled": BILLING_PLANS,
  "subscription.refunded": BILLING_PLANS,
} as const satisfies Record<string, readonly string[]>;
export type MetricEvent = keyof typeof METRIC_LABELS;

/** `label` for `event`; throws when it is not on that event's list, so it is never counted. */
export function metricLabel(event: MetricEvent, label: string): string {
  if ((METRIC_LABELS[event] as readonly string[]).includes(label)) return label;
  throw new Error(`${event} takes no label ${JSON.stringify(label)}`);
}

/** The admin page's JSON route; the account app's `/admin/metrics` reads it. */
export const ADMIN_METRICS_PATH = "/api/admin/metrics";

/** How many UTC days, today included, `recent` covers. */
export const METRICS_DAYS = 30;

/** One day's count of one event under one label. */
export interface MetricRow {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  event: MetricEvent;
  label: string;
  count: number;
}

/** `GET /api/admin/metrics`. */
export interface AdminMetricsBody {
  days: number;
  /** Today's UTC date by the database's clock, which counts every row: the last day `recent` can hold. */
  today: string;
  /** Every row of the last `days` days, today included. */
  recent: MetricRow[];
  /** Each event and label's all-time count. */
  totals: Omit<MetricRow, "day">[];
}
