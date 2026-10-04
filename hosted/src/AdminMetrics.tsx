import { useEffect, useState } from "react";
import { getAdminMetrics } from "./api";
import { PLAN_LABELS, REF_LABELS, type AdminMetricsBody } from "../server/metric-labels";

/** The admin's metrics view (docs/specs/hosted.md -> "Metrics"): the account app's `/admin/metrics`. */
export const ADMIN_METRICS_PAGE = "/admin/metrics";

type Load = { state: "loading" } | { state: "refused" } | { state: "failed"; message: string } | { state: "ready"; metrics: AdminMetricsBody };

type Counted = { event: string; label: string; count: number };

/** The sum of `rows` counting `event`, under a label `label` admits when given. */
const sum = (rows: readonly Counted[], event: string, label?: (l: string) => boolean) =>
  rows.reduce((total, row) => (row.event === event && (!label || label(row.label)) ? total + row.count : total), 0);

/** A bar as wide as `value` is of `max`. */
function Bar({ value, max }: { value: number; max: number }) {
  return (
    <span className="bar" aria-hidden="true">
      <span style={{ width: `${max ? (100 * value) / max : 0}%` }} />
    </span>
  );
}

export function AdminMetrics() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  useEffect(() => {
    getAdminMetrics().then(
      (metrics) => setLoad(metrics ? { state: "ready", metrics } : { state: "refused" }),
      (error: Error) => setLoad({ state: "failed", message: error.message }),
    );
  }, []);

  return (
    <div className="shell">
      <header>
        <a href="/account" className="brand">
          Dormouse <span>Hosted</span>
        </a>
        <a href="/account">Your account</a>
      </header>
      <main className="wide">
        <h1>Metrics</h1>
        {load.state === "loading" ? (
          <p className="intro">Loading…</p>
        ) : load.state === "refused" ? (
          <p className="intro">
            Only the admin sees this page. <a href="/login">Sign in</a> as the admin, then open it again.
          </p>
        ) : load.state === "failed" ? (
          <p className="error">{load.message}</p>
        ) : (
          <MetricsView metrics={load.metrics} />
        )}
      </main>
    </div>
  );
}

function MetricsView({ metrics }: { metrics: AdminMetricsBody }) {
  const { recent, totals, founding, days } = metrics;
  const events = [...new Set(totals.map((row) => row.event))].sort();
  const dates = Array.from({ length: days }, (_, back) => {
    const day = new Date();
    day.setUTCDate(day.getUTCDate() - (days - 1 - back));
    return day.toISOString().slice(0, 10);
  });
  // Each event's count per day, in one pass.
  const perDay = new Map<string, Map<string, number>>();
  for (const row of recent) {
    const days = perDay.get(row.event) ?? new Map<string, number>();
    days.set(row.day, (days.get(row.day) ?? 0) + row.count);
    perDay.set(row.event, days);
  }
  const byRef = REF_LABELS.map((ref) => {
    const endsWith = (label: string) => label.endsWith(`:${ref}`);
    return {
      ref,
      visits: sum(recent, "hosted_page.ref", (label) => label === ref),
      started: sum(recent, "checkout.started", endsWith),
      completed: sum(recent, "checkout.completed", endsWith),
    };
  }).filter((row) => row.visits || row.started || row.completed);
  const byPlan = PLAN_LABELS.map((plan) => {
    const startsWith = (label: string) => label.startsWith(`${plan}:`);
    return {
      plan,
      started: sum(recent, "checkout.started", startsWith),
      completed: sum(recent, "checkout.completed", startsWith),
      refunded: sum(recent, "subscription.refunded", (label) => label === plan),
      canceled: sum(recent, "subscription.canceled", (label) => label === plan),
    };
  });
  const maxVisits = Math.max(0, ...byRef.map((row) => row.visits));

  return (
    <>
      <p className="intro">
        Aggregate daily counts, UTC. Funnels and the daily bars cover the last {days} days; totals are all time.
      </p>

      <section aria-labelledby="founding">
        <h2 id="founding">Founding seats</h2>
        {founding === null ? (
          <p>Billing is off on this deployment.</p>
        ) : (
          <p>
            {founding.open
              ? `Cohort ${founding.open.cohort + 1} is open with ${founding.open.seatsLeft} seats left.`
              : "Founding has closed."}{" "}
            Sold per cohort: {founding.sold.join(", ")}.
          </p>
        )}
      </section>

      <section aria-labelledby="by-ref">
        <h2 id="by-ref">Funnel by ref</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Ref</th>
              <th scope="col">Hosted page visits</th>
              <th scope="col">Checkouts started</th>
              <th scope="col">Completed</th>
            </tr>
          </thead>
          <tbody>
            {byRef.length ? (
              byRef.map((row) => (
                <tr key={row.ref}>
                  <th scope="row">{row.ref}</th>
                  <td>
                    {row.visits} <Bar value={row.visits} max={maxVisits} />
                  </td>
                  <td>{row.started}</td>
                  <td>{row.completed}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4}>No visits or checkouts yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="by-plan">
        <h2 id="by-plan">Funnel by plan</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Plan</th>
              <th scope="col">Started</th>
              <th scope="col">Completed</th>
              <th scope="col">Refunded</th>
              <th scope="col">Canceled</th>
            </tr>
          </thead>
          <tbody>
            {byPlan.map((row) => (
              <tr key={row.plan}>
                <th scope="row">{row.plan}</th>
                <td>{row.started}</td>
                <td>{row.completed}</td>
                <td>{row.refunded}</td>
                <td>{row.canceled}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="events">
        <h2 id="events">Events</h2>
        <table>
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">Last {days} days, one bar a day</th>
              <th scope="col">{days} days</th>
              <th scope="col">All time</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => {
              const daily = dates.map((day) => perDay.get(event)?.get(day) ?? 0);
              const peak = Math.max(...daily);
              const labels = totals.filter((row) => row.event === event && row.label !== "");
              return (
                <tr key={event}>
                  <th scope="row">
                    {event}
                    {labels.length > 0 && (
                      <span className="detail">
                        {labels.map((row) => `${row.label} ${row.count}`).join(" · ")}
                      </span>
                    )}
                  </th>
                  <td>
                    <span className="daily" role="img" aria-label={`${event} per day: ${daily.join(", ")}`}>
                      {daily.map((count, index) => (
                        <span key={dates[index]} title={`${dates[index]}: ${count}`} style={{ height: `${peak ? (100 * count) / peak : 0}%` }} />
                      ))}
                    </span>
                  </td>
                  <td>{daily.reduce((a, b) => a + b, 0)}</td>
                  <td>{sum(totals, event)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}
