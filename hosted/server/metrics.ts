// Rules: docs/specs/hosted.md -> "Metrics". The labels: ./metric-labels.ts.
import type { Context } from "hono";
import { queryDatabase } from "pgstencil/postgres";
import {
  METRICS_DAYS,
  metricLabel,
  type AdminMetricsBody,
  type MetricEvent,
  type MetricRow,
} from "./metric-labels";

/**
 * Adds `n` to today's (UTC) count of `event` under `label`. Rejects on a
 * label off the event's list or a database failure; callers go through
 * {@link recordMetric}.
 */
export async function countMetric(databaseUrl: string, event: MetricEvent, label = "", n = 1) {
  await queryDatabase(
    databaseUrl,
    `INSERT INTO dormouse_metrics_daily AS m (day, event, label, count)
    VALUES ((now() AT TIME ZONE 'UTC')::date, $1, $2, $3)
    ON CONFLICT (day, event, label) DO UPDATE SET count = m.count + EXCLUDED.count`,
    [event, metricLabel(event, label), n],
  );
}

/**
 * Lets `write` finish after the response, through the request's `waitUntil`,
 * and only logs its failure: it never fails or delays the request it rides
 * on. The Node dev loop has no ExecutionContext; there it runs unawaited.
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

/** {@link countMetric}, best effort. */
export const recordMetric = (c: Context, databaseUrl: string, event: MetricEvent, label = "", n = 1) =>
  bestEffort(c, `Metric ${event}`, countMetric(databaseUrl, event, label, n));

/**
 * The rows of the `METRICS_DAYS` UTC days to today, and every event's
 * all-time totals. Today is the database's, the clock every row was counted by.
 */
export async function readMetrics(databaseUrl: string): Promise<AdminMetricsBody> {
  const [{ today }] = await queryDatabase<{ today: string }>(
    databaseUrl,
    `SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS today`,
    [],
  );
  const [recent, totals] = await Promise.all([
    queryDatabase<MetricRow>(
      databaseUrl,
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, event, label, count::float8 AS count
      FROM dormouse_metrics_daily
      WHERE day > $1::date - $2::int AND day <= $1::date
      ORDER BY day, event, label`,
      [today, METRICS_DAYS],
    ),
    queryDatabase<Omit<MetricRow, "day">>(
      databaseUrl,
      `SELECT event, label, sum(count)::float8 AS count FROM dormouse_metrics_daily
      GROUP BY event, label ORDER BY event, label`,
      [],
    ),
  ]);
  return { days: METRICS_DAYS, today, recent, totals };
}
