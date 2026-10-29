import { test, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { EmailDev } from "pgstencil";
import { createTestContext } from "pgstencil/testing";
import { queryDatabase } from "pgstencil/postgres";
import { FOUNDING_COHORT_SIZE, FOUNDING_LADDER, LIST_ANNUAL, LIST_MONTHLY } from "../../../website/src/lib/hosted-pricing";
import { WITHDRAWAL_STATEMENT } from "../../../website/src/lib/hosted-withdrawal";
import { END_REASONS, resyncBilling, type BillingSetup } from "../billing";
import { COHORT_ENDPOINT, MAX_SHOWN_FOUNDERS } from "../../../website/src/lib/hosted-cohorts";
import {
  BILLING_WEBHOOK_PATH,
  CONSENT_REQUIRED,
  FOUNDERS_ONLY,
  TERMS_CHANGED,
  WEBHOOK_BODY_BYTES,
  WITHDRAWAL_CLOSED,
  billingRoutes,
  disputeAction,
} from "../billing-routes";
import { CLOSE_RECENT_LOGIN, CLOSE_UNAVAILABLE, closureRoutes } from "../closure";
import { AVATAR_BYTES, COHORT_CACHE_MS, FOUNDER_AVATAR_PREFIX, cohortRoutes } from "../cohort-routes";
import { entitledSql } from "../entitlement";
import { WITHDRAWAL_OPEN_DAYS } from "../withdrawal";
import { migrations } from "../migrations";
import { DEV_FOUNDING_PRICES } from "../billing-dev";
import { CHECKOUT_CLOSED, PRICE_CHANGED, TERMS_VERSION } from "../policy-constants";
import { ORIGINS } from "./bundle";
import { CHANGED_PRICES, CHANGED_USD, stripeFake } from "./stripe-fake";
import { workerDatabases } from "./worker-roles";

// The billing routes in Node, on real Postgres and the Stripe fake: what a
// signed-in account may ask, what Stripe's webhook does, and what each counts.

const origin = ORIGINS.account;
/** What the checkout page sends once both boxes are ticked, beside `plan` at the price it showed. */
const consent = (plan: string) => ({
  plan,
  terms: TERMS_VERSION,
  autoRenew: true,
  price: plan === "monthly" ? LIST_MONTHLY : plan === "yearly" ? LIST_ANNUAL : FOUNDING_LADDER[0],
});

async function fixture({ closed = false } = {}) {
  const context = await createTestContext({ migrations, now: new Date().toISOString() });
  const databases = await workerDatabases(context.database.url);
  const stripe = await stripeFake(context.time, context.random);
  const sql = <Row extends Record<string, unknown>>(text: string, values?: unknown[]) =>
    queryDatabase<Row>(context.database.url, text, values);
  /** user id → its session's user, as `get-session` answers it, and when that login began. */
  const users = new Map<string, { id: string; email: string | null; emailVerified: boolean }>();
  const logins = new Map<string, string>();
  const email = new EmailDev(context.time);
  /** Mail sends to fail, before any goes out. */
  const mailing = { failures: 0 };
  const mail = () => ({
    send: async (message: Parameters<EmailDev["send"]>[0]) => {
      if (mailing.failures > 0) {
        mailing.failures--;
        throw new Error("Postmark outage");
      }
      await email.send(message);
    },
  });
  /** Each Burrow socket closure asked to close. */
  const closedBurrows: string[] = [];
  const host = {
    databaseUrl: context.database.url,
    auth: async (request: Request) => {
      const id = /(?:^|; )u=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
      const user = id && users.get(id);
      return Response.json(user ? { user, session: { createdAt: logins.get(user.id) ?? new Date().toISOString() } } : null);
    },
    setup: (): BillingSetup | null => (closed ? null : stripe.setup),
    mail,
    closeBurrow: async (_userId: string, burrowId: string) => closedBurrows.push(burrowId),
  };
  const app = new Hono();
  billingRoutes(app, () => host);
  closureRoutes(app, () => host);
  /** The isolate's clock the public routes cache by. */
  const clock = { now: 1_000_000 };
  cohortRoutes(
    app,
    () => ({ databaseUrl: context.database.url, setup: (): BillingSetup | null => (closed ? null : stripe.setup) }),
    () => clock.now,
  );
  // The account Worker's `onError`.
  app.onError((_error, c) => c.json({ message: "unavailable" }, 503));
  /** A public read, as the site's Worker forwards it: no cookie, no browser headers; in a Worker, with its `ctx`. */
  const visit = (path: string, ctx?: { waitUntil(promise: Promise<unknown>): void }) =>
    app.request(
      origin + path,
      { headers: { accept: "*/*" } },
      undefined,
      ctx && { ...ctx, passThroughOnException: () => {}, props: {} },
    );

  /** A signed-in account; `email: null` is a provider-only one. */
  const account = async (email: string | null = `${randomUUID()}@example.test`, emailVerified = email !== null) => {
    const id = randomUUID();
    await sql(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $1, $2, $3)`, [
      id,
      email ?? `${id}@identity.pgstencil.invalid`,
      emailVerified,
    ]);
    users.set(id, { id, email, emailVerified });
    const request = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
      app.request(origin + path, {
        method: init.method ?? "GET",
        headers: {
          cookie: `u=${id}`,
          "content-type": "application/json",
          ...((init.method ?? "GET") === "GET" ? { "sec-fetch-site": "same-origin" } : { origin }),
          ...init.headers,
        },
        ...(init.body !== undefined && { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
      });
    const summary = async () => (await (await request("/api/billing")).json()) as Record<string, unknown>;
    return { id, request, summary };
  };

  const webhook = (body: string, signature?: string) =>
    app.request(origin + BILLING_WEBHOOK_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", ...(signature && { "stripe-signature": signature }) },
      body,
    });
  /** Signs and sends `event` to the webhook. */
  const send = (event: Parameters<typeof stripe.dev.signed>[0]) => {
    const { body, signature } = stripe.dev.signed(event);
    return webhook(body, signature);
  };
  /** Every event {@link deliver} sent, in order. */
  const delivered: Parameters<typeof send>[0][] = [];
  /** Sends every pending StripeDev event, each answered 200. */
  const deliver = async () => {
    while (stripe.dev.events.length) {
      const response = await send(stripe.dev.events[0]!);
      expect(response.status, await response.clone().text()).toBe(200);
      delivered.push(stripe.dev.events.shift()!);
    }
  };
  /** A request with no login, from the account's own page. */
  const anonymous = (path: string, method = "GET") =>
    app.request(origin + path, {
      method,
      headers: { "content-type": "application/json", ...(method === "GET" ? { "sec-fetch-site": "same-origin" } : { origin }) },
      ...(method !== "GET" && { body: "{}" }),
    });
  /** Starts `plan` for `who` and completes it in StripeDev, delivering its events. */
  const buy = async (who: Awaited<ReturnType<typeof account>>, plan: string, ref?: string) => {
    const started = await who.request("/api/billing/checkout", { method: "POST", body: { ...consent(plan), ref } });
    expect(started.status, await started.clone().text()).toBe(200);
    const { url } = (await started.json()) as { url: string };
    const session = [...stripe.dev.checkouts.values()].find((s) => s.url === url)!;
    const subscription = stripe.dev.completeCheckout(session.id);
    await deliver();
    return { session, subscription };
  };
  /** Each subscription Hosted ended (`billing.end`), and the reason it recorded. */
  const ended = () =>
    sql<{ subscription: string; reason: string }>(
      `SELECT id AS subscription, end_reason AS reason FROM pgstencil_billing.subscriptions
      WHERE end_reason IS NOT NULL ORDER BY id`,
    );
  const metrics = () =>
    sql<{ event: string; label: string; count: string }>(
      `SELECT event, label, count FROM dormouse_metrics_daily WHERE event LIKE 'checkout.%' OR event LIKE 'subscription.%'
      ORDER BY event, label`,
    ).then((rows) => rows.map((row) => `${row.event} ${row.label} ${row.count}`));
  /** Whether `userId` is entitled, as each Worker's own role reads it. */
  const entitledOn = async (userId: string) => {
    const read = async (url: string) =>
      (await queryDatabase<{ is: boolean }>(url, `SELECT ${entitledSql("u")} AS is FROM "user" u WHERE u.id = $1`, [userId]))[0]
        ?.is;
    const all = [await read(databases.account), await read(databases.relay), await read(databases.voice)];
    expect(new Set(all).size, "every Worker's role agrees").toBe(1);
    return all[0];
  };
  return {
    ...context,
    ...stripe,
    sql,
    account,
    anonymous,
    delivered,
    webhook,
    send,
    deliver,
    buy,
    metrics,
    ended,
    entitledOn,
    email,
    mail,
    mailing,
    logins,
    closedBurrows,
    clock,
    visit,
    close: async () => {
      await stripe.close();
      await context.close();
    },
  };
}

test("a dispute's status suspends, restores, or ends, and an inquiry changes nothing", () => {
  expect(
    ["needs_response", "under_review", "won", "warning_closed", "prevented", "lost", "warning_needs_response", "new_status"].map(
      disputeAction,
    ),
  ).toEqual(["suspend", "suspend", "restore", "restore", "restore", "end", null, null]);
});

test("closed, a signed-in account reads billing as closed and every billing change but leaving the founders row answers 409, after the login gate", async ({
  onTestFinished,
}) => {
  const f = await fixture({ closed: true });
  onTestFinished(f.close);
  const member = await f.account();
  const read = await member.request("/api/billing");
  expect([read.status, await read.json()]).toEqual([200, { closed: true }]);
  expect((await f.anonymous("/api/billing")).status).toBe(401);
  for (const [method, path, body] of [
    ["POST", "/api/billing/checkout", { plan: "monthly" }],
    ["POST", "/api/billing/confirm", { checkout: "op_x" }],
    ["POST", "/api/billing/portal"],
    ["POST", "/api/billing/withdraw", { subscription: "sub_x" }],
    ["PUT", "/api/billing/founder", { shown: true, name: "Ada" }],
  ] as const) {
    const response = await member.request(path, { method, body });
    expect([path, response.status, await response.json()]).toEqual([path, 409, { message: CHECKOUT_CLOSED }]);
    expect((await f.anonymous(path, method)).status, path).toBe(401);
  }
  // Stripe's events wait, retried, until billing opens.
  const { body, signature } = f.dev.signed(f.event("customer.updated", { id: "cus_x" }));
  expect((await f.webhook(body, signature)).status).toBe(503);
  // Leaving needs nothing from billing.
  await f.sql(`INSERT INTO dormouse_founders ("userId", name) VALUES ($1, 'Ada')`, [member.id]);
  expect((await member.request("/api/billing/founder", { method: "PUT", body: { shown: false } })).status).toBe(204);
  expect(await f.sql(`SELECT name FROM dormouse_founders`)).toEqual([]);
});

test("checkout takes a plan and a ref, never a Price, customer, quantity, or return URL, and counts from the webhook once", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const member = await f.account();
  expect(await member.summary()).toMatchObject({ plan: null, active: false, entitled: false, suspended: false });
  for (const plan of ["price_dev_monthly", "annual", "", 7, null]) {
    const refused = await member.request("/api/billing/checkout", { method: "POST", body: { plan } });
    expect([refused.status, await refused.json()], String(plan)).toEqual([400, { message: "Choose monthly, yearly, or founding." }]);
  }
  const big = JSON.stringify({ plan: "monthly", pad: "x".repeat(4096) });
  expect((await member.request("/api/billing/checkout", { method: "POST", body: big })).status).toBe(413);
  // Another origin's page never starts one.
  expect(
    (await member.request("/api/billing/checkout", { method: "POST", body: { plan: "monthly" }, headers: { origin: ORIGINS.relay } }))
      .status,
  ).toBe(403);

  // A first checkout for monthly, then founding: the open monthly one is expired first.
  const first = await member.request("/api/billing/checkout", {
    method: "POST",
    body: {
      ...consent("monthly"),
      ref: "settings-voice",
      priceId: "price_x",
      line_items: [{ price: "price_x", quantity: 3 }],
      customer: "cus_x",
      quantity: 3,
      success_url: "https://attacker.example/",
      owner: "someone-else",
    },
  });
  expect(first.status).toBe(200);
  const sessions = () => f.dev.requests.filter((r) => r.path === "/v1/checkout/sessions");
  expect(sessions()[0]!.body).toMatchObject({
    "line_items[0][price]": f.setup.monthly,
    "line_items[0][quantity]": "1",
    "metadata[pgstencil_ref]": "settings-voice",
    client_reference_id: member.id,
    success_url: expect.stringMatching(new RegExp(`^${origin}/billing\\?`)),
  });
  expect(f.dev.requests.find((r) => r.path === "/v1/customers")!.body).toMatchObject({ email: expect.stringContaining("@example.test") });

  const { session } = await f.buy(member, "founding", "settings-voice");
  expect([...f.dev.checkouts.values()][0]!.status).toBe("expired");
  expect(sessions()[1]!.body["line_items[0][price]"]).toBe(f.setup.founding[0]);
  await vi.waitFor(async () =>
    expect(await f.metrics()).toEqual([
      "checkout.completed founding:settings-voice 1",
      "checkout.started founding:settings-voice 1",
      "checkout.started monthly:settings-voice 1",
    ]),
  );
  // A redelivery is answered, and counts nothing again.
  expect((await f.send(f.delivered.find((event) => event.type === "checkout.session.completed")!)).status).toBe(200);
  expect(await f.metrics()).toContain("checkout.completed founding:settings-voice 1");

  expect(await member.summary()).toEqual({
    plan: "founding",
    price: FOUNDING_LADDER[0],
    active: true,
    until: expect.any(String),
    renews: true,
    entitled: true,
    suspended: false,
    founding: { cohort: 0, seatsLeft: FOUNDING_COHORT_SIZE - 1 },
    founder: { offered: true, name: null },
    consent: { termsVersion: TERMS_VERSION, consentedAt: expect.any(String) },
    // No billing country: offered, as an EEA or UK consumer's would be.
    withdrawal: { subscription: expect.any(String), startedAt: expect.any(String), until: expect.any(String), email: expect.any(String) },
    withdrawn: null,
  });
  // The return page confirms the operation it names, and only a well-formed one.
  for (const checkout of ["", "../x", "x".repeat(65), 7])
    expect((await member.request("/api/billing/confirm", { method: "POST", body: { checkout } })).status).toBe(404);
  const confirmed = await member.request("/api/billing/confirm", {
    method: "POST",
    body: { checkout: session.metadata!.pgstencil_operation },
  });
  expect([confirmed.status, await confirmed.json()]).toEqual([200, expect.objectContaining({ plan: "founding" })]);
  // A held subscription is managed in the portal, never bought twice.
  const portal = await member.request("/api/billing/portal", { method: "POST" });
  expect(((await portal.json()) as { url: string }).url).toBe(`${f.dev.origin}/portal/${session.customer}`);
  expect((await member.request("/api/billing/checkout", { method: "POST", body: consent("yearly") })).status).toBe(409);

  // An unknown ref counts as `other`, and none as `none`, which sends Stripe no ref.
  const other = await f.account();
  await f.buy(other, "yearly", "attacker-chosen");
  const none = await f.account(null);
  await f.buy(none, "monthly");
  const created = sessions().slice(-2).map((s) => s.body["metadata[pgstencil_ref]"]);
  expect(created).toEqual(["other", undefined]);
  // A provider-only account sends Stripe no email: Checkout asks for one.
  expect(f.dev.requests.filter((r) => r.path === "/v1/customers").at(-1)!.body).toEqual({
    "metadata[pgstencil_owner]": none.id,
  });
  // Nor does an address the account has not verified.
  const unverified = await f.account(`${randomUUID()}@example.test`, false);
  expect((await unverified.request("/api/billing/checkout", { method: "POST", body: consent("monthly") })).status).toBe(200);
  expect(f.dev.requests.filter((r) => r.path === "/v1/customers").at(-1)!.body).toEqual({
    "metadata[pgstencil_owner]": unverified.id,
  });
  await vi.waitFor(async () =>
    expect(await f.metrics()).toEqual([
      "checkout.completed founding:settings-voice 1",
      "checkout.completed monthly:none 1",
      "checkout.completed yearly:other 1",
      "checkout.started founding:settings-voice 1",
      "checkout.started monthly:none 2",
      "checkout.started monthly:settings-voice 1",
      "checkout.started yearly:other 1",
    ]),
  );
});

test("checkout starts only after agreement to the current terms and to automatic renewal, recorded with what it offered", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const member = await f.account();
  const consents = () =>
    f.sql<{ checkoutId: string; termsVersion: string; userId: string; plan: string; priceId: string }>(
      `SELECT "checkoutId", "termsVersion", "userId", plan, "priceId" FROM dormouse_checkout_consents ORDER BY "consentedAt"`,
    );
  const { price: _price, ...unpriced } = consent("yearly");
  for (const body of [
    { plan: "yearly" },
    { plan: "yearly", terms: TERMS_VERSION, price: LIST_ANNUAL },
    { ...consent("yearly"), autoRenew: "yes" },
    { ...consent("yearly"), terms: undefined },
    unpriced,
    { ...consent("yearly"), price: "100" },
  ]) {
    const refused = await member.request("/api/billing/checkout", { method: "POST", body });
    expect([refused.status, await refused.json()], JSON.stringify(body)).toEqual([400, { message: CONSENT_REQUIRED }]);
  }
  const stale = await member.request("/api/billing/checkout", {
    method: "POST",
    body: { ...consent("yearly"), terms: "2020-01-01" },
  });
  expect([stale.status, await stale.json()]).toEqual([409, { message: TERMS_CHANGED }]);
  expect(f.dev.requests.filter((r) => r.path === "/v1/checkout/sessions")).toEqual([]);
  expect(await consents()).toEqual([]);

  // Recorded as the checkout starts; the plan's confirmation shows it only once one completes.
  expect((await member.request("/api/billing/checkout", { method: "POST", body: consent("monthly") })).status).toBe(200);
  expect(await consents()).toMatchObject([{ plan: "monthly", priceId: f.setup.monthly }]);
  expect(await member.summary()).toMatchObject({ plan: null, consent: null });
  const { session } = await f.buy(member, "yearly");
  const operation = session.metadata!.pgstencil_operation!;
  expect((await consents())[1]).toEqual({
    checkoutId: operation,
    termsVersion: TERMS_VERSION,
    userId: member.id,
    plan: "yearly",
    priceId: f.setup.yearly,
  });
  const [{ at }] = await f.sql<{ at: Date }>(`SELECT "consentedAt" AS at FROM dormouse_checkout_consents WHERE "checkoutId" = $1`, [
    operation,
  ]);
  const held = await member.summary();
  expect(held).toMatchObject({
    plan: "yearly",
    price: LIST_ANNUAL,
    founder: { offered: false, name: null },
    consent: { termsVersion: TERMS_VERSION },
  });
  expect(Date.parse((held.consent as { consentedAt: string }).consentedAt)).toBe(at.getTime());
  // Kept once the subscription and the account are gone: it is a billing record.
  await f.sql(`DELETE FROM "user" WHERE id = $1`, [member.id]);
  expect(await consents()).toHaveLength(2);
});

test("checkout refuses a price the page did not show before opening one, expiring one left open, so the consent records the one it did", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const consents = () => f.sql<{ priceId: string }>(`SELECT "priceId" FROM dormouse_checkout_consents ORDER BY "consentedAt"`);
  const start = (who: Awaited<ReturnType<typeof f.account>>, plan: string, price: number) =>
    who.request("/api/billing/checkout", { method: "POST", body: { ...consent(plan), price } });
  const statuses = () => [...f.dev.checkouts.values()].map((session) => session.status);
  const member = await f.account();
  for (const [plan, price] of [["founding", FOUNDING_LADDER[1]!], ["yearly", LIST_MONTHLY]] as const) {
    const changed = await start(member, plan, price);
    expect([changed.status, await changed.json()], plan).toEqual([409, { message: PRICE_CHANGED }]);
  }
  expect(statuses()).toEqual([]);

  // A founding checkout opens at the first step, then the cohort sells out.
  const late = await f.account();
  expect((await start(late, "founding", FOUNDING_LADDER[0]!)).status).toBe(200);
  await f.sql(
    `WITH owners AS (
      INSERT INTO pgstencil_billing.accounts (owner_id, email, created_at)
      SELECT 'filler-' || n, 'filler@example.test', now() FROM generate_series(1, $1::int) n
      RETURNING owner_id)
    INSERT INTO pgstencil_billing.subscriptions
      (id, owner_id, price_id, status, started_at, period_end, cancel_at_period_end, updated_at)
    SELECT 'sub_' || owner_id, owner_id, $2, 'active', now() - interval '40 days',
      now() + interval '325 days', false, now() FROM owners`,
    [FOUNDING_COHORT_SIZE, f.setup.founding[0]],
  );
  // A page still showing the sold-out step is refused.
  expect((await start(member, "founding", FOUNDING_LADDER[0]!)).status).toBe(409);
  // The reloaded page shows the next step, but the checkout left open would charge the first: it is expired.
  expect((await start(late, "founding", FOUNDING_LADDER[1]!)).status).toBe(409);
  expect(statuses()).toEqual(["expired"]);
  expect(await consents()).toEqual([{ priceId: f.setup.founding[0] }]);
  // Asked again, it opens at the price shown, and its consent says so.
  expect((await start(late, "founding", FOUNDING_LADDER[1]!)).status).toBe(200);
  expect(await consents()).toEqual([{ priceId: f.setup.founding[0] }, { priceId: f.setup.founding[1] }]);
  expect(f.dev.requests.filter((r) => r.path === "/v1/checkout/sessions").at(-1)!.body["line_items[0][price]"]).toBe(
    f.setup.founding[1],
  );
});

test("only a founding subscription joins the founders row, under a checked name, and leaving is always allowed", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const founders = () => f.sql<{ userId: string; name: string }>(`SELECT "userId", name FROM dormouse_founders`);
  const put = (who: Awaited<ReturnType<typeof f.account>>, body: unknown) =>
    who.request("/api/billing/founder", { method: "PUT", body });

  const yearly = await f.account();
  await f.buy(yearly, "yearly");
  const refused = await put(yearly, { shown: true, name: "Yearly" });
  expect([refused.status, await refused.json()]).toEqual([409, { message: FOUNDERS_ONLY }]);
  expect((await put(await f.account(), { shown: true, name: "Nobody" })).status).toBe(409);

  const founder = await f.account();
  const { subscription } = await f.buy(founder, "founding");
  for (const body of [
    { shown: true },
    { shown: true, name: "" },
    { shown: true, name: " Ada" },
    { shown: true, name: "Ada\u0007" },
    { shown: true, name: "A\u200bda" },
    { shown: true, name: "Ada\u2028Lovelace" },
    { shown: true, name: "x".repeat(65) },
    { shown: "yes", name: "Ada" },
    { name: "Ada" },
  ])
    expect((await put(founder, body)).status, JSON.stringify(body)).toBe(400);
  // Another origin's page never changes it.
  expect(
    (await founder.request("/api/billing/founder", { method: "PUT", body: { shown: false }, headers: { origin: ORIGINS.relay } }))
      .status,
  ).toBe(403);
  expect(await founders()).toEqual([]);
  // The table refuses what the route does, should a later writer skip the check.
  for (const name of [" Ada", "A\u200bda", "Ada\u0085", "x".repeat(65)])
    await expect(
      f.sql(`INSERT INTO dormouse_founders ("userId", name) VALUES ($1, $2)`, [founder.id, name]),
      JSON.stringify(name),
    ).rejects.toThrow(/check constraint/);

  const shown = await put(founder, { shown: true, name: "🐭".repeat(64) });
  expect([shown.status, await shown.json()]).toEqual([
    200,
    expect.objectContaining({ founder: { offered: true, name: "🐭".repeat(64) } }),
  ]);
  const [{ since }] = await f.sql<{ since: Date }>(`SELECT "shownSince" AS since FROM dormouse_founders`);
  // A rename keeps its place in the row.
  expect((await put(founder, { shown: true, name: "Ada Lovelace" })).status).toBe(200);
  expect(await f.sql(`SELECT name, "shownSince" AS since FROM dormouse_founders`)).toEqual([{ name: "Ada Lovelace", since }]);
  expect((await put(founder, { shown: false })).status).toBe(204);
  expect(await founders()).toEqual([]);
  expect((await put(founder, { shown: true, name: "Ada" })).status).toBe(200);

  // Lapsed, it cannot join or rename, but it can still leave.
  f.dev.transition(subscription.id, "cancel");
  await f.deliver();
  expect((await put(founder, { shown: true, name: "Ada again" })).status).toBe(409);
  expect(await founders()).toEqual([{ userId: founder.id, name: "Ada" }]);
  expect(await founder.summary()).toMatchObject({ founder: { offered: false, name: "Ada" } });
  expect((await put(founder, { shown: false })).status).toBe(204);
  expect(await founders()).toEqual([]);
});

test("the webhook verifies the raw body before any write, caps it, and refuses another mode, API version, or Connect account", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const event = f.event("customer.updated", { id: "cus_x" });
  const { body, signature } = f.dev.signed(event);
  expect((await f.webhook(body)).status).toBe(400);
  expect((await f.webhook(body.replace(event.id, "evt_forged"), signature)).status).toBe(400);
  expect((await f.webhook(body, "t=1,v1=00")).status).toBe(400);
  expect((await f.webhook("x".repeat(WEBHOOK_BODY_BYTES + 1), signature)).status).toBe(413);
  for (const extra of [{ livemode: true }, { api_version: "2020-08-27" }, { account: "acct_connected" }]) {
    const { body: other, signature: signed } = f.dev.signed(f.event("customer.updated", { id: "cus_x" }, extra));
    expect((await f.webhook(other, signed)).status, JSON.stringify(extra)).toBe(400);
  }
  expect(await f.sql(`SELECT id FROM pgstencil_billing.events`)).toEqual([]);
  expect((await f.webhook(body, signature)).status).toBe(200);
  expect(await f.sql(`SELECT id FROM pgstencil_billing.events`)).toEqual([{ id: event.id }]);
  // A failure before the commit answers 503, which Stripe retries, and the event stays unprocessed.
  const { body: disputed, signature: disputeSignature } = f.dev.signed(
    f.event("charge.dispute.created", { id: "du_unknown", object: "dispute", charge: "ch_for_du_unknown" }),
  );
  expect((await f.webhook(disputed, disputeSignature)).status).toBe(503);
  expect(await f.sql(`SELECT count(*)::int AS n FROM pgstencil_billing.events WHERE processed_at IS NOT NULL`)).toEqual([{ n: 1 }]);
});

test("a full refund ends the subscription it paid for at once; a partial one changes nothing", async ({ onTestFinished }) => {
  const f = await fixture();
  onTestFinished(f.close);
  const member = await f.account();
  const { session, subscription } = await f.buy(member, "founding");
  f.paidInvoices.set("pi_1", subscription.id);
  const charge = (refunded: boolean, paymentIntent = "pi_1") =>
    f.event("charge.refunded", {
      id: `ch_${paymentIntent}`,
      object: "charge",
      customer: session.customer,
      payment_intent: paymentIntent,
      refunded,
      amount: 5000,
      amount_refunded: refunded ? 5000 : 1000,
    });

  expect((await f.send(charge(false))).status).toBe(200);
  expect(f.cancels).toEqual([]);
  expect(await f.entitledOn(member.id)).toBe(true);

  // Past the refund window, as a yearly renewal's refund is: the subscription's end says why.
  f.time.advanceMilliseconds(31 * 24 * 60 * 60 * 1000);
  const full = charge(true);
  expect((await f.send(full)).status).toBe(200);
  expect(f.cancels).toEqual([{ subscription: subscription.id }]);
  expect(await f.ended()).toEqual([{ subscription: subscription.id, reason: END_REASONS.refund }]);
  expect(await f.entitledOn(member.id)).toBe(false);
  expect(await member.summary()).toMatchObject({ plan: null, active: false, entitled: false });
  await f.deliver();
  // A redelivery ends nothing more.
  expect((await f.send(full)).status).toBe(200);
  expect(f.cancels).toHaveLength(1);
  await vi.waitFor(async () => expect(await f.metrics()).toContain("subscription.refunded founding 1"));
  expect((await f.metrics()).filter((row) => row.startsWith("subscription.canceled"))).toEqual([]);
});

test("an open dispute suspends without ending, closing it in the account's favor restores it, and a lost one ends it", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const member = await f.account();
  const { session, subscription } = await f.buy(member, "yearly");
  f.paidInvoices.set("pi_du_2", subscription.id);
  const dispute = (id: string, status: string) => {
    f.disputes.set(id, { status, customer: session.customer as string, paymentIntent: `pi_${id}` });
    return f.event(status === "needs_response" ? "charge.dispute.created" : "charge.dispute.closed", {
      id,
      object: "dispute",
      charge: `ch_for_${id}`,
      status,
    });
  };

  const opened = dispute("du_1", "needs_response");
  expect((await f.send(opened)).status).toBe(200);
  expect(await f.entitledOn(member.id)).toBe(false);
  expect(await member.summary()).toMatchObject({ plan: "yearly", active: true, entitled: false, suspended: true });
  expect(f.cancels).toEqual([]);

  expect((await f.send(dispute("du_1", "won"))).status).toBe(200);
  expect(await f.entitledOn(member.id)).toBe(true);
  // A stale delivery of the opening is read against the dispute's current status.
  expect((await f.send({ ...opened, id: "evt_stale_redelivery" })).status).toBe(200);
  expect(await f.entitledOn(member.id)).toBe(true);

  expect((await f.send(dispute("du_2", "needs_response"))).status).toBe(200);
  expect(await f.entitledOn(member.id)).toBe(false);
  expect((await f.send(dispute("du_2", "lost"))).status).toBe(200);
  expect(f.cancels).toEqual([{ subscription: subscription.id }]);
  expect(await f.ended()).toEqual([{ subscription: subscription.id, reason: END_REASONS.refund }]);
  expect(await f.sql(`SELECT "disputeId" FROM dormouse_billing_disputes`)).toEqual([]);
  expect(await member.summary()).toMatchObject({ plan: null, entitled: false, suspended: false });
});

test("the cron rereads open disputes from Stripe, so a missed close event restores once or ends", async ({ onTestFinished }) => {
  const f = await fixture();
  onTestFinished(f.close);
  const resync = () => resyncBilling(f.setup, f.database.url, origin, f.mail);
  const won = await f.account();
  const { session: wonSession } = await f.buy(won, "yearly");
  const lost = await f.account();
  const { session: lostSession, subscription: lostSubscription } = await f.buy(lost, "yearly");
  f.paidInvoices.set("pi_du_lost", lostSubscription.id);
  const open = (id: string, customer: string) => {
    f.disputes.set(id, { status: "needs_response", customer, paymentIntent: `pi_${id}` });
    return f.send(f.event("charge.dispute.created", { id, object: "dispute", charge: `ch_for_${id}` }));
  };
  expect((await open("du_won", wonSession.customer as string)).status).toBe(200);
  expect((await open("du_lost", lostSession.customer as string)).status).toBe(200);
  expect([await f.entitledOn(won.id), await f.entitledOn(lost.id)]).toEqual([false, false]);
  const restored = () => f.email.all().filter((mail) => mail.subject === "Your Dormouse Hosted access is restored");

  // Still open: the cron changes nothing.
  await resync();
  expect([await f.entitledOn(won.id), restored(), f.cancels]).toEqual([false, [], []]);

  // Both close in Stripe, and neither close event arrives.
  f.disputes.get("du_won")!.status = "won";
  f.disputes.get("du_lost")!.status = "lost";
  await resync();
  expect(await f.entitledOn(won.id)).toBe(true);
  expect(restored().map((mail) => mail.to[0])).toEqual([f.dev.customers.get(wonSession.customer as string)!.email]);
  expect(f.cancels).toEqual([{ subscription: lostSubscription.id }]);
  expect(await f.ended()).toEqual([{ subscription: lostSubscription.id, reason: END_REASONS.refund }]);
  expect(await f.sql(`SELECT "disputeId" FROM dormouse_billing_disputes`)).toEqual([]);
  await resync();
  expect([restored().length, f.cancels.length]).toEqual([1, 1]);
});

test("a dispute on a closed account still records, and a lost one still runs its end", async ({ onTestFinished }) => {
  const f = await fixture();
  onTestFinished(f.close);
  const member = await f.account();
  const { session, subscription } = await f.buy(member, "yearly");
  f.paidInvoices.set("pi_du_closed", subscription.id);
  expect((await member.request("/api/account/close", { method: "POST", body: { close: true } })).status).toBe(204);
  await f.deliver();
  const dispute = (status: string) => {
    f.disputes.set("du_closed", { status, customer: session.customer as string, paymentIntent: "pi_du_closed" });
    return f.send(f.event("charge.dispute.updated", { id: "du_closed", object: "dispute", charge: "ch_for_du_closed", status }));
  };
  expect((await dispute("needs_response")).status).toBe(200);
  expect(await f.sql(`SELECT "userId" FROM dormouse_billing_disputes`)).toEqual([{ userId: member.id }]);
  expect((await dispute("lost")).status).toBe(200);
  expect(await f.sql(`SELECT "userId" FROM dormouse_billing_disputes`)).toEqual([]);
  // Closing already ended the subscription; the lost dispute ends nothing more.
  expect(f.cancels).toEqual([{ subscription: subscription.id }]);
  expect(await f.ended()).toEqual([{ subscription: subscription.id, reason: END_REASONS.closure }]);
});

test("a purchase ending otherwise counts as canceled, and one ending within the refund window as refunded", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const kept = await f.account();
  const { subscription: long } = await f.buy(kept, "monthly");
  const quick = await f.account();
  const { subscription: short } = await f.buy(quick, "yearly");
  f.dev.transition(short.id, "cancel");
  await f.deliver();
  f.time.advanceMilliseconds(31 * 24 * 60 * 60 * 1000);
  f.dev.transition(long.id, "cancel");
  await f.deliver();
  const ends = (await f.metrics()).filter((row) => row.startsWith("subscription."));
  expect(ends).toEqual(["subscription.canceled monthly 1", "subscription.refunded yearly 1"]);
});

test("a full refund of a charge for an earlier subscription, or one naming none, ends nothing and is logged", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());
  const member = await f.account();
  const { session, subscription: earlier } = await f.buy(member, "monthly");
  f.dev.transition(earlier.id, "cancel");
  await f.deliver();
  const { subscription: current } = await f.buy(member, "yearly");
  f.paidInvoices.set("pi_earlier", earlier.id);
  f.paidInvoices.set("pi_current", current.id);
  const refund = (paymentIntent: string | null) =>
    f.event("charge.refunded", {
      id: `ch_${paymentIntent}`,
      object: "charge",
      customer: session.customer,
      payment_intent: paymentIntent,
      refunded: true,
    });
  for (const paymentIntent of ["pi_earlier", "pi_unknown", null]) {
    expect((await f.send(refund(paymentIntent))).status, String(paymentIntent)).toBe(200);
    expect(f.cancels, String(paymentIntent)).toEqual([]);
  }
  expect(warn).toHaveBeenCalledTimes(3);
  expect(await f.entitledOn(member.id)).toBe(true);
  // The current subscription's own charge still ends it.
  expect((await f.send(refund("pi_current"))).status).toBe(200);
  expect(f.cancels).toEqual([{ subscription: current.id }]);
  expect(await f.ended()).toEqual([{ subscription: current.id, reason: END_REASONS.refund }]);
});

test("a count that fails rolls back alone and is logged: the webhook still commits and answers 200", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => error.mockRestore());
  await f.sql(`CREATE FUNCTION refuse_metric() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'metric refused'; END $$`);
  await f.sql(`CREATE TRIGGER refuse_metric BEFORE INSERT ON dormouse_metrics_daily
    FOR EACH ROW WHEN (NEW.event = 'checkout.completed') EXECUTE FUNCTION refuse_metric()`);
  const member = await f.account();
  await f.buy(member, "monthly");
  expect(await f.entitledOn(member.id)).toBe(true);
  expect(await f.sql(`SELECT count(*)::int AS n FROM pgstencil_billing.events WHERE processed_at IS NULL`)).toEqual([{ n: 0 }]);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("Metric checkout.completed not recorded"));
  expect((await f.metrics()).filter((row) => row.startsWith("checkout.completed"))).toEqual([]);
});

test("an EEA or UK consumer withdraws online: recorded, acknowledged by email, refunded in full, and ended at once", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const member = await f.account();
  const { session, subscription } = await f.buy(member, "yearly");
  f.countries.set(session.customer as string, "DE");
  // Two payments for the contract, one already refunded by hand.
  f.paidInvoices.set("pi_w0", subscription.id);
  f.refunds.push({ paymentIntent: "pi_w0", withdrawal: null });
  f.paidInvoices.set("pi_w1", subscription.id);
  const billingEmail = f.dev.customers.get(session.customer as string)!.email;

  const offered = await member.summary();
  expect(offered.withdrawal).toEqual({
    subscription: subscription.id,
    startedAt: expect.any(String),
    until: expect.any(String),
    email: billingEmail,
  });
  const { startedAt, until } = offered.withdrawal as { startedAt: string; until: string };
  expect(Date.parse(until) - Date.parse(startedAt)).toBe(WITHDRAWAL_OPEN_DAYS * 24 * 60 * 60 * 1000);

  const withdraw = (subscription: unknown) =>
    member.request("/api/billing/withdraw", { method: "POST", body: { subscription } });
  for (const malformed of ["", "cus_x", 7, null]) expect((await withdraw(malformed)).status, String(malformed)).toBe(400);
  const other = await withdraw("sub_someone_else");
  expect([other.status, await other.json()]).toEqual([409, { message: WITHDRAWAL_CLOSED }]);
  expect(await f.sql(`SELECT id FROM dormouse_withdrawals`)).toEqual([]);

  // Stripe's customer is read once: for the offer, and then its acknowledgement.
  const reads = f.reads.customers;
  const answered = await withdraw(subscription.id);
  expect(answered.status).toBe(200);
  expect(f.reads.customers - reads).toBe(1);
  const [row] = await f.sql<{ id: string; userId: string; plan: string; country: string; submittedAt: Date }>(
    `SELECT id, "userId", plan, country, "submittedAt" FROM dormouse_withdrawals WHERE "subscriptionId" = $1`,
    [subscription.id],
  );
  expect(row).toMatchObject({ userId: member.id, plan: "yearly", country: "DE" });
  expect(await answered.json()).toMatchObject({
    plan: null,
    withdrawal: null,
    withdrawn: { reference: row!.id, subscription: subscription.id, plan: "yearly", acknowledged: true, settled: true },
  });
  expect(f.cancels).toEqual([{ subscription: subscription.id }]);
  expect(await f.ended()).toEqual([{ subscription: subscription.id, reason: END_REASONS.withdrawal }]);
  expect(f.refunds).toEqual([
    { paymentIntent: "pi_w0", withdrawal: null },
    { paymentIntent: "pi_w1", withdrawal: row!.id },
  ]);
  expect(await f.entitledOn(member.id)).toBe(false);
  const [mail] = f.email.all();
  expect(mail!.to).toEqual([billingEmail]);
  for (const fact of [WITHDRAWAL_STATEMENT, row!.id, String(row!.submittedAt.getUTCFullYear())]) expect(mail!.text).toContain(fact);

  // A second submission acknowledges the first again, and repeats nothing.
  await f.deliver();
  expect((await withdraw(subscription.id)).status).toBe(200);
  expect([f.cancels.length, f.refunds.length, f.email.all().length]).toEqual([1, 2, 1]);
  // A plan bought after it is not withdrawn: the acknowledgement gives way to it.
  await f.buy(member, "monthly");
  expect(await member.summary()).toMatchObject({ plan: "monthly", withdrawn: null });
  // A billing record: it outlives the account.
  await f.sql(`DELETE FROM "user" WHERE id = $1`, [member.id]);
  expect(await f.sql(`SELECT id FROM dormouse_withdrawals`)).toEqual([{ id: row!.id }]);
});

test("the online withdrawal is offered within its window, to an EEA, UK, or unknown billing country, and only once", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const abroad = await f.account();
  const { session: abroadSession, subscription: abroadSubscription } = await f.buy(abroad, "monthly");
  f.countries.set(abroadSession.customer as string, "US");
  expect(await abroad.summary()).toMatchObject({ plan: "monthly", withdrawal: null });
  const refused = await abroad.request("/api/billing/withdraw", { method: "POST", body: { subscription: abroadSubscription.id } });
  expect([refused.status, await refused.json()]).toEqual([409, { message: WITHDRAWAL_CLOSED }]);

  const unknown = await f.account();
  const { session, subscription } = await f.buy(unknown, "monthly");
  expect(await unknown.summary()).toMatchObject({ withdrawal: { subscription: subscription.id } });
  // The page reuses Stripe's answer for a while; a withdrawal reads it afresh.
  const reads = f.reads.customers;
  f.countries.set(session.customer as string, "US");
  expect(await unknown.summary()).toMatchObject({ withdrawal: { subscription: subscription.id } });
  expect(f.reads.customers).toBe(reads);
  expect((await unknown.request("/api/billing/withdraw", { method: "POST", body: { subscription: subscription.id } })).status).toBe(409);
  f.countries.delete(session.customer as string);
  // Past the window, it is closed, and the summary stops offering it.
  await f.sql(
    `UPDATE pgstencil_billing.subscriptions SET started_at = now() - ($2::int * interval '1 day') - interval '1 minute' WHERE id = $1`,
    [subscription.id, WITHDRAWAL_OPEN_DAYS],
  );
  expect(await unknown.summary()).toMatchObject({ plan: "monthly", withdrawal: null });
  expect((await unknown.request("/api/billing/withdraw", { method: "POST", body: { subscription: subscription.id } })).status).toBe(409);
  expect(await f.sql(`SELECT id FROM dormouse_withdrawals`)).toEqual([]);
});

test("a withdrawal whose acknowledgement, cancellation, or refund fails still stands, and the cron finishes it", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => error.mockRestore());
  const member = await f.account();
  const { subscription } = await f.buy(member, "founding");
  f.paidInvoices.set("pi_w2", subscription.id);
  f.mailing.failures = 1;
  f.failing.cancels = 1;
  const answered = await member.request("/api/billing/withdraw", { method: "POST", body: { subscription: subscription.id } });
  expect(answered.status).toBe(200);
  // Still held, but never offered again: the withdrawal stands.
  expect(await answered.json()).toMatchObject({
    plan: "founding",
    withdrawal: null,
    withdrawn: { subscription: subscription.id, acknowledged: false, settled: false },
  });
  expect([f.email.all().length, f.cancels.length, f.refunds.length]).toEqual([0, 0, 0]);

  // The failed send's lease runs out before the cron's next pass.
  f.time.advanceMilliseconds(6 * 60 * 1000);
  f.failing.refunds = 1;
  await expect(resyncBilling(f.setup, f.database.url, origin, f.mail)).rejects.toThrow(AggregateError);
  expect(await member.summary()).toMatchObject({ plan: null, withdrawn: { acknowledged: true, settled: false } });
  expect([f.email.all().length, f.cancels.length, f.refunds.length]).toEqual([1, 1, 0]);
  await resyncBilling(f.setup, f.database.url, origin, f.mail);
  expect(await member.summary()).toMatchObject({ withdrawn: { acknowledged: true, settled: true } });
  expect([f.email.all().length, f.cancels.length, f.refunds.length]).toEqual([1, 1, 1]);
  // Finished, the next run does nothing.
  await resyncBilling(f.setup, f.database.url, origin, f.mail);
  expect([f.email.all().length, f.cancels.length, f.refunds.length]).toEqual([1, 1, 1]);
});

test("closing an account needs a recent login, cancels its subscription in Stripe first, and keeps the billing records", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const member = await f.account();
  const { subscription } = await f.buy(member, "monthly");
  await f.sql(`INSERT INTO dormouse_relay_burrows ("burrowId", "userId", "tokenHash") VALUES ($1, $2, $3)`, [
    "b".repeat(22),
    member.id,
    "h".repeat(64),
  ]);
  const close = (body: unknown) => member.request("/api/account/close", { method: "POST", body });

  f.logins.set(member.id, new Date(Date.now() - 60 * 60 * 1000).toISOString());
  const stale = await close({ close: true });
  expect([stale.status, await stale.json()]).toEqual([403, { message: CLOSE_RECENT_LOGIN }]);
  f.logins.delete(member.id);
  for (const body of [{}, { close: "yes" }]) expect((await close(body)).status, JSON.stringify(body)).toBe(400);
  expect(
    (await member.request("/api/account/close", { method: "POST", body: { close: true }, headers: { origin: ORIGINS.relay } })).status,
  ).toBe(403);
  expect(f.cancels).toEqual([]);

  expect((await close({ close: true })).status).toBe(204);
  expect(f.cancels).toEqual([{ subscription: subscription.id }]);
  expect(await f.ended()).toEqual([{ subscription: subscription.id, reason: END_REASONS.closure }]);
  expect(await f.sql(`SELECT status FROM pgstencil_billing.subscriptions WHERE id = $1`, [subscription.id])).toEqual([
    { status: "canceled" },
  ]);
  expect(await f.sql(`SELECT id FROM "user" WHERE id = $1`, [member.id])).toEqual([]);
  expect(await f.sql(`SELECT "userId", "canceledSubscriptions" FROM dormouse_account_closures`)).toEqual([
    { userId: member.id, canceledSubscriptions: [subscription.id] },
  ]);
  expect(await f.sql(`SELECT "userId" FROM dormouse_checkout_consents`)).toEqual([{ userId: member.id }]);
  expect(f.closedBurrows).toEqual(["b".repeat(22)]);

  // An account billing never knew closes with nothing to cancel.
  const plain = await f.account();
  expect((await plain.request("/api/account/close", { method: "POST", body: { close: true } })).status).toBe(204);
  expect(f.cancels).toHaveLength(1);
  // A checkout left open is expired first, so it can never start a subscription for no one.
  const pending = await f.account();
  expect((await pending.request("/api/billing/checkout", { method: "POST", body: consent("monthly") })).status).toBe(200);
  expect((await pending.request("/api/account/close", { method: "POST", body: { close: true } })).status).toBe(204);
  expect([...f.dev.checkouts.values()].at(-1)!.status).toBe("expired");
});

test("closing within the 30-day guarantee refunds that payment in full, once, and the cron finishes a refund that failed", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => error.mockRestore());
  const close = (who: Awaited<ReturnType<typeof f.account>>) =>
    who.request("/api/account/close", { method: "POST", body: { close: true } });
  const settled = (userId: string) =>
    f.sql<{ settled: boolean }>(`SELECT "settledAt" IS NOT NULL AS settled FROM dormouse_account_closures WHERE "userId" = $1`, [
      userId,
    ]).then((rows) => rows[0]?.settled);
  const ago = (days: number) => new Date(f.time.now().getTime() - days * DAY_MS);

  // Nothing canceled, nothing to refund: settled at once.
  const plain = await f.account();
  expect((await close(plain)).status).toBe(204);
  expect(await settled(plain.id)).toBe(true);

  // A founding first payment: refunded, its seat returning to the cohort.
  const founder = await f.account();
  const { subscription: founding } = await f.buy(founder, "founding");
  f.paidInvoices.set("pi_founding", founding.id);
  expect((await close(founder)).status).toBe(204);
  expect(f.refunds).toEqual([{ paymentIntent: "pi_founding", withdrawal: null, closure: founding.id }]);
  expect(await settled(founder.id)).toBe(true);
  await f.deliver();
  await vi.waitFor(async () => expect(await f.metrics()).toContain("subscription.refunded founding 1"));

  // A failed refund stands recorded, and the cron finishes it once.
  const member = await f.account();
  const { subscription: monthly } = await f.buy(member, "monthly");
  f.paidInvoices.set("pi_monthly", monthly.id);
  f.failing.refunds = 1;
  expect((await close(member)).status).toBe(204);
  expect([f.refunds.length, await settled(member.id)]).toEqual([1, false]);
  await resyncBilling(f.setup, f.database.url, origin, f.mail);
  expect(f.refunds.at(-1)).toEqual({ paymentIntent: "pi_monthly", withdrawal: null, closure: monthly.id });
  expect(await settled(member.id)).toBe(true);
  await resyncBilling(f.setup, f.database.url, origin, f.mail);
  expect(f.refunds).toHaveLength(2);

  // Past 30 days: a yearly renewal paid 10 days ago is refunded, its first
  // payment and a monthly renewal never are.
  const yearlyMember = await f.account();
  const { subscription: yearly } = await f.buy(yearlyMember, "yearly");
  const monthlyMember = await f.account();
  const { subscription: lateMonthly } = await f.buy(monthlyMember, "monthly");
  f.time.advanceMilliseconds(400 * DAY_MS);
  f.paidInvoices.set("pi_yearly_first", yearly.id);
  f.paidInvoices.set("pi_yearly_renewal", yearly.id);
  f.invoiceFacts.set("pi_yearly_renewal", { reason: "subscription_cycle", paidAt: ago(10) });
  f.paidInvoices.set("pi_monthly_first", lateMonthly.id);
  f.paidInvoices.set("pi_monthly_renewal", lateMonthly.id);
  f.invoiceFacts.set("pi_monthly_renewal", { reason: "subscription_cycle", paidAt: ago(10) });
  expect((await close(yearlyMember)).status).toBe(204);
  expect((await close(monthlyMember)).status).toBe(204);
  expect(f.refunds.slice(2)).toEqual([{ paymentIntent: "pi_yearly_renewal", withdrawal: null, closure: yearly.id }]);
  expect([await settled(yearlyMember.id), await settled(monthlyMember.id)]).toEqual([true, true]);
});

test("closing answers billing's refusal, such as a checkout still being created, and keeps the account", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const member = await f.account();
  await f.sql(
    `INSERT INTO pgstencil_billing.accounts (owner_id, email, created_at, customer_id) VALUES ($1, 'x@example.test', now(), 'cus_creating')`,
    [member.id],
  );
  await f.sql(
    `INSERT INTO pgstencil_billing.checkouts (id, owner_id, plan, price_id, trial_days, status, created_at, expires_at)
    VALUES ('creating', $1, 'monthly', $2, 0, 'pending', now(), now() + interval '1 hour')`,
    [member.id, f.setup.monthly],
  );
  const refused = await member.request("/api/account/close", { method: "POST", body: { close: true } });
  expect([refused.status, await refused.json()]).toEqual([409, { message: "Checkout is still being created. Retry shortly." }]);
  expect(await f.sql(`SELECT id FROM "user" WHERE id = $1`, [member.id])).toEqual([{ id: member.id }]);
});

test("with billing closed, closing deletes an account without a subscription and refuses one still holding one", async ({
  onTestFinished,
}) => {
  const f = await fixture({ closed: true });
  onTestFinished(f.close);
  const plain = await f.account();
  expect((await plain.request("/api/account/close", { method: "POST", body: { close: true } })).status).toBe(204);
  const held = await f.account();
  await f.sql(`INSERT INTO pgstencil_billing.accounts (owner_id, email, created_at) VALUES ($1, 'x@example.test', now())`, [
    held.id,
  ]);
  await f.sql(
    `INSERT INTO pgstencil_billing.subscriptions (id, owner_id, price_id, status, period_end, cancel_at_period_end, updated_at)
    VALUES ('sub_held', $1, 'price_x', 'active', now() + interval '1 month', false, now())`,
    [held.id],
  );
  const refused = await held.request("/api/account/close", { method: "POST", body: { close: true } });
  expect([refused.status, await refused.json()]).toEqual([409, { message: CLOSE_UNAVAILABLE }]);
  expect(await f.sql(`SELECT id FROM "user" WHERE id = $1`, [held.id])).toEqual([{ id: held.id }]);
});

const DAY_MS = 24 * 60 * 60 * 1000;
/** The schedule the Terms and pricing.md promise: renewal notices 30 days ahead, price changes 21, and never under 7. */
const RENEWAL_NOTICE_DAYS = 30;
const PRICE_NOTICE_DAYS = 21;
const PRICE_NOTICE_MIN_DAYS = 7;

test("a renewal notice and a monthly plan's annual reminder go out once, 30 days ahead, to the billing email", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const resync = () => resyncBilling(f.setup, f.database.url, origin, f.mail);
  // A provider-only account: its billing email is the one Checkout collected.
  const yearly = await f.account(null);
  const { session, subscription } = await f.buy(yearly, "yearly");
  f.dev.customers.get(session.customer as string)!.email = "billing@example.test";
  const monthly = await f.account();
  const { subscription: month } = await f.buy(monthly, "monthly");
  const ending = await f.account();
  const { subscription: ends } = await f.buy(ending, "yearly");
  f.dev.transition(ends.id, "cancel-at-period-end");
  await f.deliver();
  const notices = () =>
    f.sql<{ kind: string; subscriptionId: string; email: string | null }>(
      `SELECT kind, "subscriptionId", email FROM dormouse_billing_notices ORDER BY kind`,
    );

  const renewsAt = new Date(subscription.items.data[0]!.current_period_end * 1000);
  f.time.advanceMilliseconds(renewsAt.getTime() - f.time.now().getTime() - (RENEWAL_NOTICE_DAYS + 1) * DAY_MS);
  await resync();
  expect(await notices()).toEqual([]);
  f.time.advanceMilliseconds(2 * DAY_MS);
  await resync();
  await resync();
  expect(await notices()).toEqual([{ kind: "renewal", subscriptionId: subscription.id, email: "billing@example.test" }]);
  const [renewal] = f.email.all();
  expect(renewal!.to).toEqual(["billing@example.test"]);
  expect(renewal!.subject).toContain(String(renewsAt.getUTCFullYear()));
  for (const fact of ["$100", "Manage billing", `${origin}/billing`, "support@dormouse.sh"]) expect(renewal!.text).toContain(fact);

  // The monthly plan's renewal that ends its first year gets the reminder; no other does.
  await f.sql(`UPDATE pgstencil_billing.subscriptions SET started_at = period_end - interval '11 months' WHERE id = $1`, [month.id]);
  await f.sql(`UPDATE pgstencil_billing.subscriptions SET period_end = $2 WHERE id = $1`, [
    month.id,
    new Date(f.time.now().getTime() + 20 * DAY_MS),
  ]);
  await resync();
  expect(await notices()).toHaveLength(1);
  await f.sql(`UPDATE pgstencil_billing.subscriptions SET started_at = period_end - interval '12 months' WHERE id = $1`, [month.id]);
  await resync();
  expect((await notices()).map((notice) => [notice.kind, notice.subscriptionId])).toEqual([
    ["annual", month.id],
    ["renewal", subscription.id],
  ]);
  expect(f.email.all().at(-1)!.text).toContain("every month at $10");
  expect(f.email.all()).toHaveLength(2);
});

test("a price change applies only from a renewal its notice reached at least 7 days ahead, never to a founding Price", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const resync = () => resyncBilling(f.setup, f.database.url, origin, f.mail);
  const member = await f.account();
  const { subscription } = await f.buy(member, "monthly");
  const founder = await f.account();
  await f.buy(founder, "founding");
  const change = (id: string, plan: string, from: string, to: string, fromUsd: number, toUsd: number) =>
    f.sql(
      `INSERT INTO dormouse_price_changes (id, plan, "fromPriceId", "toPriceId", "fromUsd", "toUsd", "effectiveAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, plan, from, to, fromUsd, toUsd, f.time.now()],
    );
  await change("monthly-12", "monthly", f.setup.monthly, CHANGED_PRICES.monthly, LIST_MONTHLY, CHANGED_USD.monthly);
  const renewsAt = new Date(subscription.items.data[0]!.current_period_end * 1000);
  const notices = () =>
    f.sql<{ kind: string; renewsAt: Date; sentAt: Date | null; appliedAt: Date | null }>(
      `SELECT kind, "renewsAt", "sentAt", "appliedAt" FROM dormouse_billing_notices`,
    );

  // Stripe's Price disagrees with the recorded amount: no notice, no move.
  f.prices.set(CHANGED_PRICES.monthly, { usd: 13, interval: "month" });
  f.time.advanceMilliseconds(renewsAt.getTime() - f.time.now().getTime() - (PRICE_NOTICE_DAYS - 1) * DAY_MS);
  await expect(resync()).rejects.toThrow(AggregateError);
  expect([await notices(), f.email.all(), f.moves]).toEqual([[], [], []]);

  // A notice that went out too late is never acted on, and one not yet sent
  // when its renewal is under 8 days off never goes out.
  const late = await f.account();
  const { subscription: lateSubscription } = await f.buy(late, "monthly");
  const soon = new Date(f.time.now().getTime() + 6 * DAY_MS);
  await f.sql(`UPDATE pgstencil_billing.subscriptions SET period_end = $2 WHERE id = $1`, [lateSubscription.id, soon]);
  await f.sql(
    `INSERT INTO dormouse_billing_notices (id, "userId", kind, "subscriptionId", "renewsAt", "priceChangeId", "createdAt")
    VALUES ('unsent', $1, 'price_change', $2, $3, 'monthly-12', $4)`,
    [late.id, lateSubscription.id, soon, f.time.now()],
  );
  await f.sql(
    `INSERT INTO dormouse_billing_notices (id, "userId", kind, "subscriptionId", "renewsAt", "priceChangeId", "createdAt", email, "sentAt")
    VALUES ('late', $1, 'price_change', $2, $3, 'monthly-12', $4, 'x@example.test', $4)`,
    [member.id, subscription.id, renewsAt, new Date(renewsAt.getTime() - (PRICE_NOTICE_MIN_DAYS - 1) * DAY_MS)],
  );
  f.prices.set(CHANGED_PRICES.monthly, { usd: CHANGED_USD.monthly, interval: "month" });
  await resync();
  expect([f.email.all(), f.moves]).toEqual([[], []]);
  // Stripe never changes a Price's amount: one confirmed is not read again.
  const priceReads = f.reads.prices;
  await f.sql(`DELETE FROM dormouse_billing_notices`);
  await f.sql(`UPDATE pgstencil_billing.subscriptions SET status = 'canceled' WHERE id = $1`, [lateSubscription.id]);

  // In time: noticed 20 days ahead, then moved to the new Price without proration.
  await resync();
  const [notice] = await notices();
  expect(notice).toMatchObject({ kind: "price_change", renewsAt, appliedAt: expect.any(Date) });
  expect(renewsAt.getTime() - notice!.sentAt!.getTime()).toBeGreaterThanOrEqual(PRICE_NOTICE_MIN_DAYS * DAY_MS);
  const [mail] = f.email.all();
  for (const fact of ["from $10 to $12 a month", "Manage billing", `${origin}/billing`]) expect(mail!.text).toContain(fact);
  expect(f.moves).toEqual([{ subscription: subscription.id, price: CHANGED_PRICES.monthly, proration: "none" }]);
  expect(f.reads.prices).toBe(priceReads);
  expect(await member.summary()).toMatchObject({ plan: "monthly", price: CHANGED_USD.monthly, renews: true });
  await resync();
  expect([f.email.all().length, f.moves.length]).toEqual([1, 1]);

  // A change from a founding Price is refused whole, though Stripe agrees
  // with it and the founder's renewal is 15 days off.
  await change("founding-up", "yearly", DEV_FOUNDING_PRICES[0]!, CHANGED_PRICES.yearly, FOUNDING_LADDER[0]!, CHANGED_USD.yearly);
  f.prices.set(DEV_FOUNDING_PRICES[0]!, { usd: FOUNDING_LADDER[0]!, interval: "year" });
  f.time.advanceMilliseconds(340 * DAY_MS);
  const refused = (await resync().catch((error: unknown) => error)) as AggregateError;
  expect(refused.errors.map((error: Error) => error.message)).toEqual([
    "Price change founding-up names a founding Price or another plan's; it is ignored",
  ]);
  expect(await f.sql(`SELECT kind FROM dormouse_billing_notices WHERE kind = 'price_change'`)).toHaveLength(1);
  expect(f.moves).toHaveLength(1);
});

test("a dispute's suspension and restoration are each emailed once to the billing email, and the cron retries a failed send", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => error.mockRestore());
  const member = await f.account();
  const { session, subscription } = await f.buy(member, "yearly");
  f.paidInvoices.set("pi_du_lost", subscription.id);
  const billingEmail = f.dev.customers.get(session.customer as string)!.email;
  const dispute = (id: string, status: string) => {
    f.disputes.set(id, { status, customer: session.customer as string, paymentIntent: `pi_${id}` });
    return f.event("charge.dispute.updated", { id, object: "dispute", charge: `ch_for_${id}`, status });
  };
  const subjects = () => f.email.all().map((mail) => [mail.to[0], mail.subject]);

  const opened = dispute("du_won", "needs_response");
  expect((await f.send(opened)).status).toBe(200);
  expect((await f.send({ ...opened, id: "evt_redelivered" })).status).toBe(200);
  expect((await f.send(dispute("du_won", "under_review"))).status).toBe(200);
  expect(subjects()).toEqual([[billingEmail, "Dormouse Hosted is paused during a payment dispute"]]);
  expect(f.email.all()[0]!.text).toContain("does not limit your right to dispute a charge");

  // Restored only once no other dispute holds the account.
  expect((await f.send(dispute("du_lost", "needs_response"))).status).toBe(200);
  expect((await f.send(dispute("du_won", "won"))).status).toBe(200);
  expect(subjects().map(([, subject]) => subject)).toEqual([
    "Dormouse Hosted is paused during a payment dispute",
    "Dormouse Hosted is paused during a payment dispute",
  ]);
  // Lost, the subscription ends; nothing is restored.
  expect((await f.send(dispute("du_lost", "lost"))).status).toBe(200);
  expect(subjects()).toHaveLength(2);
  expect(await f.sql(`SELECT kind FROM dormouse_billing_notices WHERE "sentAt" IS NULL`)).toEqual([]);

  // A notice whose send fails stands recorded, and the cron sends it while
  // it still holds: a suspension only while its dispute is open.
  const other = await f.account();
  const { session: otherSession } = await f.buy(other, "monthly");
  const unsent = () => f.sql(`SELECT kind FROM dormouse_billing_notices WHERE "sentAt" IS NULL ORDER BY kind`);
  f.disputes.set("du_back", { status: "needs_response", customer: otherSession.customer as string, paymentIntent: "pi_du_back" });
  f.mailing.failures = 2;
  expect((await f.send(f.event("charge.dispute.created", { id: "du_back", object: "dispute", charge: "ch_for_du_back" }))).status).toBe(200);
  f.disputes.set("du_back", { status: "won", customer: otherSession.customer as string, paymentIntent: "pi_du_back" });
  expect((await f.send(f.event("charge.dispute.closed", { id: "du_back", object: "dispute", charge: "ch_for_du_back" }))).status).toBe(200);
  expect([f.mailing.failures, await unsent()]).toEqual([0, [{ kind: "dispute_restored" }, { kind: "dispute_suspended" }]]);
  f.time.advanceMilliseconds(10 * 60 * 1000);
  await resyncBilling(f.setup, f.database.url, origin, f.mail);
  expect(subjects().slice(2)).toEqual([[f.dev.customers.get(otherSession.customer as string)!.email, "Your Dormouse Hosted access is restored"]]);
  expect(await unsent()).toEqual([{ kind: "dispute_suspended" }]);
});

