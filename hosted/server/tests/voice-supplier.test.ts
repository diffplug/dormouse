import { expect, test } from "vitest";
import { parseSupplierPlan } from "../voice-supplier";

const plan = { tier: "scale", status: "active", character_count: 5, character_limit: 10 };

test("a cancellation is stored as a change to `cancellation`", () => {
  expect(parseSupplierPlan({ ...plan, pending_change: { kind: "cancellation", timestamp_seconds: 9 } })).toMatchObject({
    changeTo: "cancellation",
    changeAt: 9,
  });
});

// The row holds only these words and numbers, so nothing upstream writes free text into it.
test.each([
  ["no body", null],
  ["a tier that is not a plan word", { ...plan, tier: "spoken text here" }],
  ["a status over the bound", { ...plan, status: "x".repeat(65) }],
  ["a fractional count", { ...plan, character_count: 1.5 }],
  ["a negative limit", { ...plan, character_limit: -1 }],
  ["a reset that is not a time", { ...plan, next_character_count_reset_unix: "soon" }],
  ["a pending change with no date", { ...plan, pending_change: { kind: "change", next_tier: "free" } }],
  ["a pending change with no plan", { ...plan, pending_change: { kind: "change", timestamp_seconds: 9 } }],
])("%s is unreadable", (_, body) => {
  expect(parseSupplierPlan(body)).toBeNull();
});
