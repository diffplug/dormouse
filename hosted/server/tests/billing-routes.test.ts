import { test, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { createTestContext } from "pgstencil/testing";
import { queryDatabase } from "pgstencil/postgres";
import { FOUNDING_COHORT_SIZE } from "../../../website/src/lib/hosted-pricing";
import type { BillingSetup } from "../billing";
import {
  BILLING_WEBHOOK_PATH,
  CHECKOUT_CLOSED,
  ENDED_FOR_REFUND,
  WEBHOOK_BODY_BYTES,
  billingRoutes,
  disputeAction,
} from "../billing-routes";
import { entitledSql } from "../entitlement";
import { migrations } from "../migrations";
import { ORIGINS } from "./bundle";
import { stripeFake } from "./stripe-fake";
import { workerDatabases } from "./worker-roles";

// The billing routes in Node, on real Postgres and the Stripe fake: what a
// signed-in account may ask, what Stripe's webhook does, and what each counts.

const origin = ORIGINS.account;

async function fixture({ closed = false } = {}) {
  const context = await createTestContext({ migrations, now: new Date().toISOString() });
  const databases = await workerDatabases(context.database.url);
  const stripe = await stripeFake(context.time, context.random);
  const sql = <Row extends Record<string, unknown>>(text: string, values?: unknown[]) =>
    queryDatabase<Row>(context.database.url, text, values);
  /** user id → its session's user, as `get-session` answers it. */
  const users = new Map<string, { id: string; email: string | null; emailVerified: boolean }>();
  const app = new Hono();
  billingRoutes(app, () => ({
    databaseUrl: context.database.url,
    auth: async (request) => {
      const id = /(?:^|; )u=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
      const user = id && users.get(id);
      return Response.json(user ? { user, session: { createdAt: new Date().toISOString() } } : null);
    },
    setup: (): BillingSetup | null => (closed ? null : stripe.setup),
  }));
  // The account Worker's `onError`.
  app.onError((_error, c) => c.json({ message: "unavailable" }, 503));

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
      ...(method === "POST" && { body: "{}" }),
    });
  /** Starts `plan` for `who` and completes it in StripeDev, delivering its events. */
  const buy = async (who: Awaited<ReturnType<typeof account>>, plan: string, ref?: string) => {
    const started = await who.request("/api/billing/checkout", { method: "POST", body: { plan, ref } });
    expect(started.status, await started.clone().text()).toBe(200);
    const { url } = (await started.json()) as { url: string };
    const session = [...stripe.dev.checkouts.values()].find((s) => s.url === url)!;
    const subscription = stripe.dev.completeCheckout(session.id);
    await deliver();
    return { session, subscription };
  };
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
    entitledOn,
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

test("closed, every billing route answers 503 to a signed-in account, after the login gate", async ({ onTestFinished }) => {
  const f = await fixture({ closed: true });
  onTestFinished(f.close);
  const member = await f.account();
  for (const [method, path, body] of [
    ["GET", "/api/billing"],
    ["POST", "/api/billing/checkout", { plan: "monthly" }],
    ["POST", "/api/billing/confirm", { checkout: "op_x" }],
    ["POST", "/api/billing/portal"],
  ] as const) {
    const response = await member.request(path, { method, body });
    expect([path, response.status, await response.json()]).toEqual([path, 503, { message: CHECKOUT_CLOSED }]);
    expect((await f.anonymous(path, method)).status, path).toBe(401);
  }
  const { body, signature } = f.dev.signed(f.event("customer.updated", { id: "cus_x" }));
  expect((await f.webhook(body, signature)).status).toBe(503);
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
      plan: "monthly",
      ref: "settings-voice",
      price: "price_x",
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
    active: true,
    until: expect.any(String),
    renews: true,
    entitled: true,
    suspended: false,
    founding: { cohort: 0, seatsLeft: FOUNDING_COHORT_SIZE - 1 },
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
  expect((await member.request("/api/billing/checkout", { method: "POST", body: { plan: "yearly" } })).status).toBe(409);

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
  expect((await unverified.request("/api/billing/checkout", { method: "POST", body: { plan: "monthly" } })).status).toBe(200);
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
    f.event("charge.dispute.created", { id: "du_unknown", object: "dispute" }),
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
  expect(f.cancels).toEqual([{ subscription: subscription.id, comment: ENDED_FOR_REFUND }]);
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
  expect(f.cancels).toEqual([{ subscription: subscription.id, comment: ENDED_FOR_REFUND }]);
  expect(await f.sql(`SELECT "disputeId" FROM dormouse_billing_disputes`)).toEqual([]);
  expect(await member.summary()).toMatchObject({ plan: null, entitled: false, suspended: false });
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
  expect(f.cancels).toEqual([{ subscription: current.id, comment: ENDED_FOR_REFUND }]);
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
