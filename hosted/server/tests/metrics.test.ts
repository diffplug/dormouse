import { test, expect, beforeAll, afterAll } from "vitest";
import { createTestContext } from "pgstencil/testing";
import { queryDatabase } from "pgstencil/postgres";
import { HOSTED_REFS } from "../../../lib/src/lib/hosted-links";
import { migrations } from "../migrations";
import { loginMethod } from "../account-gate";
import { METRIC_LABELS, metricLabel, planLabel, refLabel, type MetricEvent } from "../metric-labels";
import { countMetric, readMetrics } from "../metrics";
import { workerDatabases } from "./worker-roles";

// docs/specs/hosted.md -> "Metrics": aggregate daily counts under fixed
// labels, written by every Worker on its own role.

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
  (
    await queryDatabase<{ count: string }>(
      context.database.url,
      `SELECT count FROM dormouse_metrics_daily
      WHERE day = (now() AT TIME ZONE 'UTC')::date AND event = $1 AND label = $2`,
      [event, label],
    )
  )[0]?.count;

test("labels come from fixed lists: an unknown ref or plan counts as other, an absent ref as none", () => {
  for (const ref of Object.values(HOSTED_REFS)) expect(refLabel(ref)).toBe(ref);
  expect(refLabel(undefined)).toBe("none");
  expect(refLabel("")).toBe("none");
  for (const ref of ["bogus", "Home", "ada@example.test", 7, { ref: "home" }]) expect(refLabel(ref)).toBe("other");
  expect(planLabel("founding")).toBe("founding");
  expect(planLabel("price_dev_monthly")).toBe("other");
  expect(metricLabel("checkout.started", "yearly:home")).toBe("yearly:home");
  expect(metricLabel("checkout.started", "yearly:someone@example.test")).toBe("other");
  expect(metricLabel("voice.speak", "ok")).toBe("ok");
  expect(metricLabel("login", "github")).toBe("github");
  // An unlabeled event never takes one, and an unknown login method is not counted.
  expect(metricLabel("account.created", "user_123")).toBeNull();
  expect(metricLabel("login", "facebook")).toBeNull();
});

test("a metrics row can hold no identifier: four columns, and every allowed label within the checked shape", async () => {
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
  // The table refuses what an identifier looks like, whatever the code passes.
  for (const label of ["ada@example.test", "203.0.113.10", "Mozilla/5.0", "AbCdEf0123456789AbCdEf0123456789x"])
    await expect(
      queryDatabase(
        context.database.url,
        `INSERT INTO dormouse_metrics_daily (day, event, label, count) VALUES (now()::date, 'login', $1, 1)`,
        [label],
      ),
      label,
    ).rejects.toMatchObject({ code: "23514" });
  for (const [event, labels] of Object.entries(METRIC_LABELS) as [MetricEvent, readonly string[]][])
    for (const label of labels) await countMetric(context.database.url, event, label);
});

test("counting upserts today's row, adding n; the relay and voice roles add to it and change nothing else", async () => {
  const before = Number((await today("push.sent")) ?? 0);
  await countMetric(databases.relay, "push.sent", "", 3);
  await countMetric(databases.relay, "push.sent");
  expect(Number(await today("push.sent"))).toBe(before + 4);
  await countMetric(databases.voice, "voice.speak", "capped");
  expect(await today("voice.speak", "capped")).toBeDefined();
  // `voice.speak` has no `other`: an unknown label throws, for the caller's best-effort log.
  await expect(countMetric(databases.voice, "voice.speak", "nonsense")).rejects.toThrow(/no label/);
  for (const url of [databases.relay, databases.voice])
    for (const text of [
      `DELETE FROM dormouse_metrics_daily`,
      `UPDATE dormouse_metrics_daily SET label = 'other'`,
      `SELECT ref FROM dormouse_checkout_refs`,
    ])
      await expect(queryDatabase(url, text), text).rejects.toMatchObject({ code: "42501" });
});

test("readMetrics answers the last days' rows and all-time totals", async () => {
  await queryDatabase(
    context.database.url,
    `INSERT INTO dormouse_metrics_daily (day, event, label, count)
    VALUES ((now() AT TIME ZONE 'UTC')::date - 40, 'enroll.approved', '', 5)`,
  );
  const before = Number((await today("enroll.approved")) ?? 0);
  await countMetric(context.database.url, "enroll.approved");
  const { recent, totals } = await readMetrics(context.database.url);
  // The 40-day-old row is outside the window, and inside the totals.
  expect(recent.filter((row) => row.event === "enroll.approved")).toEqual([
    { day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), event: "enroll.approved", label: "", count: before + 1 },
  ]);
  expect(totals.find((row) => row.event === "enroll.approved")).toEqual({
    event: "enroll.approved",
    label: "",
    count: before + 6,
  });
});

test("a login is an OAuth callback or the emailed code that set a session cookie", () => {
  const at = (path: string) => new Request(`https://hosted.example.test/api/auth/${path}`);
  const set = (cookie: string, status = 302) => new Response(null, { status, headers: { "set-cookie": cookie } });
  const session = "__Secure-better-auth.session_token=abc.def; Path=/; HttpOnly; Secure";
  expect(loginMethod(at("callback/github"), set(session))).toBe("github");
  expect(loginMethod(at("sign-in/email-otp"), set(session, 200))).toBe("email");
  // Linking sets no session; a cleared cookie, an error, or another path is no login.
  expect(loginMethod(at("callback/github"), new Response(null, { status: 302 }))).toBeNull();
  expect(loginMethod(at("callback/github"), set("__Secure-better-auth.session_token=; Max-Age=0"))).toBeNull();
  expect(loginMethod(at("sign-in/email-otp"), set(session, 401))).toBeNull();
  expect(loginMethod(at("get-session"), set(session, 200))).toBeNull();
  expect(loginMethod(at("callback/facebook"), set(session))).toBeNull();
});
