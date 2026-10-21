import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import snapshot from "../data/canary-recall.json";
import CanaryRecall, {
  type CanaryRecallSnapshot,
  labelsAbove,
  recallWeeks,
  runLabel,
  weekDescription,
  weekLabel,
  weekTicks,
} from "./CanaryRecall";

const RUN = (id: number) => `https://github.com/diffplug/dormouse/actions/runs/${id}`;
const BASE: CanaryRecallSnapshot = {
  asOf: "2026-10-17",
  windowDays: 30,
  runsUrl: "https://github.com/diffplug/dormouse/actions/workflows/security-audit.yaml?query=branch%3Amain",
  seeded: 0,
  caught: 0,
  runs: [],
  unrecorded: [],
};
// Newest first, as the generator writes them. Run 2 lands one second before
// Monday 00:00 UTC and run 3 on it; Sep 28's week has only a run with no record.
const SNAPSHOT: CanaryRecallSnapshot = {
  ...BASE,
  seeded: 30,
  caught: 24,
  runs: [
    { at: "2026-10-16T19:57:35Z", url: RUN(5), seeded: 8, caught: 8, unfinished: 0 },
    { at: "2026-10-12T00:00:00Z", url: RUN(3), seeded: 8, caught: 6, unfinished: 1 },
    { at: "2026-10-11T23:59:59Z", url: RUN(2), seeded: 8, caught: 7, unfinished: 0 },
    { at: "2026-09-23T10:00:00Z", url: RUN(1), seeded: 6, caught: 3, unfinished: 0 },
  ],
  unrecorded: [
    { at: "2026-10-14T05:00:00Z", url: RUN(4) },
    { at: "2026-09-30T00:00:00Z", url: RUN(6) },
  ],
};
// The advisory engine paired with runs 2 and 3: Oct 5's week is all paired,
// Oct 12's in part, so its either line adds run 5's Claude catches alone.
const ADVISORY: CanaryRecallSnapshot = {
  ...SNAPSHOT,
  runs: SNAPSHOT.runs.map((run) =>
    run.url === RUN(2)
      ? { ...run, codex: { url: RUN(12), caught: 5, either: 8, unfinished: 0 } }
      : run.url === RUN(3)
        ? { ...run, codex: { url: RUN(13), caught: 4, either: 7, unfinished: 1 } }
        : run,
  ),
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
/** The slot `x` puts week `i` of `n` at, as a percentage across the plot. */
const slot = (i: number, n: number) => ((i + 0.5) / n) * 100;
const TZ = process.env.TZ;
afterEach(() => {
  process.env.TZ = TZ;
});

describe("recallWeeks", () => {
  it("buckets every run by its UTC week, Monday to Sunday, from the first run's week through the as-of week", () => {
    const weeks = recallWeeks(SNAPSHOT);
    expect(weeks.map((w) => w.start)).toEqual(["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"]);
    const byWeek = Object.fromEntries(weeks.map((w) => [w.start, w.runs.map((r) => r.url)]));
    expect(byWeek["2026-10-05"]).toEqual([RUN(2)]);
    expect(byWeek["2026-10-12"]).toEqual([RUN(3), RUN(4), RUN(5)]);
    expect(byWeek["2026-09-28"]).toEqual([RUN(6)]);
  });

  it("keeps the weeks since the last run, and reaches back to the window's first week once a run is there", () => {
    // Two weeks without a run after Oct 12 stay on the axis as a gap.
    const later = recallWeeks({ ...SNAPSHOT, asOf: "2026-10-30" });
    expect(later.map((w) => [w.start, w.runs.length])).toEqual([
      ["2026-09-21", 1], ["2026-09-28", 1], ["2026-10-05", 1], ["2026-10-12", 3], ["2026-10-19", 0], ["2026-10-26", 0],
    ]);
    // Sep 17, 30 days before Oct 17, is in the week of Sep 14; a run there
    // with no record still starts the axis.
    const full = recallWeeks({ ...SNAPSHOT, unrecorded: [...SNAPSHOT.unrecorded, { at: "2026-09-17T06:21:00Z", url: RUN(7) }] });
    expect(full.map((w) => w.start)).toEqual(["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"]);
  });

  it("buckets the same whatever the reader's time zone", () => {
    const starts = () => recallWeeks(SNAPSHOT).map((w) => [w.start, w.runs.length]);
    const utc = starts();
    for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      process.env.TZ = zone;
      expect(starts(), zone).toEqual(utc);
    }
  });

  it("sums each week's counted runs, leaving a run with no record out of the numbers", () => {
    const week = Object.fromEntries(recallWeeks(SNAPSHOT).map((w) => [w.start, w]));
    expect(week["2026-10-12"]).toMatchObject({ seeded: 16, caught: 14, percent: 88, unfinished: 1, unrecorded: 1 });
    expect(week["2026-10-05"]).toMatchObject({ seeded: 8, caught: 7, percent: 88, unfinished: 0, unrecorded: 0 });
    expect(week["2026-09-28"]).toMatchObject({ seeded: 0, caught: 0, percent: null, unrecorded: 1 });
  });

  it("covers the same runs as the headline, in no more than six weeks", () => {
    for (const s of [SNAPSHOT, snapshot as CanaryRecallSnapshot]) {
      const weeks = recallWeeks(s);
      expect(weeks.length).toBeLessThanOrEqual(6);
      expect(weeks.reduce((n, w) => n + w.seeded, 0)).toBe(s.seeded);
      expect(weeks.reduce((n, w) => n + w.caught, 0)).toBe(s.caught);
      expect(weeks.reduce((n, w) => n + w.runs.length, 0)).toBe(s.runs.length + s.unrecorded.length);
    }
  });
});

