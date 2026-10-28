import {
  METRIC_LABELS,
  type AdminMetricsBody,
  type MetricEvent,
} from "../server/metric-labels";

/** One label's counts within an event. */
export interface LabelSummary {
  label: string;
  total: number;
  window: number;
}

/** One event as the admin page shows it. */
export interface EventSummary {
  event: MetricEvent;
  total: number;
  /** The window's sum, today included. */
  window: number;
  today: number;
  /** Every listed label, in the allowlist's order; empty for an unlabeled event. */
  labels: LabelSummary[];
  /** One sum per day of the window, oldest first, a day with no row as 0. */
  daily: { day: string; count: number }[];
}

/** `YYYY-MM-DD`, `back` UTC days before `today`. */
function dayBefore(today: string, back: number): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - back);
  return date.toISOString().slice(0, 10);
}

/** Every counted event, in the allowlist's order, from one read. */
export function summarize(body: AdminMetricsBody): EventSummary[] {
  const days = Array.from({ length: body.days }, (_, i) => dayBefore(body.today, body.days - 1 - i));
  return (Object.keys(METRIC_LABELS) as MetricEvent[]).map((event) => {
    const recent = body.recent.filter((row) => row.event === event);
    const totals = body.totals.filter((row) => row.event === event);
    const sum = (rows: { count: number }[]) => rows.reduce((total, row) => total + row.count, 0);
    const listed: readonly string[] = METRIC_LABELS[event];
    return {
      event,
      total: sum(totals),
      window: sum(recent),
      today: sum(recent.filter((row) => row.day === body.today)),
      labels: listed.includes("")
        ? []
        : listed.map((label) => ({
            label,
            total: sum(totals.filter((row) => row.label === label)),
            window: sum(recent.filter((row) => row.label === label)),
          })),
      daily: days.map((day) => ({ day, count: sum(recent.filter((row) => row.day === day)) })),
    };
  });
}