test("one pass reads an account's billing email from Stripe once, however many of its notices it sends", async ({ onTestFinished }) => {
  const f = await fixture();
  onTestFinished(f.close);
  const member = await f.account();
  await f.buy(member, "monthly");
  await f.sql(
    `INSERT INTO dormouse_billing_notices (id, "userId", kind, "disputeId", "createdAt")
    VALUES ('first', $1, 'dispute_restored', 'du_first', $2), ('second', $1, 'dispute_restored', 'du_second', $2)`,
    [member.id, f.time.now()],
  );
  const reads = f.reads.customers;
  await resyncBilling(f.setup, f.database.url, origin, f.mail);
  expect([f.email.all().length, f.reads.customers - reads]).toEqual([2, 1]);
});

test("a notice one pass has leased is never sent by another meanwhile", async ({ onTestFinished }) => {
  const f = await fixture();
  onTestFinished(f.close);
  const member = await f.account();
  await f.buy(member, "monthly");
  await f.sql(
    `INSERT INTO dormouse_billing_notices (id, "userId", kind, "disputeId", "createdAt") VALUES ('once', $1, 'dispute_restored', 'du_once', $2)`,
    [member.id, f.time.now()],
  );
  // The first send runs a whole second pass before it goes out.
  let inner: Promise<void> | null = null;
  const mail = () => ({
    send: async (message: Parameters<ReturnType<typeof f.mail>["send"]>[0]) => {
      await (inner ??= resyncBilling(f.setup, f.database.url, origin, mail));
      await f.mail().send(message);
    },
  });
  await resyncBilling(f.setup, f.database.url, origin, mail);
  expect(f.email.all().length).toBe(1);
});