describe("the advisory engine", () => {
  it("scores Codex over its paired runs, and either over every counted run", () => {
    const week = Object.fromEntries(recallWeeks(ADVISORY).map((w) => [w.start, w]));
    expect(week["2026-10-05"].codex).toEqual({ runs: 1, seeded: 8, caught: 5, percent: 63, either: 8, eitherPercent: 100 });
    // Codex did not see run 5: its 8 Claude catches join run 3's 7 caught by either.
    expect(week["2026-10-12"].codex).toEqual({ runs: 1, seeded: 8, caught: 4, percent: 50, either: 15, eitherPercent: 94 });
    expect(week["2026-09-21"].codex).toBeNull();
    for (const w of recallWeeks(ADVISORY)) if (w.codex) expect(w.codex.eitherPercent).toBeGreaterThanOrEqual(w.percent!);
  });

  it("says all three in each description and run", () => {
    const week = Object.fromEntries(recallWeeks(ADVISORY).map((w) => [w.start, w]));
    expect(weekDescription(week["2026-10-05"])).toBe(
      "Week of Oct 5: caught 7 of 8 over 1 run (88%); Codex caught 5 of 8 over 1 run (63%); caught by either: 8 of 8 (100%)",
    );
    expect(week["2026-10-12"].runs.map(runLabel)).toEqual(["Oct 12: 6 of 8*; Codex 4*, either 7", "Oct 14: no record", "Oct 16: 8 of 8"]);
  });

  it("draws three lines under a legend only once the advisory engine has a point", () => {
    const html = renderToStaticMarkup(<CanaryRecall snapshot={ADVISORY} />);
    const shown = text(html);
    for (const label of ["Claude, the release gate", "Codex, advisory", "Caught by either"]) expect(shown).toContain(label);
    expect(shown).toContain("its line covers only those runs");
    // Either and Codex span Oct 5 and Oct 12; Claude keeps its own two segments.
    const lines = [...html.matchAll(/<polyline points="([^"]+)"/g)].map(([, points]) => points);
    expect(lines).toEqual([
      `${slot(2, 4)},0 ${slot(3, 4)},6`,
      `${slot(2, 4)},37 ${slot(3, 4)},50`,
      `${slot(0, 4)},50`,
      `${slot(2, 4)},12 ${slot(3, 4)},12`,
    ]);
    expect(html).toContain('stroke-dasharray="5 4"');
    const plain = text(renderToStaticMarkup(<CanaryRecall snapshot={SNAPSHOT} />));
    expect(plain).not.toContain("Caught by either");
  });
});

