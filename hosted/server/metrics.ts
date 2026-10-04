// Rules: docs/specs/hosted.md -> "Metrics". The labels: ./metric-labels.ts.
import type { Context } from "hono";
import { queryDatabase } from "pgstencil/postgres";
import { metricLabel, METRICS_DAYS, type AdminMetricsBody, type MetricEvent, type MetricRow } from "./metric-labels";

/**
 * Adds `n` to today's (UTC) count of `event` under `label`, mapped through
 * its allowlist. Rejects on a database failure; callers go through
 * {@link bestEffort}.
 */
export async function countMetric(databaseUrl: string, event: MetricEvent, label = "", n = 1) {
  const counted = metricLabel(event, label);
  if (counted === null) throw new Error(`no label allowed for ${event}`);
  await queryDatabase(
    databaseUrl,
    `INSERT INTO dormouse_metrics_daily AS m (day, event, label, count)
    VALUES ((now() AT TIME ZONE 'UTC')::date, $1, $2, $3)
    ON CONFLICT (day, event, label) DO UPDATE SET count = m.count + EXCLUDED.count`,
    [event, counted, n],
  );
}

/**
 * Lets `write` finish after the response, through the request's `waitUntil`,
 * and only logs its failure: a metric never fails or delays the request it
 * rides on. The Node dev loop has no ExecutionContext; there the write just
 * runs unawaited.
 */
export function bestEffort(c: Context, what: string, write: Promise<unknown>) {
  const settled = write.then(
    () => {},
    (error: unknown) =>
      console.error(`${what} not recorded: ${error instanceof Error ? error.message : "unknown error"}`),
  );
  try {
    c.executionCtx.waitUntil(settled);
  } catch {
    // No ExecutionContext.
  }
}

/** {@link countMetric}, best-effort. */
export const recordMetric = (c: Context, databaseUrl: string, event: MetricEvent, label = "", n = 1) =>
  bestEffort(c, `Metric ${event}`, countMetric(databaseUrl, event, label, n));

/** How long a checkout's ref waits for its completion. Stripe expires a Checkout Session within a day. */
export const CHECKOUT_REF_DAYS = 2;

/** Keeps the ref checkout `checkoutId` started under, for its completion to count by. */
export const rememberCheckoutRef = (databaseUrl: string, checkoutId: string, ref: string) =>
  queryDatabase(
    databaseUrl,
    `INSERT INTO dormouse_checkout_refs ("checkoutId", ref) VALUES ($1, $2)
    ON CONFLICT ("checkoutId") DO UPDATE SET ref = EXCLUDED.ref, "startedAt" = now()`,
    [checkoutId, ref],
  );

/** Forgets every ref older than {@link CHECKOUT_REF_DAYS}: the account's Cron Trigger. */
export const sweepCheckoutRefs = (databaseUrl: string) =>
  queryDatabase(
    databaseUrl,
    `DELETE FROM dormouse_checkout_refs WHERE "startedAt" < now() - make_interval(days => $1)`,
    [CHECKOUT_REF_DAYS],
  );

/** The last `METRICS_DAYS` UTC days' rows, today included, and every event's all-time totals. */
export async function readMetrics(databaseUrl: string): Promise<Omit<AdminMetricsBody, "founding">> {
  const [recent, totals] = await Promise.all([
    queryDatabase<MetricRow>(
      databaseUrl,
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, event, label, count::int AS count
      FROM dormouse_metrics_daily
      WHERE day > (now() AT TIME ZONE 'UTC')::date - $1::int
      ORDER BY day DESC, event, label`,
      [METRICS_DAYS],
    ),
    queryDatabase<Omit<MetricRow, "day">>(
      databaseUrl,
      `SELECT event, label, sum(count)::int AS count FROM dormouse_metrics_daily
      GROUP BY event, label ORDER BY event, label`,
      [],
    ),
  ]);
  return { days: METRICS_DAYS, recent, totals };
}
