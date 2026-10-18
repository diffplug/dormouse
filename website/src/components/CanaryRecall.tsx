import { CARD_CLASS, CARD_MUTED_TEXT_CLASS, LINK_CLASS, MUTED_TEXT_CLASS } from "./docs-tokens";

/** `website/src/data/canary-recall.json`, as website/scripts/generate-canary-recall.js writes it. */
export type CanaryRecallSnapshot = {
  asOf: string;
  windowDays: number;
  runsUrl: string;
  seeded: number;
  caught: number;
  runs: { at: string; url: string; seeded: number; caught: number; unfinished: number }[];
  unrecorded: { at: string; url: string }[];
};

/** One run inside a week. `seeded` and `caught` are null for a run that left no record. */
export type RecallRun = { url: string; at: string; seeded: number | null; caught: number | null; unfinished: number };

/**
 * One week of the window: Monday 00:00 UTC through Sunday, so the weekly
 * Sunday 06:21 UTC canary closes its week. `percent` is null when no run that
 * week has counts, which the graph draws as a gap.
 */
export type RecallWeek = {
  /** `YYYY-MM-DD` of the week's Monday, in UTC. */
  start: string;
  runs: RecallRun[];
  seeded: number;
  caught: number;
  percent: number | null;
  /** Runs that week with a domain that left no finished report. */
  unfinished: number;
  /** Runs that week that left no record, and so add nothing to its counts. */
  unrecorded: number;
};

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The UTC Monday 00:00 that starts the week holding `time` (ms). */
function mondayOf(time: number): number {
  const day = Math.floor(time / DAY) * DAY;
  return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
}
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);
/** "Oct 13", from a `YYYY-MM-DD` or ISO string, without the reader's time zone. */
export const dayOf = (at: string) => `${MONTHS[Number(at.slice(5, 7)) - 1]} ${Number(at.slice(8, 10))}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The weeks from the first one holding a run in the window through the as-of
 * week, oldest first, each run bucketed by its UTC time. Weeks before the
 * first run predate the canary rather than miss it, so they are left off; a
 * week with no run after it stays in the list, so the x axis keeps time to
 * scale and the line breaks there rather than dropping to zero.
 */
export function recallWeeks(snapshot: CanaryRecallSnapshot): RecallWeek[] {
  const runs: RecallRun[] = [
    ...snapshot.runs.map(({ url, at, seeded, caught, unfinished }) => ({ url, at, seeded, caught, unfinished })),
    ...snapshot.unrecorded.map(({ url, at }) => ({ url, at, seeded: null, caught: null, unfinished: 0 })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.url.localeCompare(b.url));
  const asOf = Date.parse(`${snapshot.asOf}T00:00:00Z`);
  const mondays = runs.map((run) => mondayOf(Date.parse(run.at)));
  const first = mondays.length > 0 ? Math.min(...mondays) : mondayOf(asOf - snapshot.windowDays * DAY);
  const last = Math.max(mondayOf(asOf), ...mondays);
  const weeks: RecallWeek[] = [];
  for (let monday = first; monday <= last; monday += WEEK) {
    const mine = runs.filter((_, i) => mondays[i] === monday);
    const counted = mine.filter((run) => run.seeded !== null);
    const seeded = counted.reduce((n, run) => n + run.seeded!, 0);
    const caught = counted.reduce((n, run) => n + run.caught!, 0);
    weeks.push({
      start: isoDay(monday),
      runs: mine,
      seeded,
      caught,
      percent: seeded > 0 ? Math.round((caught / seeded) * 100) : null,
      unfinished: mine.filter((run) => run.unfinished > 0).length,
      unrecorded: mine.length - counted.length,
    });
  }
  return weeks;
}

/** The label beside a week's point, in words: "15 of 16", never "15/16". */
export function weekLabel(week: RecallWeek): string | null {
  if (week.percent !== null) return `${week.caught} of ${week.seeded}${week.unfinished > 0 ? "*" : ""}`;
  return week.unrecorded > 0 ? "no record" : null;
}

/** What a screen reader and the hover tooltip say about a week. */
export function weekDescription(week: RecallWeek): string {
  const counted = week.runs.length - week.unrecorded;
  const parts = [
    week.percent === null
      ? `Week of ${dayOf(week.start)}: no counts`
      : `Week of ${dayOf(week.start)}: caught ${week.caught} of ${week.seeded} over ${plural(counted, "run")} (${week.percent}%)`,
  ];
  if (week.unfinished > 0) parts.push(`${plural(week.unfinished, "run")} with a domain that left no finished report`);
  if (week.unrecorded > 0) parts.push(`${plural(week.unrecorded, "run")} left no record`);
  return parts.join("; ");
}

/** One run in a week's list, in words. */
export function runLabel(run: RecallRun): string {
  const counts = run.seeded === null ? "no record" : `${run.caught} of ${run.seeded}${run.unfinished > 0 ? "*" : ""}`;
  return `${dayOf(run.at)}: ${counts}`;
}

/**
 * Whether each week's label sits above its point: on the side away from the
 * line (above a peak, below a dip), flipped when the labelled week before it
 * sits on the same side at nearly the same height, so labels never meet. A
 * week with nothing plotted sits on the axis, its label above.
 */
export function labelsAbove(weeks: RecallWeek[]): boolean[] {
  const sides: boolean[] = [];
  let previous: { above: boolean; height: number; index: number } | null = null;
  weeks.forEach((week, i) => {
    if (week.percent === null) {
      sides.push(true);
      if (week.unrecorded > 0) previous = { above: true, height: 0, index: i };
      return;
    }
    const near = [weeks[i - 1], weeks[i + 1]].flatMap((w) => (w && w.percent !== null ? [w.percent] : []));
    let above = near.length === 0 || week.percent >= near.reduce((a, b) => a + b, 0) / near.length;
    if (previous && previous.index === i - 1 && previous.above === above && Math.abs(previous.height - week.percent) < 20) {
      above = !above;
    }
    sides.push(above);
    previous = { above, height: week.percent, index: i };
  });
  return sides;
}

/**
 * The x axis: the first week, then each week with a point. A 30-day window
 * spans at most six weeks, and six labels fit one row at a phone's width.
 */
export function weekTicks(weeks: RecallWeek[]): { start: string; index: number }[] {
  return weeks.flatMap((week, index) => (index === 0 || weekLabel(week) !== null ? [{ start: week.start, index }] : []));
}

const EXTERNAL = { target: "_blank", rel: "noopener noreferrer" } as const;
const GRID = [100, 50, 0];

/** Percent caught per UTC week, 0–100% up the y axis, oldest to newest left to right. */
function RecallGraph({ weeks }: { weeks: RecallWeek[] }) {
  const n = weeks.length;
  const x = (i: number) => ((i + 0.5) / n) * 100;
  // One polyline per unbroken run of weeks with counts: a week without breaks the line.
  const segments: string[][] = [];
  weeks.forEach((week, i) => {
    if (week.percent === null) return;
    const point = `${x(i)},${100 - week.percent}`;
    if (i > 0 && weeks[i - 1].percent !== null) segments[segments.length - 1].push(point);
    else segments.push([point]);
  });
  const above = labelsAbove(weeks);
  return (
    <div className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-xs">
      <div aria-hidden="true" className={`relative my-6 h-36 w-9 font-mono ${CARD_MUTED_TEXT_CLASS}`}>
        {GRID.map((pct) => (
          <span key={pct} className="absolute right-0 -translate-y-1/2" style={{ top: `${100 - pct}%` }}>
            {pct}%
          </span>
        ))}
      </div>
      <div className="relative my-6 h-36">
        {GRID.map((pct) => (
          <div
            key={pct}
            aria-hidden="true"
            className="absolute inset-x-0 border-t border-[var(--color-text)]/15"
            style={{ top: `${100 - pct}%` }}
          />
        ))}
        <svg
          aria-hidden="true"
          className="absolute inset-0 h-full w-full overflow-visible"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          {segments.map((segment) => (
            <polyline
              key={segment[0]}
              points={segment.join(" ")}
              fill="none"
              style={{ stroke: "var(--docs-accent)" }}
              strokeWidth={2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        <ol aria-label="Percent caught per week, oldest first" className="absolute inset-0">
          {weeks.map((week, i) => {
            const label = weekLabel(week);
            if (label === null) return null;
            const description = weekDescription(week);
            const marker = week.percent === null
              ? "border-2 border-dashed border-[var(--color-text)]/50"
              : week.unfinished > 0
                ? "border-2 border-[var(--docs-accent)] bg-[var(--color-bg)]"
                : "bg-[var(--docs-accent)]";
            return (
              <li
                key={week.start}
                // An open week's runs paint over its neighbours' points.
                className="absolute -translate-x-1/2 -translate-y-1/2 has-[details[open]]:z-20"
                style={{ left: `${x(i)}%`, top: `${week.percent === null ? 100 : 100 - week.percent}%` }}
              >
                {/* The point opens the week's runs, each a link. */}
                <details className="peer relative">
                  <summary
                    title={description}
                    className="flex size-6 cursor-pointer list-none items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-[var(--docs-accent)] [&::-webkit-details-marker]:hidden"
                  >
                    <span aria-hidden="true" className={`block size-2.5 rounded-full ${marker}`} />
                    <span className="sr-only">{description}</span>
                  </summary>
                  <ul
                    className={`absolute top-full z-10 mt-1 w-max space-y-1 rounded-lg border border-[var(--color-text)]/15 bg-[var(--color-bg)] p-2 font-mono ${MUTED_TEXT_CLASS} ${x(i) > 50 ? "right-0" : "left-0"}`}
                  >
                    {week.runs.map((run) => (
                      <li key={run.url}>
                        <a href={run.url} className={LINK_CLASS} {...EXTERNAL}>
                          {runLabel(run)}
                        </a>
                      </li>
                    ))}
                  </ul>
                </details>
                {/* The card's own surface, page then tint, so a grid line passes behind the words. */}
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-[var(--color-bg)] peer-open:hidden ${above[i] ? "bottom-full" : "top-full"}`}
                >
                  <span className={`block rounded bg-[var(--color-text)]/[0.04] px-1 font-mono ${CARD_MUTED_TEXT_CLASS}`}>
                    {label}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      <div />
      <div aria-hidden="true" className={`relative h-4 font-mono ${CARD_MUTED_TEXT_CLASS}`}>
        {weekTicks(weeks).map(({ start, index }) => (
          <span
            key={start}
            className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
            style={{ left: `${x(index)}%` }}
          >
            {dayOf(start)}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The audit's measured recall, which `/security` shows above the security
 * spec (docs/specs/security-audit.md -> "Canary recall").
 * The as-of date stays beside the figure, so a stale snapshot reads as one.
 */
export default function CanaryRecall({ snapshot }: { snapshot: CanaryRecallSnapshot }) {
  const { asOf, windowDays, runsUrl, seeded, caught } = snapshot;
  const weeks = recallWeeks(snapshot);
  const any = snapshot.runs.length + snapshot.unrecorded.length > 0;
  const unfinished = snapshot.runs.some((run) => run.unfinished > 0);
  return (
    <aside aria-label="Canary recall" className={`mb-6 ${CARD_CLASS} text-[var(--color-text)]`}>
      {seeded > 0 ? (
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-display text-4xl">{Math.round((caught / seeded) * 100)}%</span>
          <span>
            recall: the audit caught {caught} of {seeded} seeded vulnerabilities
          </span>
        </p>
      ) : (
        <p className="font-display text-xl">No canary has run in the last {windowDays} days.</p>
      )}
      <p className={`mt-2 text-sm leading-relaxed ${CARD_MUTED_TEXT_CLASS}`}>
        A canary seeds known vulnerabilities into a throwaway copy of the repository and counts
        how many the audit reports. Summed over the canary runs of the {windowDays} days before{" "}
        {asOf}.{any ? " Each point is one week, Monday to Sunday UTC; open it for that week's runs." : ""}
      </p>
      {any ? <RecallGraph weeks={weeks} /> : null}
      {unfinished ? (
        <p className={`text-sm ${CARD_MUTED_TEXT_CLASS}`}>
          * Hollow: a run that week had a domain that left no finished report, and its seeds count as missed.
        </p>
      ) : null}
      {snapshot.unrecorded.length > 0 ? (
        <p className={`text-sm ${CARD_MUTED_TEXT_CLASS}`}>
          A run that scored nothing left no record and adds nothing to its week; a week with only such runs is a
          dashed point on the axis.
        </p>
      ) : null}
      <p className="mt-3 text-sm">
        <a href={runsUrl} className={LINK_CLASS} {...EXTERNAL}>
          Every audit and canary run →
        </a>
      </p>
    </aside>
  );
}
