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
      { day: "2026-03-01", event: "checkout.started" as const, label: "founding:tutorial", count: 2 },
    ],
    totals: [
      { event: "voice.speak" as const, label: "ok", count: 10 },
      { event: "voice.speak" as const, label: "error", count: 1 },
      { event: "push.sent" as const, label: "", count: 9 },
      { event: "checkout.started" as const, label: "founding:tutorial", count: 2 },
      { event: "checkout.started" as const, label: "yearly:none", count: 1 },
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
      "account.created",
      "login",
      "enroll.approved",
      "burrow.enrolled",
      "voice.speak",
      "voice.fallback-cap",
      "push.sent",
      "pocket.signin",
      "checkout.started",
      "checkout.completed",
      "subscription.canceled",
      "subscription.refunded",
    ]);
    expect(summaries.find((summary) => summary.event === "push.sent")!.labels).toEqual([]);
    expect(summaries.find((summary) => summary.event === "pocket.signin")!.total).toBe(0);
  });

  it("lists a long label list's counted labels alone, and a short list's every label", () => {
    const summaries = summarize(body);
    expect(summaries.find((summary) => summary.event === "checkout.started")!.labels).toEqual([
      { label: "yearly:none", total: 1, window: 0 },
      { label: "founding:tutorial", total: 2, window: 2 },
    ]);
    expect(summaries.find((summary) => summary.event === "subscription.canceled")!.labels).toEqual(
      ["monthly", "yearly", "founding"].map((label) => ({ label, total: 0, window: 0 })),
    );
  });
});
