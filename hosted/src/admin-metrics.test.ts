import { describe, expect, it } from "vitest";
import { summarize } from "./admin-metrics";

describe("summarize", () => {
  const body = {
    days: 3,
    today: "2026-03-01",
    recent: [
      { day: "2026-02-27", event: "voice.speak" as const, label: "ok", count: 4 },
      { day: "2026-03-01", event: "voice.speak" as const, label: "ok", count: 2 },
      { day: "2026-03-01", event: "voice.speak" as const, label: "error", count: 1 },
      { day: "2026-03-01", event: "push.sent" as const, label: "", count: 9 },
    ],
    totals: [
      { event: "voice.speak" as const, label: "ok", count: 10 },
      { event: "voice.speak" as const, label: "error", count: 1 },
      { event: "push.sent" as const, label: "", count: 9 },
    ],
  };

  it("sums each event by day across a month boundary, a day without rows as zero", () => {
    const speak = summarize(body).find((summary) => summary.event === "voice.speak")!;
    expect(speak).toEqual({
      event: "voice.speak",
      total: 11,
      window: 7,
      today: 3,
      labels: [
        { label: "ok", total: 10, window: 6 },
        { label: "capped", total: 0, window: 0 },
        { label: "error", total: 1, window: 1 },
      ],
      daily: [
        { day: "2026-02-27", count: 4 },
        { day: "2026-02-28", count: 0 },
        { day: "2026-03-01", count: 3 },
      ],
    });
  });

  it("lists every event, one never counted at zero, and no label rows for an unlabeled one", () => {
    const summaries = summarize(body);
    expect(summaries.map((summary) => summary.event)).toEqual([
      "enroll.approved",
      "burrow.enrolled",
      "voice.speak",
      "voice.fallback-cap",
      "push.sent",
      "pocket.signin",
    ]);
    expect(summaries.find((summary) => summary.event === "push.sent")!.labels).toEqual([]);
    expect(summaries.find((summary) => summary.event === "pocket.signin")!.total).toBe(0);
  });
});