test("notices that keep failing go to the back, so they never starve a newer one", async ({ onTestFinished }) => {
  const f = await fixture();
  onTestFinished(f.close);
  const resync = () => resyncBilling(f.setup, f.database.url, origin, f.mail).catch((error: unknown) => error);
  // A full pass of notices to accounts Stripe holds no email for, then one it does.
  await f.sql(
    `INSERT INTO dormouse_billing_notices (id, "userId", kind, "disputeId", "createdAt")
    SELECT 'failing-' || n, 'nobody-' || n, 'dispute_restored', 'du_failing_' || n, $1 FROM generate_series(1, 50) n`,
    [new Date(f.time.now().getTime() - DAY_MS)],
  );
  const member = await f.account();
  const { session } = await f.buy(member, "monthly");
  await f.sql(
    `INSERT INTO dormouse_billing_notices (id, "userId", kind, "disputeId", "createdAt") VALUES ('newer', $1, 'dispute_restored', 'du_newer', $2)`,
    [member.id, f.time.now()],
  );
  await resync();
  expect(f.email.all()).toEqual([]);
  f.time.advanceMilliseconds(10 * 60 * 1000);
  await resync();
  expect(f.email.all().map((mail) => mail.to[0])).toEqual([f.dev.customers.get(session.customer as string)!.email]);
});

