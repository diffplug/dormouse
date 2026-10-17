import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import snapshot from "../data/canary-recall.json";
import CanaryRecall, {
  type CanaryRecallSnapshot,
  dayLabels,
  labelsAbove,
  recallPoints,
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
// Newest first, as the generator writes them; two runs share Oct 16.
const SNAPSHOT: CanaryRecallSnapshot = {
  ...BASE,
  seeded: 22,
  caught: 15,
  runs: [
    { at: "2026-10-16T23:03:41Z", url: RUN(4), seeded: 8, caught: 4, unfinished: 1 },
    { at: "2026-10-16T19:57:35Z", url: RUN(3), seeded: 8, caught: 7, unfinished: 0 },
    { at: "2026-10-09T02:59:55Z", url: RUN(1), seeded: 6, caught: 4, unfinished: 0 },
  ],
  unrecorded: [{ at: "2026-10-12T16:18:17Z", url: RUN(2) }],
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const point = (percent: number | null) => ({ url: `u${percent}`, at: "", day: "", percent, label: "", description: "", unfinished: 0 });

describe("recallPoints", () => {
  it("orders every run oldest first by time, not day, and labels its counts in words", () => {
    const points = recallPoints(SNAPSHOT);
    expect(points.map((p) => p.url)).toEqual([RUN(1), RUN(2), RUN(3), RUN(4)]);
    expect(points.map((p) => p.day)).toEqual(["Oct 9", "Oct 12", "Oct 16", "Oct 16"]);
    expect(points.map((p) => p.percent)).toEqual([67, null, 88, 50]);
    expect(points.map((p) => p.label)).toEqual(["4 of 6", "no record", "7 of 8", "4 of 8"]);
    expect(points[3].description).toBe("Oct 16: caught 4 of 8 seeded (50%); 1 domain left no finished report");
  });
});

describe("dayLabels", () => {
  it("labels each day once, centred under its runs, and drops a crowded one to a second row", () => {
    const points = recallPoints(SNAPSHOT);
    expect(dayLabels(points)).toEqual([
      { day: "Oct 9", center: 0.5, row: 0 },
      { day: "Oct 12", center: 1.5, row: 1 },
      { day: "Oct 16", center: 3, row: 0 },
    ]);
  });
});

describe("labelsAbove", () => {
  it("puts a peak's label above, a dip's below, and never two close neighbours' on one side", () => {
    expect(labelsAbove([point(50), point(90), point(40)])).toEqual([false, true, false]);
    // 7 of 8 twice: the second flips rather than meeting the first.
    expect(labelsAbove([point(50), point(88), point(88), point(50)])).toEqual([false, true, false, false]);
    expect(labelsAbove([point(null)])).toEqual([true]);
  });
});

describe("CanaryRecall", () => {
  it("shows the rolling headline, the window, the as-of date, and a graph of each run", () => {
    const html = renderToStaticMarkup(<CanaryRecall snapshot={SNAPSHOT} />);
    const shown = text(html);
    expect(shown).toContain("68%");
    expect(shown).toContain("caught 15 of 22 seeded vulnerabilities");
    expect(shown).toContain("90 days before 2026-10-17");
    expect(shown).toContain("seeds known vulnerabilities into a throwaway copy");
    // Counts in words, never a slash that reads as a date.
    for (const label of ["4 of 6", "no record", "7 of 8", "4 of 8*"]) expect(shown).toContain(label);
    expect(shown).not.toMatch(/\b\d+\/\d+\b/);
    // The y axis runs 0–100%, and each day is named once.
    for (const tick of ["100%", "50%", "0%"]) expect(shown).toContain(tick);
    expect(shown.match(/Oct 16/g)).toHaveLength(1);
    // The unfinished and the unrecorded runs say so.
    expect(shown).toContain("Hollow: a domain left no finished report");
    expect(shown).toContain("Dashed, on the axis: a run that scored nothing");
    expect(html).toContain(`href="${BASE.runsUrl.replace(/&/g, "&amp;")}"`);
  });

  it("links each point to its run, oldest first, under a label a screen reader reads", () => {
    const html = renderToStaticMarkup(<CanaryRecall snapshot={SNAPSHOT} />);
    const list = html.match(/<ol aria-label="Percent caught per canary run, oldest first"[^>]*>(.*?)<\/ol>/s)?.[1];
    expect(list).toBeDefined();
    const links = [...list!.matchAll(/<a href="([^"]+)"[^>]*aria-label="([^"]+)"/g)].map(([, href, label]) => [href, label]);
    expect(links).toEqual([
      [RUN(1), "Oct 9: caught 4 of 6 seeded (67%)"],
      [RUN(2), "Oct 12: no record; the run scored nothing"],
      [RUN(3), "Oct 16: caught 7 of 8 seeded (88%)"],
      [RUN(4), "Oct 16: caught 4 of 8 seeded (50%); 1 domain left no finished report"],
    ]);
  });

  it("draws the line through the plotted runs, left to right on 0–100%", () => {
    const html = renderToStaticMarkup(<CanaryRecall snapshot={SNAPSHOT} />);
    expect(html).toContain('points="12.5,33 62.5,12 87.5,50"');
    // Each point sits at its slot and height; the unrecorded one on the axis.
    const tops = [...html.matchAll(/style="left:([\d.]+)%;top:([\d.]+)%"/g)].map(([, left, top]) => [Number(left), Number(top)]);
    expect(tops).toEqual([[12.5, 33], [37.5, 100], [62.5, 12], [87.5, 50]]);
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
