import { CARD_CLASS, CARD_MUTED_TEXT_CLASS, LINK_CLASS } from "./docs-tokens";

/** `website/src/data/canary-recall.json`, as website/scripts/generate-canary-recall.js writes it. */
export type CanaryRecallSnapshot = {
  asOf: string;
  windowDays: number;
  runsUrl: string;
  seeded: number;
  caught: number;
  runs: { date: string; url: string; seeded: number; caught: number; unfinished: number }[];
  unrecorded: { date: string; url: string }[];
};

const EXTERNAL = { target: "_blank", rel: "noopener noreferrer" } as const;

/**
 * The audit's measured recall, which `/security` shows under "How the
 * guarantees are checked" (docs/specs/security-audit.md -> "Canary recall").
 * The as-of date stays beside the figure, so a stale snapshot reads as one.
 */
export default function CanaryRecall({ snapshot }: { snapshot: CanaryRecallSnapshot }) {
  const { asOf, windowDays, runsUrl, seeded, caught, runs, unrecorded } = snapshot;
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
        {asOf}.
      </p>
      {runs.length + unrecorded.length > 0 ? (
        <ul className={`mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-sm ${CARD_MUTED_TEXT_CLASS}`}>
          {runs.map((run) => (
            <li key={run.url}>
              <a href={run.url} className={LINK_CLASS} {...EXTERNAL}>
                {run.date}
              </a>{" "}
              {run.caught}/{run.seeded}
              {run.unfinished > 0 ? `, ${run.unfinished} domain${run.unfinished > 1 ? "s" : ""} unfinished` : ""}
            </li>
          ))}
          {unrecorded.map((run) => (
            <li key={run.url}>
              <a href={run.url} className={LINK_CLASS} {...EXTERNAL}>
                {run.date}
              </a>{" "}
              no record
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-sm">
        <a href={runsUrl} className={LINK_CLASS} {...EXTERNAL}>
          Every audit and canary run →
        </a>
      </p>
    </aside>
  );
}
