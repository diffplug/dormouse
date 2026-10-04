// Rules: docs/specs/hosted.md -> "Metrics".
import type { Context } from "hono";
import { queryDatabase } from "pgstencil/postgres";
import { isHostedRef, HOSTED_REFS } from "../../lib/src/lib/hosted-links";
import { CHECKOUT_PLANS, isCheckoutPlan } from "../../website/src/lib/hosted-pricing";
import { providerIds } from "./providers.js";

/** The label an unknown value counts under. */
export const OTHER = "other";
/** The ref label of a visit or checkout that named none. */
export const NO_REF = "none";

const REFS = [...Object.values(HOSTED_REFS), OTHER, NO_REF];
const PLANS = [...CHECKOUT_PLANS, OTHER];
const PLAN_REFS = [...PLANS.flatMap((plan) => REFS.map((ref) => `${plan}:${ref}`)), OTHER];
/** Login methods: the providers, and the emailed code. */
const LOGIN_METHODS = [...providerIds, "email"];

/**
 * Every event Hosted counts, and the only labels each may carry; `[""]` for
 * one counted without a label. A label outside its list counts as `other`.
 */
export const METRIC_LABELS = {
  "account.created": [""],
  login: LOGIN_METHODS,
  "checkout.started": PLAN_REFS,
  "checkout.completed": PLAN_REFS,
  "subscription.canceled": PLANS,
  "subscription.refunded": PLANS,
  "enroll.approved": [""],
  "burrow.enrolled": [""],
  "voice.speak": ["ok", "capped", "error"],
  "voice.fallback-cap": [""],
  "push.sent": [""],
  "pocket.signin": [""],
  "hosted_page.ref": REFS,
} as const satisfies Record<string, readonly string[]>;
export type MetricEvent = keyof typeof METRIC_LABELS;

/** The allowlisted label `label` counts under for `event`, or null when it has none. */
export function metricLabel(event: MetricEvent, label: string): string | null {
  const allowed: readonly string[] = METRIC_LABELS[event];
  if (allowed.includes(label)) return label;
  return allowed.includes(OTHER) ? OTHER : null;
}

/** A `ref` as a label: allowlisted, `none` when absent, `other` otherwise. */
export const refLabel = (ref: unknown): string =>
  isHostedRef(ref) ? ref : ref === undefined || ref === null || ref === "" ? NO_REF : OTHER;

/** A plan name as a label: a plan checkout sells, else `other`. */
export const planLabel = (plan: unknown): string => (isCheckoutPlan(plan) ? plan : OTHER);

/**
 * Adds `n` to today's (UTC) count of `event` under `label`, mapped through
 * its allowlist. Rejects on a database failure; callers go through
 * {@link bestEffort}.
 */
export async function countMetric(databaseUrl: string, event: MetricEvent, label = "", n = 1) {
  const counted = metricLabel(event, label);
  if (counted === null) throw new Error(`no label allowed for ${event}`);
  await queryDatabase(
    databaseUrl,
    `INSERT INTO dormouse_metrics_daily AS m (day, event, label, count)
    VALUES ((now() AT TIME ZONE 'UTC')::date, $1, $2, $3)
    ON CONFLICT (day, event, label) DO UPDATE SET count = m.count + EXCLUDED.count`,
    [event, counted, n],
  );
}

/**
 * Lets `write` finish after the response, through the request's `waitUntil`,
 * and only logs its failure: a metric never fails or delays the request it
 * rides on. The Node dev loop has no ExecutionContext; there the write just
 * runs unawaited.
 */
export function bestEffort(c: Context, what: string, write: Promise<unknown>) {
  const settled = write.then(
    () => {},
    (error: unknown) =>
      console.error(`${what} not recorded: ${error instanceof Error ? error.message : "unknown error"}`),
  );
  try {
    c.executionCtx.waitUntil(settled);
  } catch {
    // No ExecutionContext.
  }
}

/** {@link countMetric}, best-effort. */
export const recordMetric = (c: Context, databaseUrl: string, event: MetricEvent, label = "", n = 1) =>
  bestEffort(c, `Metric ${event}`, countMetric(databaseUrl, event, label, n));

