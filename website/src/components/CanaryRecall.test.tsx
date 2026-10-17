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
  windowDays: 90,
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
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
/** The slot `x` puts week `i` of `n` at, as a percentage across the plot. */
const slot = (i: number, n: number) => ((i + 0.5) / n) * 100;
const TZ = process.env.TZ;
afterEach(() => {
  process.env.TZ = TZ;
});

describe("recallWeeks", () => {
  it("buckets every run by its UTC week, Monday to Sunday, across the whole window", () => {
    const weeks = recallWeeks(SNAPSHOT);
    // Jul 19, 90 days before Oct 17, is in the week of Jul 13.
    expect(weeks.map((w) => w.start)).toEqual([
      "2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03", "2026-08-10", "2026-08-17", "2026-08-24",
      "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12",
    ]);
    const byWeek = Object.fromEntries(weeks.map((w) => [w.start, w.runs.map((r) => r.url)]));
    expect(byWeek["2026-10-05"]).toEqual([RUN(2)]);
    expect(byWeek["2026-10-12"]).toEqual([RUN(3), RUN(4), RUN(5)]);
    expect(byWeek["2026-09-28"]).toEqual([RUN(6)]);
    expect(byWeek["2026-09-14"]).toEqual([]);
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
    expect(week["2026-09-14"]).toMatchObject({ seeded: 0, caught: 0, percent: null, unrecorded: 0 });
  });

  it("covers the same runs as the headline, in no more than fourteen weeks", () => {
    for (const s of [SNAPSHOT, snapshot as CanaryRecallSnapshot]) {
      const weeks = recallWeeks(s);
      expect(weeks.length).toBeLessThanOrEqual(14);
      expect(weeks.reduce((n, w) => n + w.seeded, 0)).toBe(s.seeded);
      expect(weeks.reduce((n, w) => n + w.caught, 0)).toBe(s.caught);
      expect(weeks.reduce((n, w) => n + w.runs.length, 0)).toBe(s.runs.length + s.unrecorded.length);
    }
  });
});

describe("week labels", () => {
  it("say counts in words, never with a slash, and list each run", () => {
    const week = Object.fromEntries(recallWeeks(SNAPSHOT).map((w) => [w.start, w]));
    expect(weekLabel(week["2026-10-12"])).toBe("14 of 16*");
    expect(weekLabel(week["2026-09-21"])).toBe("3 of 6");
    expect(weekLabel(week["2026-09-28"])).toBe("no record");
    expect(weekLabel(week["2026-09-14"])).toBeNull();
    expect(weekDescription(week["2026-10-12"])).toBe(
      "Week of Oct 12: caught 14 of 16 over 2 runs (88%); 1 run with a domain that left no finished report; 1 run left no record",
    );
    expect(weekDescription(week["2026-10-05"])).toBe("Week of Oct 5: caught 7 of 8 over 1 run (88%)");
    expect(week["2026-10-12"].runs.map(runLabel)).toEqual(["Oct 12: 6 of 8*", "Oct 14: no record", "Oct 16: 8 of 8"]);
  });

  it("sit away from the line, and flip rather than meet a close neighbour's", () => {
    const sides = labelsAbove(recallWeeks(SNAPSHOT));
    // Sep 21 alone, Sep 28 on the axis, then Oct 5 and Oct 12 level: the second flips.
    expect(sides.slice(10)).toEqual([true, true, true, false]);
  });

  it("name the window's first week and each week with a point, a crowded one on a second row", () => {
    expect(weekTicks(recallWeeks(SNAPSHOT))).toEqual([
      { start: "2026-07-13", index: 0, row: 0, phone: true },
      { start: "2026-09-21", index: 10, row: 0, phone: true },
      { start: "2026-09-28", index: 11, row: 1, phone: true },
      { start: "2026-10-05", index: 12, row: 0, phone: true },
      { start: "2026-10-12", index: 13, row: 1, phone: true },
    ]);
  });
});

describe("CanaryRecall", () => {
  it("shows the rolling headline, the window, the as-of date, and a weekly graph", () => {
    const html = renderToStaticMarkup(<CanaryRecall snapshot={SNAPSHOT} />);
    const shown = text(html);
    expect(shown).toContain("80%");
    expect(shown).toContain("caught 24 of 30 seeded vulnerabilities");
    expect(shown).toContain("90 days before 2026-10-17");
    expect(shown).toContain("seeds known vulnerabilities into a throwaway copy");
    expect(shown).toContain("Monday to Sunday UTC");
    for (const label of ["3 of 6", "no record", "7 of 8", "14 of 16*"]) expect(shown).toContain(label);
    expect(shown).not.toMatch(/\b\d+\/\d+\b/);
    for (const tick of ["100%", "50%", "0%", "Jul 13", "Oct 12"]) expect(shown).toContain(tick);
    expect(shown).toContain("Hollow: a run that week had a domain");
    expect(shown).toContain("left no record and adds nothing to its week");
    expect(html).toContain(`href="${BASE.runsUrl.replace(/&/g, "&amp;")}"`);
  });

  it("breaks the line at a week without counts, spacing weeks to time", () => {
    const html = renderToStaticMarkup(<CanaryRecall snapshot={SNAPSHOT} />);
    const lines = [...html.matchAll(/<polyline points="([^"]+)"/g)].map(([, points]) => points);
    expect(lines).toEqual([`${slot(10, 14)},50`, `${slot(12, 14)},12 ${slot(13, 14)},12`]);
    const tops = [...html.matchAll(/style="left:([\d.]+)%;top:([\d.]+)%"/g)].map(([, left, top]) => [Number(left), Number(top)]);
    expect(tops).toEqual([[slot(10, 14), 50], [slot(11, 14), 100], [slot(12, 14), 12], [slot(13, 14), 12]]);
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
    expect(shown).toContain("No canary has run in the last 90 days.");
    expect(shown).toContain("90 days before 2026-10-17");
  });

  it("renders the committed snapshot", () => {
    const shown = text(renderToStaticMarkup(<CanaryRecall snapshot={snapshot} />));
    expect(shown).toContain(snapshot.seeded > 0 ? `caught ${snapshot.caught} of ${snapshot.seeded}` : "No canary has run");
    expect(shown).toContain(snapshot.asOf);
  });
});