describe("an either count that was not computed", () => {
  // Run 3's Codex canary was published without Claude's scorecard.
  const UNCOMPUTED: CanaryRecallSnapshot = {
    ...ADVISORY,
    runs: ADVISORY.runs.map((run) => (run.url === RUN(3) ? { ...run, codex: { ...run.codex!, either: null } } : run)),
  };
  const week = Object.fromEntries(recallWeeks(UNCOMPUTED).map((w) => [w.start, w]));

  it("leaves that week's either empty, never zero, and keeps Codex's own count", () => {
    expect(week["2026-10-12"].codex).toEqual({ runs: 1, seeded: 8, caught: 4, percent: 50, either: null, eitherPercent: null });
    expect(week["2026-10-05"].codex).toMatchObject({ either: 8, eitherPercent: 100 });
    expect(weekDescription(week["2026-10-12"])).toContain("caught by either: not computed");
    expect(week["2026-10-12"].runs[0] && runLabel(week["2026-10-12"].runs[0])).toBe("Oct 12: 6 of 8*; Codex 4*, either not computed");
  });

  it("plots no point on the either line that week", () => {
    const html = renderToStaticMarkup(<CanaryRecall snapshot={UNCOMPUTED} />);
    const lines = [...html.matchAll(/<polyline points="([^"]+)"/g)].map(([, points]) => points);
    expect(lines).toEqual([`${slot(2, 4)},0`, `${slot(2, 4)},37 ${slot(3, 4)},50`, `${slot(0, 4)},50`, `${slot(2, 4)},12 ${slot(3, 4)},12`]);
    // One diamond in the legend, one for Oct 5's either point; none for Oct 12's.
    expect(html.match(/rotate\(45 /g)).toHaveLength(2);
    expect(renderToStaticMarkup(<CanaryRecall snapshot={ADVISORY} />).match(/rotate\(45 /g)).toHaveLength(3);
  });
});

describe("week labels", () => {
  it("say counts in words, never with a slash, and list each run", () => {
    const week = Object.fromEntries(recallWeeks(SNAPSHOT).map((w) => [w.start, w]));
    expect(weekLabel(week["2026-10-12"])).toBe("14 of 16*");
    expect(weekLabel(week["2026-09-21"])).toBe("3 of 6");
    expect(weekLabel(week["2026-09-28"])).toBe("no record");
    expect(weekLabel({ ...week["2026-09-28"], runs: [], unrecorded: 0 })).toBeNull();
    expect(weekDescription(week["2026-10-12"])).toBe(
      "Week of Oct 12: caught 14 of 16 over 2 runs (88%); 1 run with a domain that left no finished report; 1 run left no record",
    );
    expect(weekDescription(week["2026-10-05"])).toBe("Week of Oct 5: caught 7 of 8 over 1 run (88%)");
    expect(week["2026-10-12"].runs.map(runLabel)).toEqual(["Oct 12: 6 of 8*", "Oct 14: no record", "Oct 16: 8 of 8"]);
  });

  it("sit away from the line, and flip rather than meet a close neighbour's", () => {
    const sides = labelsAbove(recallWeeks(SNAPSHOT));
    // Sep 21 alone, Sep 28 on the axis, then Oct 5 and Oct 12 level: the second flips.
    expect(sides).toEqual([true, true, true, false]);
  });

  it("name the first week and each week with a point", () => {
    // Oct 19 and Oct 26 have no run, so no point and no name.
    expect(weekTicks(recallWeeks({ ...SNAPSHOT, asOf: "2026-10-30" }))).toEqual([
      { start: "2026-09-21", index: 0 }, { start: "2026-09-28", index: 1 }, { start: "2026-10-05", index: 2 }, { start: "2026-10-12", index: 3 },
    ]);
  });
});

describe("CanaryRecall", () => {
  it("shows the rolling headline, the window, the as-of date, and a weekly graph", () => {
    const html = renderToStaticMarkup(<CanaryRecall snapshot={SNAPSHOT} />);
    const shown = text(html);
    expect(shown).toContain("80%");
    expect(shown).toContain("caught 24 of 30 seeded vulnerabilities");
    expect(shown).toContain("30 days before 2026-10-17");
    expect(shown).toContain("seeds known vulnerabilities into a throwaway copy");
    expect(shown).toContain("Monday to Sunday UTC");
    for (const label of ["3 of 6", "no record", "7 of 8", "14 of 16*"]) expect(shown).toContain(label);
    expect(shown).not.toMatch(/\b\d+\/\d+\b/);
    for (const tick of ["100%", "50%", "0%", "Sep 21", "Oct 12"]) expect(shown).toContain(tick);
    expect(shown).toContain("a hollow point marks a week where a Claude run had one");
    expect(shown).toContain("left no record and adds nothing to its week");
    expect(html).toContain(`href="${BASE.runsUrl.replace(/&/g, "&amp;")}"`);
  });

  it("breaks the line at a week without counts, spacing weeks to time", () => {
    const html = renderToStaticMarkup(<CanaryRecall snapshot={SNAPSHOT} />);
    const lines = [...html.matchAll(/<polyline points="([^"]+)"/g)].map(([, points]) => points);
    expect(lines).toEqual([`${slot(0, 4)},50`, `${slot(2, 4)},12 ${slot(3, 4)},12`]);
    const tops = [...html.matchAll(/style="left:([\d.]+)%;top:([\d.]+)%"/g)].map(([, left, top]) => [Number(left), Number(top)]);
    expect(tops).toEqual([[slot(0, 4), 50], [slot(1, 4), 100], [slot(2, 4), 12], [slot(3, 4), 12]]);
  });

  it("opens each week's point onto a link to every run, under a description a screen reader reads", () => {
    const html = renderToStaticMarkup(<CanaryRecall snapshot={SNAPSHOT} />);
    const list = html.match(/<ol aria-label="Percent caught per week, oldest first"[^>]*>(.*)<\/ol>/s)?.[1];
    expect(list).toBeDefined();
    const weeks = [...list!.matchAll(/<details.*?<\/details>/gs)].map(([week]) => ({
      description: week.match(/<span class="sr-only">([^<]+)<\/span>/)?.[1].replace(/&#x27;/g, "'"),
      links: [...week.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(([, href, label]) => [href, label]),
    }));
    expect(weeks).toEqual([
      { description: "Week of Sep 21: caught 3 of 6 over 1 run (50%)", links: [[RUN(1), "Sep 23: 3 of 6"]] },
      { description: "Week of Sep 28: no counts; 1 run left no record", links: [[RUN(6), "Sep 30: no record"]] },
      { description: "Week of Oct 5: caught 7 of 8 over 1 run (88%)", links: [[RUN(2), "Oct 11: 7 of 8"]] },
      {
        description: "Week of Oct 12: caught 14 of 16 over 2 runs (88%); 1 run with a domain that left no finished report; 1 run left no record",
        links: [[RUN(3), "Oct 12: 6 of 8*"], [RUN(4), "Oct 14: no record"], [RUN(5), "Oct 16: 8 of 8"]],
      },
    ]);
  });

  it("shows no percentage and no graph when no canary ran in the window", () => {
    const html = renderToStaticMarkup(<CanaryRecall snapshot={BASE} />);
    const shown = text(html);
    expect(shown).not.toMatch(/%/);
    expect(html).not.toContain("<ol");
    expect(shown).toContain("No canary has run in the last 30 days.");
    expect(shown).toContain("30 days before 2026-10-17");
  });

  it("renders the committed snapshot", () => {
    const shown = text(renderToStaticMarkup(<CanaryRecall snapshot={snapshot} />));
    expect(shown).toContain(snapshot.seeded > 0 ? `caught ${snapshot.caught} of ${snapshot.seeded}` : "No canary has run");
    expect(shown).toContain(snapshot.asOf);
  });
});