/** How soon after its account a login's session must start to count as the account's creation. */
export const NEW_ACCOUNT_MS = 10_000;

/**
 * The method an auth response just logged in with: an OAuth callback or the
 * emailed code that set a session cookie (as pgstencil's own
 * `auth.login.succeeded` reads it); null for anything else, linking a
 * provider included.
 */
export function loginMethod(request: Request, response: Response): string | null {
  if (response.status >= 400) return null;
  const path = new URL(request.url).pathname;
  const method =
    path === "/api/auth/sign-in/email-otp"
      ? "email"
      : path.startsWith("/api/auth/callback/")
        ? path.slice("/api/auth/callback/".length)
        : null;
  if (!method || !(LOGIN_METHODS as readonly string[]).includes(method)) return null;
  const session = response.headers
    .getSetCookie()
    .some((cookie) => cookie.includes(".session_token=") && !/max-age=0/i.test(cookie));
  return session ? method : null;
}

/**
 * Counts `response`'s login by method and, when its session started with its
 * account, `account.created`: read back through `get-session` with the
 * cookies it set, after the response.
 */
export function recordLogin(
  c: Context,
  host: { databaseUrl: string; auth(request: Request): Response | Promise<Response> },
  request: Request,
  response: Response,
) {
  const method = loginMethod(request, response);
  if (!method) return;
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]!);
  bestEffort(
    c,
    "Login metrics",
    (async () => {
      await countMetric(host.databaseUrl, "login", method);
      const headers = new Headers({ cookie: cookies.join("; ") });
      const address = request.headers.get("cf-connecting-ip");
      if (address) headers.set("cf-connecting-ip", address);
      const answer = await host.auth(new Request(new URL("/api/auth/get-session", request.url), { headers }));
      const read = (await answer.json()) as {
        user?: { createdAt?: unknown };
        session?: { createdAt?: unknown };
      } | null;
      const gap = Date.parse(String(read?.session?.createdAt)) - Date.parse(String(read?.user?.createdAt));
      if (gap >= 0 && gap < NEW_ACCOUNT_MS) await countMetric(host.databaseUrl, "account.created");
    })(),
  );
}

/** How long a checkout's ref waits for its completion. Stripe expires a Checkout Session within a day. */
export const CHECKOUT_REF_DAYS = 2;

/** Keeps the ref checkout `checkoutId` started under, for its completion to count by. */
export const rememberCheckoutRef = (databaseUrl: string, checkoutId: string, ref: string) =>
  queryDatabase(
    databaseUrl,
    `INSERT INTO dormouse_checkout_refs ("checkoutId", ref) VALUES ($1, $2)
    ON CONFLICT ("checkoutId") DO UPDATE SET ref = EXCLUDED.ref, "startedAt" = now()`,
    [checkoutId, ref],
  );

/** Forgets every ref older than {@link CHECKOUT_REF_DAYS}: the account's Cron Trigger. */
export const sweepCheckoutRefs = (databaseUrl: string) =>
  queryDatabase(
    databaseUrl,
    `DELETE FROM dormouse_checkout_refs WHERE "startedAt" < now() - make_interval(days => $1)`,
    [CHECKOUT_REF_DAYS],
  );

/** One day's count, as the admin view reads them. */
export interface MetricRow {
  day: string;
  event: MetricEvent;
  label: string;
  count: number;
}

/** The last `days` UTC days' rows, today included, and every event's all-time totals. */
export async function readMetrics(databaseUrl: string, days = 30) {
  const [recent, totals] = await Promise.all([
    queryDatabase<MetricRow>(
      databaseUrl,
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, event, label, count::int AS count
      FROM dormouse_metrics_daily
      WHERE day > (now() AT TIME ZONE 'UTC')::date - $1::int
      ORDER BY day DESC, event, label`,
      [days],
    ),
    queryDatabase<Omit<MetricRow, "day">>(
      databaseUrl,
      `SELECT event, label, sum(count)::int AS count FROM dormouse_metrics_daily
      GROUP BY event, label ORDER BY event, label`,
      [],
    ),
  ]);
  return { days, recent, totals };
}