/** `count` paid founders at founding step `step`, started 40 days ago, straight into the synchronized rows. */
const fillCohort = (f: Awaited<ReturnType<typeof fixture>>, step: number, count: number) =>
  f.sql(
    `WITH owners AS (
      INSERT INTO pgstencil_billing.accounts (owner_id, email, created_at)
      SELECT 'filler-' || $2::int || '-' || n, 'filler@example.test', now() FROM generate_series(1, $1::int) n
      RETURNING owner_id)
    INSERT INTO pgstencil_billing.subscriptions
      (id, owner_id, price_id, status, started_at, period_end, cancel_at_period_end, updated_at)
    SELECT 'sub_' || owner_id, owner_id, $3, 'active', now() - interval '40 days',
      now() + interval '325 days', false, now() FROM owners`,
    [count, step, f.setup.founding[step]],
  );

test("the public founders row shows only opted-in founders still subscribed, with the open cohort's seats, cached a minute", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const cohorts = async () => {
    const response = await f.visit(COHORT_ENDPOINT);
    expect(response.status).toBe(200);
    return response.json();
  };
  const later = () => (f.clock.now += COHORT_CACHE_MS);
  expect(await cohorts()).toEqual({ cohort: 0, seatsLeft: FOUNDING_COHORT_SIZE, founders: { total: 0, shown: [] } });

  const [ada, kim, lee, mo] = [await f.account(), await f.account(), await f.account(), await f.account()];
  for (const who of [ada, kim, lee]) await f.buy(who, "founding");
  await f.buy(mo, "yearly");
  await f.sql(`UPDATE "user" SET image = 'https://avatars.githubusercontent.com/u/1?v=4' WHERE id = $1`, [ada.id]);
  // Kim joins first; Lee never ticks the box.
  expect((await kim.request("/api/billing/founder", { method: "PUT", body: { shown: true, name: "Kim" } })).status).toBe(200);
  expect((await ada.request("/api/billing/founder", { method: "PUT", body: { shown: true, name: "Ada" } })).status).toBe(200);
  // One isolate reuses its answer for a minute.
  expect(await cohorts()).toEqual({ cohort: 0, seatsLeft: FOUNDING_COHORT_SIZE, founders: { total: 0, shown: [] } });
  f.clock.now += COHORT_CACHE_MS - 1;
  expect((await cohorts()).seatsLeft).toBe(FOUNDING_COHORT_SIZE);
  f.clock.now += 1;
  const [{ token }] = await f.sql<{ token: string }>(
    `SELECT encode(sha256(convert_to($1::text, 'UTF8')), 'hex') AS token`,
    [ada.id],
  );
  const shown = await cohorts();
  expect(shown).toEqual({
    cohort: 0,
    seatsLeft: FOUNDING_COHORT_SIZE - 3,
    founders: { total: 3, shown: [{ name: "Kim" }, { name: "Ada", avatar: FOUNDER_AVATAR_PREFIX + token }] },
  });
  // The answer names no account.
  expect(JSON.stringify(shown)).not.toContain(ada.id);

  // A founder whose subscription lapses leaves the row, though their row is
  // kept; past the refund window, they still count.
  await f.sql(
    `UPDATE pgstencil_billing.subscriptions SET status = 'canceled', started_at = now() - interval '40 days', ended_at = now()
    WHERE owner_id = $1`,
    [kim.id],
  );
  later();
  expect((await cohorts()).founders).toEqual({
    total: 3,
    shown: [{ name: "Ada", avatar: FOUNDER_AVATAR_PREFIX + token }],
  });

  // A refund inside the window returns its seat and leaves the total.
  const refunded = await f.account();
  await f.buy(refunded, "founding");
  await f.sql(
    `UPDATE pgstencil_billing.subscriptions SET status = 'canceled', ended_at = started_at + interval '1 day'
    WHERE owner_id = $1`,
    [refunded.id],
  );
  later();
  expect(await cohorts()).toMatchObject({ seatsLeft: FOUNDING_COHORT_SIZE - 3, founders: { total: 3 } });

  // A filled cohort moves the seats to the next; past the last, founding is closed and only the founders remain.
  await fillCohort(f, 0, FOUNDING_COHORT_SIZE - 3);
  later();
  expect(await cohorts()).toMatchObject({ cohort: 1, seatsLeft: FOUNDING_COHORT_SIZE });
  for (let step = 1; step < FOUNDING_LADDER.length; step++) await fillCohort(f, step, FOUNDING_COHORT_SIZE);
  later();
  expect(await cohorts()).toEqual({
    founders: { total: FOUNDING_LADDER.length * FOUNDING_COHORT_SIZE, shown: [{ name: "Ada", avatar: FOUNDER_AVATAR_PREFIX + token }] },
  });
});

