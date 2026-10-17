import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import snapshot from "../data/canary-recall.json";
import CanaryRecall, { type CanaryRecallSnapshot } from "./CanaryRecall";

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
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

describe("CanaryRecall", () => {
  it("shows caught over seeded, the percentage, the window, the as-of date, and each run", () => {
    const html = renderToStaticMarkup(
      <CanaryRecall
        snapshot={{
          ...BASE,
          seeded: 16,
          caught: 11,
          runs: [
            { date: "2026-10-16", url: RUN(2), seeded: 8, caught: 4, unfinished: 1 },
            { date: "2026-10-09", url: RUN(1), seeded: 8, caught: 7, unfinished: 0 },
          ],
          unrecorded: [{ date: "2026-10-12", url: RUN(3) }],
        }}
      />,
    );
    const shown = text(html);
    expect(shown).toContain("69%");
    expect(shown).toContain("caught 11 of 16 seeded vulnerabilities");
    expect(shown).toContain("90 days before 2026-10-17");
    expect(shown).toContain("seeds known vulnerabilities into a throwaway copy");
    expect(shown).toContain("2026-10-16 4/8, 1 domain unfinished");
    expect(shown).toContain("2026-10-09 7/8");
    expect(shown).toContain("2026-10-12 no record");
    for (const id of [1, 2, 3]) expect(html).toContain(`href="${RUN(id)}"`);
    expect(html).toContain(`href="${BASE.runsUrl.replace(/&/g, "&amp;")}"`);
  });

  it("shows no percentage when no canary ran in the window", () => {
    const shown = text(renderToStaticMarkup(<CanaryRecall snapshot={BASE} />));
    expect(shown).not.toMatch(/%/);
    expect(shown).toContain("No canary has run in the last 90 days.");
    expect(shown).toContain("90 days before 2026-10-17");
  });

  it("renders the committed snapshot", () => {
    const shown = text(renderToStaticMarkup(<CanaryRecall snapshot={snapshot} />));
    expect(shown).toContain(snapshot.seeded > 0 ? `caught ${snapshot.caught} of ${snapshot.seeded}` : "No canary has run");
    expect(shown).toContain(snapshot.asOf);
  });
});
