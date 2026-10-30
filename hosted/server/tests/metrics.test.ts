import { test, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { createTestContext } from "pgstencil/testing";
import { queryDatabase, withClient } from "pgstencil/postgres";
import { migrations } from "../migrations";
import { METRIC_LABELS, metricLabel, type MetricEvent } from "../metric-labels";
import { authMetricHooks, bestEffort, countMetric, readMetrics } from "../metrics";
import { workerDatabases } from "./worker-roles";

// docs/specs/hosted.md -> "Metrics": aggregate daily counts under fixed
// labels, written by the relay and voice Workers on their own roles. Each
// counted route's wiring is pinned beside its route's tests.

let context: Awaited<ReturnType<typeof createTestContext>>;
let databases: Awaited<ReturnType<typeof workerDatabases>>;

beforeAll(async () => {
  context = await createTestContext({ migrations });
  databases = await workerDatabases(context.database.url);
});
afterAll(async () => {
  await context?.close();
});

const today = async (event: MetricEvent, label = "") =>
  Number(
    (
      await queryDatabase<{ count: string }>(
        context.database.url,
        `SELECT count FROM dormouse_metrics_daily
        WHERE day = (now() AT TIME ZONE 'UTC')::date AND event = $1 AND label = $2`,
        [event, label],
      )
    )[0]?.count ?? 0,
  );

test("a label off its event's list is refused, never counted", async () => {
  expect(metricLabel("voice.speak", "ok")).toBe("ok");
  expect(metricLabel("enroll.approved", "voice")).toBe("voice");
  expect(() => metricLabel("voice.speak", "nonsense")).toThrow(/takes no label/);
  expect(() => metricLabel("burrow.enrolled", "user_123")).toThrow(/takes no label/);
  await expect(countMetric(context.database.url, "pocket.signin", "ada@example.test")).rejects.toThrow(/takes no label/);
  expect(await today("pocket.signin", "ada@example.test")).toBe(0);
});

test("a row holds only day, event, label, and count, and refuses what an identifier looks like", async () => {
  const columns = await queryDatabase<{ name: string; type: string }>(
    context.database.url,
    `SELECT column_name AS name, data_type AS type FROM information_schema.columns
    WHERE table_name = 'dormouse_metrics_daily' ORDER BY ordinal_position`,
  );
  expect(columns).toEqual([
    { name: "day", type: "date" },
    { name: "event", type: "text" },
    { name: "label", type: "text" },
    { name: "count", type: "bigint" },
  ]);
  const insert = (event: string, label: string, count = 1) =>
    queryDatabase(
      context.database.url,
      `INSERT INTO dormouse_metrics_daily (day, event, label, count) VALUES ('2000-01-01', $1, $2, $3)`,
      [event, label, count],
    );
  for (const label of ["ada@example.test", "203.0.113.10", "Mozilla/5.0", "a b", "x".repeat(41)])
    await expect(insert("voice.speak", label), label).rejects.toMatchObject({ code: "23514" });
  for (const event of ["Voice.speak", "voice.speak.ok", "a.b c", `${"x".repeat(39)}.y`])
    await expect(insert(event, ""), event).rejects.toMatchObject({ code: "23514" });
  await expect(insert("voice.speak", "ok", -1)).rejects.toMatchObject({ code: "23514" });
  // Every allowlisted pair fits the checks.
  for (const [event, labels] of Object.entries(METRIC_LABELS) as [MetricEvent, readonly string[]][])
    for (const label of labels) await countMetric(context.database.url, event, label);
});

test("the table holds an event's label only while it is on that event's list", async () => {
  const listed = Object.entries(METRIC_LABELS) as [MetricEvent, readonly string[]][];
  const events = [...listed.map(([event]) => event), "made_up"];
  const labels = [...new Set(["", "x", ...listed.flatMap(([, list]) => list)])];
  // Every pair of a known event and a known label, each inserted on its own.
  const held = await withClient(context.database.url, async (db) => {
    const accepted: string[] = [];
    await db.query("BEGIN");
    for (const event of events)
      for (const label of labels) {
        await db.query("SAVEPOINT pair");
        try {
          await db.query(
            `INSERT INTO dormouse_metrics_daily (day, event, label, count) VALUES ('2000-01-02', $1, $2, 1)`,
            [event, label],
          );
          accepted.push(`${event} ${label}`);
        } catch (error) {
          expect((error as { code?: string }).code, `${event} ${label}`).toBe("23514");
        }
        await db.query("ROLLBACK TO SAVEPOINT pair");
      }
    await db.query("ROLLBACK");
    return accepted;
  });
  expect(held.sort()).toEqual(listed.flatMap(([event, list]) => list.map((label) => `${event} ${label}`)).sort());
});

test("counting upserts today's row, adding n; the relay and voice roles add to it and change nothing else", async () => {
  const before = await today("push.sent");
  await countMetric(databases.relay, "push.sent", "", 3);
  await countMetric(databases.relay, "push.sent");
  expect(await today("push.sent")).toBe(before + 4);
  const capped = await today("voice.speak", "capped");
  await countMetric(databases.voice, "voice.speak", "capped");
  expect(await today("voice.speak", "capped")).toBe(capped + 1);
  for (const url of [databases.relay, databases.voice])
    for (const text of [
      `DELETE FROM dormouse_metrics_daily`,
      `UPDATE dormouse_metrics_daily SET label = 'ok'`,
      `UPDATE dormouse_metrics_daily SET day = day - 1`,
    ])
      await expect(queryDatabase(url, text), text).rejects.toMatchObject({ code: "42501" });
});

test("readMetrics answers the window's rows, ending today, and all-time totals", async () => {
  const day = (back: number) => `(now() AT TIME ZONE 'UTC')::date - ${back}`;
  await queryDatabase(context.database.url, `DELETE FROM dormouse_metrics_daily WHERE event = 'enroll.approved'`);
  await queryDatabase(
    context.database.url,
    `INSERT INTO dormouse_metrics_daily (day, event, label, count) VALUES
      (${day(0)}, 'enroll.approved', 'voice', 2),
      (${day(29)}, 'enroll.approved', 'voice', 3),
      (${day(30)}, 'enroll.approved', 'voice', 5),
      (${day(-1)}, 'enroll.approved', 'voice', 7)`,
  );
  const body = await readMetrics(context.database.url);
  const [{ now, first }] = await queryDatabase<{ now: string; first: string }>(
    context.database.url,
    `SELECT to_char(${day(0)}, 'YYYY-MM-DD') AS now, to_char(${day(29)}, 'YYYY-MM-DD') AS first`,
  );
  expect(body.days).toBe(30);
  expect(body.today).toBe(now);
  // The 31st day back, and tomorrow, are outside the window and inside the totals.
  expect(body.recent.filter((row) => row.event === "enroll.approved")).toEqual([
    { day: first, event: "enroll.approved", label: "voice", count: 3 },
    { day: now, event: "enroll.approved", label: "voice", count: 2 },
  ]);
  expect(body.totals.find((row) => row.event === "enroll.approved" && row.label === "voice")).toEqual({
    event: "enroll.approved",
    label: "voice",
    count: 17,
  });
});

test("a metric's write never fails or delays the response it rides on, and its failure is only logged", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const scheduled: Promise<unknown>[] = [];
    const app = new Hono();
    app.get("/failing", (c) => {
      bestEffort(c, "Metric test", Promise.reject(new Error("permission denied")));
      return c.text("answered");
    });
    app.get("/hung", (c) => {
      bestEffort(c, "Metric test", new Promise(() => {}));
      return c.text("answered");
    });
    const ctx = { waitUntil: (promise: Promise<unknown>) => scheduled.push(promise), passThroughOnException() {}, props: {} };
    for (const path of ["/failing", "/hung"]) {
      const response = await app.request(path, {}, {}, ctx);
      expect([path, response.status, await response.text()]).toEqual([path, 200, "answered"]);
    }
    expect(scheduled).toHaveLength(2);
    await scheduled[0];
    expect(error).toHaveBeenCalledWith("Metric test not recorded: permission denied");
  } finally {
    error.mockRestore();
  }
});

test("the auth hooks never reject: a login by a method off the list is only logged", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    // pgstencil's providers include one Hosted never enables.
    await expect(authMetricHooks(context.database.url).login!({ method: "facebook" })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('Metric login not recorded: login takes no label "facebook"');
    expect(await today("login", "facebook")).toBe(0);
  } finally {
    error.mockRestore();
  }
});