test("in a Worker, the request that starts a shared answer keeps it running past its own end", async ({ onTestFinished }) => {
  const f = await fixture();
  onTestFinished(f.close);
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => void waited.push(promise) };
  expect((await f.visit(COHORT_ENDPOINT, ctx)).status).toBe(200);
  expect(waited).toHaveLength(1);
  // Reused from the cache, it starts nothing.
  expect((await f.visit(COHORT_ENDPOINT, ctx)).status).toBe(200);
  expect(waited).toHaveLength(1);
});

test("the public founders row shows at most MAX_SHOWN_FOUNDERS, the earliest first, and counts the rest", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const many = MAX_SHOWN_FOUNDERS + 2;
  await fillCohort(f, 0, many);
  await f.sql(
    `INSERT INTO "user" (id, name, email, "emailVerified")
    SELECT 'filler-0-' || n, 'F' || n, 'filler-' || n || '@example.test', true FROM generate_series(1, $1::int) n`,
    [many],
  );
  await f.sql(
    `INSERT INTO dormouse_founders ("userId", name, "shownSince")
    SELECT 'filler-0-' || n, 'F' || n, now() - make_interval(mins => $1::int - n) FROM generate_series(1, $1::int) n`,
    [many],
  );
  const { founders } = (await (await f.visit(COHORT_ENDPOINT)).json()) as { founders: { total: number; shown: { name: string }[] } };
  expect(founders.total).toBe(many);
  expect(founders.shown.map(({ name }) => name)).toEqual(Array.from({ length: MAX_SHOWN_FOUNDERS }, (_, i) => `F${i + 1}`));
});

