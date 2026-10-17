import { CARD_CLASS, CARD_MUTED_TEXT_CLASS, LINK_CLASS } from "./docs-tokens";

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

/** One canary run on the graph. `percent` is null when the run has no counts to plot. */
export type RecallPoint = {
  url: string;
  at: string;
  /** "Oct 16": the x axis's form, which no count label ("7 of 8") can be mistaken for. */
  day: string;
  percent: number | null;
  /** The label beside the point, in words. */
  label: string;
  /** What a screen reader and the hover tooltip say. */
  description: string;
  unfinished: number;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** From the ISO string itself rather than `Date`, so the server and the browser agree whatever the zone. */
const dayOf = (at: string) => `${MONTHS[Number(at.slice(5, 7)) - 1]} ${Number(at.slice(8, 10))}`;

/** Every run in the window, oldest first: several share a day, so they are ordered by time and keyed by link. */
export function recallPoints(snapshot: CanaryRecallSnapshot): RecallPoint[] {
  const recorded = snapshot.runs.map((run) => {
    const percent = run.seeded > 0 ? Math.round((run.caught / run.seeded) * 100) : null;
    const unfinished = run.unfinished > 0
      ? `; ${run.unfinished} domain${run.unfinished > 1 ? "s" : ""} left no finished report`
      : "";
    return {
      url: run.url,
      at: run.at,
      day: dayOf(run.at),
      percent,
      label: `${run.caught} of ${run.seeded}`,
      description: `${dayOf(run.at)}: caught ${run.caught} of ${run.seeded} seeded${percent === null ? "" : ` (${percent}%)`}${unfinished}`,
      unfinished: run.unfinished,
    };
  });
  const missing = snapshot.unrecorded.map((run) => ({
    url: run.url,
    at: run.at,
    day: dayOf(run.at),
    percent: null,
    label: "no record",
    description: `${dayOf(run.at)}: no record; the run scored nothing`,
    unfinished: 0,
  }));
  return [...recorded, ...missing].sort((a, b) => a.at.localeCompare(b.at) || a.url.localeCompare(b.url));
}

/**
 * The x axis: one label per run of consecutive points on the same day, centred
 * under them (`center` in point slots). A label too close to the one before
 * drops to a second row rather than overlapping it.
 */
export function dayLabels(points: RecallPoint[]): { day: string; center: number; row: 0 | 1 }[] {
  const groups: { day: string; first: number; last: number }[] = [];
  points.forEach((point, i) => {
    const group = groups[groups.length - 1];
    if (group && group.day === point.day) group.last = i;
    else groups.push({ day: point.day, first: i, last: i });
  });
  const labels: { day: string; center: number; row: 0 | 1 }[] = [];
  for (const { day, first, last } of groups) {
    const center = (first + last) / 2 + 0.5;
    const before = labels[labels.length - 1];
    const row = before && before.row === 0 && center - before.center < 1.5 ? 1 : 0;
    labels.push({ day, center, row });
  }
  return labels;
}

/**
 * Whether each point's label sits above it: on the side away from the line
 * (above a peak, below a dip), flipped when the label before it sits on the
 * same side at nearly the same height, so neighbours' labels never meet. A run
 * with nothing plotted sits on the axis, and its label above.
 */
export function labelsAbove(points: RecallPoint[]): boolean[] {
  const sides: boolean[] = [];
  points.forEach((point, i) => {
    if (point.percent === null) return sides.push(true);
    const near = [points[i - 1], points[i + 1]].flatMap((p) => (p && p.percent !== null ? [p.percent] : []));
    let above = near.length === 0 || point.percent >= near.reduce((a, b) => a + b, 0) / near.length;
    const before = points[i - 1];
    const beforeHeight = before?.percent ?? 0;
    if (i > 0 && sides[i - 1] === above && Math.abs(beforeHeight - point.percent) < 20) above = !above;
    sides.push(above);
  });
  return sides;
}

const EXTERNAL = { target: "_blank", rel: "noopener noreferrer" } as const;
const GRID = [100, 50, 0];

/** Percent caught per run, 0–100% up the y axis, oldest to newest left to right. */
function RecallGraph({ points }: { points: RecallPoint[] }) {
  const n = points.length;
  const x = (i: number) => ((i + 0.5) / n) * 100;
  const plotted = points.flatMap((point, i) => (point.percent === null ? [] : [`${x(i)},${100 - point.percent}`]));
  // Past ten runs a phone has no room for a word label on each point; the
  // tooltip and the link's label still carry it.
  const labelVisibility = n > 10 ? "hidden sm:block" : "";
  const above = labelsAbove(points);
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
          <polyline
            points={plotted.join(" ")}
            fill="none"
            style={{ stroke: "var(--docs-accent)" }}
            strokeWidth={2}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <ol aria-label="Percent caught per canary run, oldest first" className="absolute inset-0">
          {points.map((point, i) => {
            const top = point.percent === null ? 100 : 100 - point.percent;
            const marker = point.percent === null
              ? "border-2 border-dashed border-[var(--color-text)]/50"
              : point.unfinished > 0
                ? "border-2 border-[var(--docs-accent)] bg-[var(--color-bg)]"
                : "bg-[var(--docs-accent)]";
            return (
              <li
                key={point.url}
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${x(i)}%`, top: `${top}%` }}
              >
                <a
                  href={point.url}
                  {...EXTERNAL}
                  aria-label={point.description}
                  title={point.description}
                  className="flex size-6 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-[var(--docs-accent)]"
                >
                  <span className={`block size-2.5 rounded-full ${marker}`} />
                </a>
                {/* The card's own surface, page then tint, so a grid line passes behind the words. */}
                <span
                  aria-hidden="true"
                  className={`${labelVisibility} pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-[var(--color-bg)] ${above[i] ? "bottom-full" : "top-full"}`}
                >
                  <span className={`block rounded bg-[var(--color-text)]/[0.04] px-1 font-mono ${CARD_MUTED_TEXT_CLASS}`}>
                    {point.label}
                    {point.unfinished > 0 ? "*" : ""}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      <div />
      <div aria-hidden="true" className={`relative h-8 font-mono ${CARD_MUTED_TEXT_CLASS}`}>
        {dayLabels(points).map(({ day, center, row }) => (
          <span
            key={`${day}-${center}`}
            className={`absolute -translate-x-1/2 whitespace-nowrap ${row ? "top-4" : "top-0"}`}
            style={{ left: `${(center / n) * 100}%` }}
          >
            {day}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The audit's measured recall, which `/security` shows under "How the
 * guarantees are checked" (docs/specs/security-audit.md -> "Canary recall").
 * The as-of date stays beside the figure, so a stale snapshot reads as one.
 */
export default function CanaryRecall({ snapshot }: { snapshot: CanaryRecallSnapshot }) {
  const { asOf, windowDays, runsUrl, seeded, caught } = snapshot;
  const points = recallPoints(snapshot);
  const unfinished = points.some((point) => point.unfinished > 0);
  const missing = snapshot.unrecorded.length > 0;
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
        {asOf}.{points.length > 0 ? " Each point below is one run, and links to it." : ""}
      </p>
      {points.length > 0 ? <RecallGraph points={points} /> : null}
      {unfinished ? (
        <p className={`text-sm ${CARD_MUTED_TEXT_CLASS}`}>
          * Hollow: a domain left no finished report, and its seeds count as missed.
        </p>
      ) : null}
      {missing ? (
        <p className={`text-sm ${CARD_MUTED_TEXT_CLASS}`}>
          Dashed, on the axis: a run that scored nothing and left no record.
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
