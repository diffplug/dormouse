import { useCallback, useEffect, useState } from "react";
import { useDocsThemedBody } from "dormouse-lib/site/docs-paint";
import {
  CARD_CLASS,
  CODE_CLASS,
  DASHED_ROW_CLASS,
  LINK_CLASS,
  MUTED_TEXT_CLASS,
  PAGE_INTRO_CLASS,
  PAGE_TITLE_CLASS,
  STATUS_BAD_TEXT_CLASS,
} from "dormouse-lib/site/docs-tokens";
import type { AdminMetricsBody, MetricEvent } from "../server/metric-labels";
import { summarize, type EventSummary } from "./admin-metrics";
import { getAdminMetrics } from "./api";
import { HostedShell } from "./HostedShell";

/** The admin page's paths; the trailing slash is the same page. */
export const isAdminMetricsPath = (path: string) => path === "/admin/metrics" || path === "/admin/metrics/";

const EVENT_TITLES = {
  "account.created": "Accounts created",
  login: "Logins",
  "enroll.approved": "Approvals",
  "burrow.enrolled": "Computers enrolled",
  "voice.speak": "Natural Voice requests",
  "voice.fallback-cap": "Accounts that spent the day’s voice",
  "push.sent": "Push notifications delivered",
  "pocket.signin": "Pocket sign-ins",
} satisfies Record<MetricEvent, string>;

export type AdminMetricsState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "not-found" }
  | { kind: "failed"; message: string }
  | { kind: "ok"; body: AdminMetricsBody };

const count = (n: number) => n.toLocaleString("en-US");

/** A day's sums as bars, scaled to the window's busiest day. */
function DailyBars({ daily }: { daily: EventSummary["daily"] }) {
  const busiest = Math.max(1, ...daily.map((day) => day.count));
  return (
    <figure className="mt-auto pt-4">
      <div
        className="flex h-16 items-end gap-px"
        role="img"
        aria-label={`Daily counts from ${daily[0].day} to ${daily.at(-1)!.day}: ${daily.map((day) => day.count).join(", ")}`}
      >
        {daily.map(({ day, count: n }) => (
          <div
            key={day}
            title={`${day}: ${count(n)}`}
            className={n ? "flex-1 rounded-t-sm bg-[var(--docs-accent)]" : "h-px flex-1 bg-[var(--color-text)]/20"}
            style={n ? { height: `${Math.max(4, (n / busiest) * 100)}%` } : undefined}
          />
        ))}
      </div>
      <figcaption className={`mt-1 flex justify-between text-xs ${MUTED_TEXT_CLASS}`}>
        <span>{daily[0].day}</span>
        <span>{daily.at(-1)!.day}</span>
      </figcaption>
    </figure>
  );
}

function EventCard({ summary, days }: { summary: EventSummary; days: number }) {
  return (
    <section className={`flex flex-col ${CARD_CLASS}`} aria-label={EVENT_TITLES[summary.event]}>
      <h2 className="font-display text-xl">{EVENT_TITLES[summary.event]}</h2>
      <p className={`mt-1 text-sm ${MUTED_TEXT_CLASS}`}>
        <code className={CODE_CLASS}>{summary.event}</code>
      </p>
      <dl className="mt-4 grid grid-cols-3 gap-2">
        {([["Today", summary.today], [`${days} days`, summary.window], ["All time", summary.total]] as const).map(
          ([term, n]) => (
            <div key={term}>
              <dt className={`text-sm ${MUTED_TEXT_CLASS}`}>{term}</dt>
              <dd className="font-display text-2xl">{count(n)}</dd>
            </div>
          ),
        )}
      </dl>
      {summary.labels.length > 0 && (
        <table className="mt-4 mb-4 w-full text-sm">
          <thead>
            <tr className={`${DASHED_ROW_CLASS} ${MUTED_TEXT_CLASS}`}>
              <th className="py-1.5 text-left font-normal">Label</th>
              <th className="py-1.5 text-right font-normal">{days} days</th>
              <th className="py-1.5 text-right font-normal">All time</th>
            </tr>
          </thead>
          <tbody>
            {summary.labels.map(({ label, window, total }) => (
              <tr key={label} className={DASHED_ROW_CLASS}>
                <td className="py-1.5">{label}</td>
                <td className="py-1.5 text-right tabular-nums">{count(window)}</td>
                <td className="py-1.5 text-right tabular-nums">{count(total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <DailyBars daily={summary.daily} />
    </section>
  );
}

/** The admin's view of Hosted's daily counts (`docs/specs/hosted.md` -> "Metrics"). */
export function AdminMetricsPage({
  state,
  retry,
  themeControl = false,
}: {
  state: AdminMetricsState;
  retry: () => void;
  themeControl?: boolean;
}) {
  if (state.kind === "not-found")
    return (
      <HostedShell themeControl={themeControl}>
        <h1 className={`mb-3 ${PAGE_TITLE_CLASS}`}>Not found</h1>
        <p className={PAGE_INTRO_CLASS}>
          There is no page here. <a className={LINK_CLASS} href="/account">Go to your account</a>.
        </p>
      </HostedShell>
    );
  return (
    <HostedShell themeControl={themeControl} mainWidth="max-w-5xl">
      <h1 className={`mb-3 ${PAGE_TITLE_CLASS}`}>Metrics</h1>
      <p className={`mb-10 ${PAGE_INTRO_CLASS}`}>
        Daily counts by UTC day{state.kind === "ok" ? `, through ${state.body.today}` : ""}. No count names an account.
      </p>
      {state.kind === "loading" ? (
        <p role="status">Loading metrics…</p>
      ) : state.kind === "signed-out" ? (
        <p>
          <a className={LINK_CLASS} href="/login?signin">Sign in</a> to see this page.
        </p>
      ) : state.kind === "failed" ? (
        <div className={STATUS_BAD_TEXT_CLASS} role="alert">
          <p>{state.message}</p>
          <button type="button" className={`inline-flex min-h-11 items-center ${LINK_CLASS}`} onClick={retry}>
            Retry
          </button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {summarize(state.body).map((summary) => (
            <EventCard key={summary.event} summary={summary} days={state.body.days} />
          ))}
        </div>
      )}
    </HostedShell>
  );
}

/** {@link AdminMetricsPage}, reading the counts once and on Retry. */
export function AdminMetrics() {
  useDocsThemedBody();
  const [state, setState] = useState<AdminMetricsState>({ kind: "loading" });
  const load = useCallback(() => {
    setState({ kind: "loading" });
    getAdminMetrics().then(
      (read) => setState(read.status === "ok" ? { kind: "ok", body: read.body } : { kind: read.status }),
      (error: unknown) =>
        setState({ kind: "failed", message: error instanceof Error ? error.message : "That did not work. Try again." }),
    );
  }, []);
  useEffect(load, [load]);
  return <AdminMetricsPage state={state} retry={load} themeControl />;
}