test("a shown founder's picture is fetched from the provider's host and served as a checked raster image", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 4, 5]);
  const provider = new Map<string, () => Response>();
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://avatars.githubusercontent.com/") && !url.includes("googleusercontent.com"))
      return realFetch(input, init);
    fetched.push(url);
    expect(init?.redirect).toBe("manual");
    return (provider.get(url) ?? (() => new Response("missing", { status: 404 })))();
  });
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });

  /** A founder shown under `name` whose sign-in picture is `image`; answers their avatar path, if any. */
  const founder = async (name: string, image: string | null) => {
    const who = await f.account();
    await f.buy(who, "founding");
    await f.sql(`UPDATE "user" SET image = $2 WHERE id = $1`, [who.id, image]);
    expect((await who.request("/api/billing/founder", { method: "PUT", body: { shown: true, name } })).status).toBe(200);
    return who;
  };
  const gh = "https://avatars.githubusercontent.com/u/1?v=4";
  provider.set("https://avatars.githubusercontent.com/u/1?v=4&s=96", () => new Response(PNG, { headers: { "content-type": "text/html" } }));
  const big = new Uint8Array(AVATAR_BYTES + 1);
  big.set(PNG);
  provider.set("https://avatars.githubusercontent.com/u/2?s=96", () => new Response(big));
  provider.set("https://avatars.githubusercontent.com/u/3?s=96", () => new Response(new TextEncoder().encode("<svg onload=alert(1)>")));
  provider.set("https://avatars.githubusercontent.com/u/4?s=96", () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
  provider.set("https://avatars.githubusercontent.com/u/6?s=96", () => new Response(PNG, { status: 500 }));
  const pngFounder = await founder("Png", gh);
  await founder("Big", "https://avatars.githubusercontent.com/u/2");
  await founder("Svg", "https://avatars.githubusercontent.com/u/3");
  await founder("Moved", "https://avatars.githubusercontent.com/u/4");
  await founder("Inline", `data:image/jpeg;base64, ${btoa(String.fromCharCode(...JPEG))}`);
  await founder("Failed", "https://avatars.githubusercontent.com/u/6");
  await founder("BigInline", `data:image/png;base64,${Buffer.from(big).toString("base64")}`);
  // Never fetched: not a provider's picture host, not https, or not a raster data URL.
  for (const [name, image] of [
    ["Elsewhere", "https://evil.example/a.png"],
    ["Plain", "http://avatars.githubusercontent.com/u/5"],
    ["Ported", "https://avatars.githubusercontent.com:8443/u/5"],
    ["Vector", `data:image/svg+xml;base64,${btoa("<svg/>")}`],
    ["Code", null],
  ] as const)
    await founder(name, image);

  const { founders } = (await (await f.visit(COHORT_ENDPOINT)).json()) as {
    founders: { shown: { name: string; avatar?: string }[] };
  };
  const avatar = Object.fromEntries(founders.shown.map(({ name, avatar }) => [name, avatar]));
  expect(Object.keys(avatar)).toEqual([
    ...["Png", "Big", "Svg", "Moved", "Inline", "Failed", "BigInline"],
    ...["Elsewhere", "Plain", "Ported", "Vector", "Code"],
  ]);
  for (const name of ["Elsewhere", "Plain", "Ported", "Vector", "Code"]) expect(avatar[name], name).toBeUndefined();

  const png = await f.visit(avatar.Png!);
  expect(png.status).toBe(200);
  expect(png.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await png.arrayBuffer())).toEqual(PNG);
  const inline = await f.visit(avatar.Inline!);
  expect(inline.headers.get("content-type")).toBe("image/jpeg");
  expect(new Uint8Array(await inline.arrayBuffer())).toEqual(JPEG);
  for (const name of ["Big", "Svg", "Moved", "Failed", "BigInline"])
    expect((await f.visit(avatar[name]!)).status, name).toBe(404);
  // Fetched once per answer, however often it is asked for.
  await f.visit(avatar.Png!);
  expect(fetched.filter((url) => url.includes("/u/1")).length).toBe(1);
  expect(fetched.every((url) => url.startsWith("https://avatars.githubusercontent.com/"))).toBe(true);

  // A later answer keeps a picture loaded from the same source, and tries a failed or a changed one again.
  const fetches = (path: string) => fetched.filter((url) => url.includes(path)).length;
  provider.set("https://avatars.githubusercontent.com/u/7?s=96", () => new Response(JPEG));
  await f.sql(`UPDATE "user" SET image = 'https://avatars.githubusercontent.com/u/7' WHERE id = $1`, [pngFounder.id]);
  f.clock.now += COHORT_CACHE_MS;
  await f.visit(COHORT_ENDPOINT);
  expect((await f.visit(avatar.Png!)).headers.get("content-type")).toBe("image/jpeg");
  expect((await f.visit(avatar.Failed!)).status).toBe(404);
  expect((await f.visit(avatar.Inline!)).status).toBe(200);
  expect([fetches("/u/1"), fetches("/u/7"), fetches("/u/6")]).toEqual([1, 1, 2]);
  f.clock.now += COHORT_CACHE_MS;
  await f.visit(COHORT_ENDPOINT);
  expect((await f.visit(avatar.Png!)).status).toBe(200);
  expect(fetches("/u/7")).toBe(1);

  // Only a shown founder's token: a founder who leaves, a made-up token, or a user id is not one.
  for (const path of [FOUNDER_AVATAR_PREFIX + "0".repeat(64), FOUNDER_AVATAR_PREFIX + "x", FOUNDER_AVATAR_PREFIX])
    expect((await f.visit(path)).status, path).toBe(404);
});

test("closed, the public cohort read answers 503 and no picture is served", async ({ onTestFinished }) => {
  const f = await fixture({ closed: true });
  onTestFinished(f.close);
  const response = await f.visit(COHORT_ENDPOINT);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ message: CHECKOUT_CLOSED });
  expect((await f.visit(FOUNDER_AVATAR_PREFIX + "0".repeat(64))).status).toBe(404);
});
