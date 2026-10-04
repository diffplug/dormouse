import { test, expect } from "vitest";
import { Hono } from "hono";
import { fileURLToPath } from "node:url";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { createTestContext } from "pgstencil/testing";
import { queryDatabase } from "pgstencil/postgres";
import { API_ROUTES, NOT_ENTITLED_ERROR } from "remote-lib-common";
import { FOUNDING_COHORT_SIZE, FOUNDING_LADDER } from "../../../website/src/lib/hosted-pricing";
import { SITE_ORIGIN } from "../account-app";
import { COHORT_ENDPOINT } from "../../../website/src/lib/hosted-cohorts";
import { billingSetup, openCohort } from "../billing";
import {
  BILLING_WEBHOOK_PATH,
  CHECKOUT_CLOSED,
  COHORT_CACHE_MS,
  billingRoutes,
} from "../billing-routes";
import { DEV_FOUNDING_PRICES, stripeDevBilling } from "../billing-dev";
import { migrations } from "../migrations";
import {
  ORIGINS,
  TEST_ENROLL_SECRET,
  bundleWorker,
  miniflareOptions,
  together,
  wrangler,
} from "./bundle";
import { workerDatabases } from "./worker-roles";

// Checkout, the webhook, and the subscription as the entitlement, end to end:
// the account, relay, and voice Workers in workerd on their own roles, and
// StripeDev answering for api.stripe.com.

const origin = ORIGINS.account;
const LADDER = DEV_FOUNDING_PRICES;
const accountBundle = bundleWorker("server/tests/worker-entry.ts", [
  fileURLToPath(import.meta.resolve("@pgstencil/auth/better-auth-testing")),
]);
const relayBundle = bundleWorker("server/relay-worker.ts");
const voiceBundle = bundleWorker("server/tests/voice-entry.ts");

async function fixture({ billing = true } = {}) {
  // The entitlement reads the database's clock, so the test clock starts at it.
  const context = await createTestContext({ migrations, now: new Date().toISOString() });
  const databases = await workerDatabases(context.database.url);
  const { dev, setup } = await stripeDevBilling(context.time, context.random);
  const outboundService = async (request: Request) => {
    const url = new URL(request.url);
    if (url.href === "https://api.postmarkapp.com/email") {
      const mail = (await request.json()) as { To: string; From: string; Subject: string; HtmlBody: string; TextBody: string };
      await context.email.send({ to: [mail.To], from: mail.From, subject: mail.Subject, html: mail.HtmlBody, text: mail.TextBody });
      return WorkerResponse.json({ ErrorCode: 0 });
    }
    if (url.origin === "https://api.elevenlabs.io")
      return url.pathname.startsWith("/v1/history")
        ? WorkerResponse.json({ history: [] })
        : new WorkerResponse(new Uint8Array([0xff, 0xfb]), { headers: { "content-type": "audio/mpeg" } });
    if (url.origin !== "https://api.stripe.com") throw new Error(`Unexpected outbound host: ${url.hostname}`);
    const response = await fetch(dev.origin + url.pathname + url.search, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      ...(request.method === "POST" ? { body: await request.text() } : {}),
    });
    return new WorkerResponse(await response.arrayBuffer(), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
  const stripe = billing
    ? {
        STRIPE_SECRET_KEY: setup.secretKey,
        STRIPE_WEBHOOK_SECRET: setup.webhookSecret,
        STRIPE_PRICE_MONTHLY: setup.monthly,
        STRIPE_PRICE_YEARLY: setup.yearly,
        STRIPE_PRICES_FOUNDING: setup.founding.join(","),
      }
    : {};
  const worker = new Miniflare(
    together(
      miniflareOptions("account", (await accountBundle).outputFiles[0].text, {
        bindings: {
          APP_ORIGIN: origin,
          AUTH_SECRET: "dormouse-test-secret-with-at-least-32-characters",
          EMAIL_FROM: "signin@example.test",
          POSTMARK_SERVER_TOKEN: "test-token",
          ...stripe,
        },
        hyperdrives: { HYPERDRIVE: databases.account },
        serviceBindings: { ASSETS: () => new WorkerResponse("<!doctype html>", { headers: { "content-type": "text/html" } }) },
        outboundService,
      }),
      miniflareOptions("relay", (await relayBundle).outputFiles[0].text, {
        bindings: { APP_ORIGIN: ORIGINS.relay, ACCOUNT_ORIGIN: origin, RELAY_ENROLL_SECRET: TEST_ENROLL_SECRET },
        hyperdrives: { HYPERDRIVE: databases.relay },
        serviceBindings: { ASSETS: () => new WorkerResponse("<!doctype html>") },
        outboundService,
        routes: [`${new URL(ORIGINS.relay).host}/*`],
      }),
      miniflareOptions("voice", (await voiceBundle).outputFiles[0].text, {
        bindings: { APP_ORIGIN: ORIGINS.voice, ELEVENLABS_API_KEY: "test-elevenlabs-key" },
        hyperdrives: { HYPERDRIVE: databases.voice },
        outboundService,
        routes: [`${new URL(ORIGINS.voice).host}/*`],
      }),
    ),
  );
  await worker.ready;
  const call = (url: string, init: RequestInit = {}) =>
    worker.dispatchFetch(url, { redirect: "manual", ...init } as never);
  const now = () => call(origin + "/__test/time", { method: "POST", body: context.time.now().toISOString() });
  await now();

  /** Delivers every pending StripeDev event, signed, to the webhook. */
  const deliver = async () => {
    while (dev.events.length) {
      const { body, signature } = dev.signed(dev.events[0]!);
      const response = await call(origin + BILLING_WEBHOOK_PATH, {
        method: "POST",
        headers: { "stripe-signature": signature, "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(200);
      await response.text();
      dev.events.shift();
    }
  };

  /** A browser on the account origin with its own cookie jar. */
  function browser() {
    const jar = new Map<string, string>();
    let csrf = "";
    const request = async (
      path: string,
      init: { method?: string; body?: unknown; origin?: string | null; headers?: Record<string, string> } = {},
    ) => {
      const response = await call(new URL(path, origin).href, {
        method: init.method ?? "GET",
        headers: {
          cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
          "cf-connecting-ip": "203.0.113.10",
          "content-type": "application/json",
          ...(init.origin !== null && { origin: init.origin ?? origin }),
          ...init.headers,
        },
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0]!;
        jar.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
      }
      return response;
    };
    const auth = async (path: string, body: unknown) => {
      csrf ||= ((await (await request("/api/auth/csrf")).json()) as { csrf: string }).csrf;
      return request("/api/auth/" + path, { method: "POST", body, headers: { "x-csrf-token": csrf } });
    };
    const signIn = async (address: string) => {
      expect((await auth("email-otp/send-verification-otp", { email: address, type: "sign-in" })).status).toBe(200);
      const message = await context.email.next();
      expect((await auth("sign-in/email-otp", { email: address, otp: message.text.match(/\b\d{8}\b/)![0] })).status).toBe(200);
      return ((await (await request("/api/auth/get-session")).json()) as { user: { id: string } }).user.id;
    };
    /** Starts checkout for `plan`, completes it in StripeDev, and delivers its events. */
    const buy = async (plan: string) => {
      const started = await request("/api/billing/checkout", { method: "POST", body: { plan } });
      expect(started.status).toBe(200);
      const { url } = (await started.json()) as { url: string };
      const session = [...dev.checkouts.values()].find((s) => s.url === url)!;
      const subscription = dev.completeCheckout(session.id);
      await deliver();
      return { session, subscription };
    };
    const summary = async () => (await (await request("/api/billing")).json()) as Record<string, any>;
    return { request, signIn, buy, summary };
  }

  const burrowCall = async (path: string, body?: unknown, bearer?: string) => {
    const response = await call(ORIGINS.relay + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer && { authorization: `Bearer ${bearer}` }) },
      body: JSON.stringify(body ?? {}),
    });
    return { status: response.status, json: (await response.json()) as Record<string, any> };
  };
  const speak = (token: string) =>
    call(ORIGINS.voice + "/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: "Build finished", voiceId: "abc" }),
    });
  /** The account Worker's Cron Trigger, run now. */
  const scheduled = async () => {
    const fetcher = (await worker.getWorker(wrangler.account.name)) as unknown as {
      scheduled(options: { cron: string }): Promise<{ outcome: string }>;
    };
    return fetcher.scheduled({ cron: "30 * * * *" });
  };
  return {
    ...context,
    dev,
    call,
    now,
    deliver,
    browser,
    burrowCall,
    speak,
    scheduled,
    close: async () => {
      await worker.dispose();
      await dev.close();
      await context.close();
    },
  };
}

test("the open cohort is the highest step bought at, and a refund never reopens a lower one", () => {
  const full = FOUNDING_COHORT_SIZE;
  const steps = FOUNDING_LADDER.length;
  const zeros = Array<number>(steps).fill(0);
  expect(openCohort(zeros)).toEqual({ cohort: 0, seatsLeft: full });
  expect(openCohort([3, ...zeros.slice(1)])).toEqual({ cohort: 0, seatsLeft: full - 3 });
  expect(openCohort([full, ...zeros.slice(1)])).toEqual({ cohort: 1, seatsLeft: full });
  // Concurrent checkouts may oversell a cohort; the next still opens at a full count.
  expect(openCohort([full + 4, 0, ...zeros.slice(2)])).toEqual({ cohort: 1, seatsLeft: full });
  // A refund in a closed cohort returns its seat there, and the price stays up.
  expect(openCohort([full - 1, 2, ...zeros.slice(2)])).toEqual({ cohort: 1, seatsLeft: full - 2 });
  expect(openCohort(Array<number>(steps).fill(full))).toBeNull();
});

test("billing is off without every Stripe binding, and refuses a ladder the page does not publish", () => {
  const env = {
    STRIPE_SECRET_KEY: "sk_live_x",
    STRIPE_WEBHOOK_SECRET: "whsec_x",
    STRIPE_PRICE_MONTHLY: "price_m",
    STRIPE_PRICE_YEARLY: "price_y",
    STRIPE_PRICES_FOUNDING: LADDER.join(","),
  };
  expect(billingSetup(env)).toMatchObject({ live: true, founding: LADDER });
  for (const name of Object.keys(env))
    expect(billingSetup({ ...env, [name]: undefined }), name).toBeNull();
  expect(billingSetup({ ...env, STRIPE_SECRET_KEY: "sk_test_x" })?.live).toBe(false);
  expect(() => billingSetup({ ...env, STRIPE_PRICES_FOUNDING: LADDER.slice(1).join(",") })).toThrow(
    /published ladder/,
  );
  expect(() => billingSetup({ ...env, STRIPE_PRICE_YEARLY: "price_m" })).toThrow(/distinct/);
});

test("checkout to webhook to entitlement: voice and the Relay admit a member, and refuse once the subscription ends", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const member = f.browser();
  // Signed out: no plan, no checkout.
  expect((await member.request("/api/billing")).status).toBe(401);
  expect((await member.request("/api/billing/checkout", { method: "POST", body: { plan: "monthly" } })).status).toBe(401);
  const userId = await member.signIn("member@example.test");
  expect(await member.summary()).toMatchObject({ plan: null, entitled: false, founder: null });
  expect((await member.request("/api/voice/tokens", { method: "POST" })).status).toBe(403);

  // The browser names a plan, never a Price.
  for (const plan of ["price_dev_monthly", "annual", "", 7])
    expect((await member.request("/api/billing/checkout", { method: "POST", body: { plan } })).status, String(plan)).toBe(400);
  const { session, subscription } = await member.buy("monthly");
  const sent = f.dev.requests.find((r) => r.path === "/v1/checkout/sessions")!.body;
  expect(sent).toMatchObject({
    "line_items[0][price]": "price_dev_monthly",
    "managed_payments[enabled]": "true",
    success_url: expect.stringMatching(new RegExp(`^${origin}/billing\\?checkout=`)),
  });
  // No trial: the first payment is taken at checkout.
  expect(sent["subscription_data[trial_period_days]"]).toBeUndefined();

  // The return page confirms the operation it names.
  const confirmed = await member.request("/api/billing/confirm", {
    method: "POST",
    body: { checkout: session.metadata!.pgstencil_operation },
  });
  expect(confirmed.status).toBe(200);
  expect(await confirmed.json()).toMatchObject({ plan: "monthly", entitled: true, renews: true });
  expect((await member.request("/api/billing/confirm", { method: "POST", body: { checkout: "unknown" } })).status).toBe(404);

  // Voice: mint and speak.
  const minted = await member.request("/api/voice/tokens", { method: "POST" });
  expect(minted.status).toBe(201);
  const { token } = (await minted.json()) as { token: string };
  expect((await f.speak(token)).status).toBe(200);

  // The Relay: approve a device code, and the Burrow enrolls and mints a setup token.
  const begun = (await f.burrowCall(API_ROUTES.burrowEnrollBegin, { origin: ORIGINS.relay })).json;
  expect((await member.request("/api/relay/enrollments/approve", { method: "POST", body: { userCode: begun.userCode } })).status).toBe(204);
  const enrolled = await f.burrowCall(API_ROUTES.burrowEnrollPoll, { deviceCode: begun.deviceCode });
  expect(enrolled.json.status).toBe("enrolled");
  const { burrowToken } = enrolled.json.enrollment;
  expect((await f.burrowCall(API_ROUTES.burrowSetupToken, undefined, burrowToken)).status).toBe(200);

  // A failed renewal refuses at once: no grace past what the subscription grants.
  f.dev.transition(subscription.id, "payment-failed");
  await f.deliver();
  expect((await f.speak(token)).status).toBe(403);
  f.dev.transition(subscription.id, "renew");
  await f.deliver();
  expect((await f.speak(token)).status).toBe(200);

  // A refund cancels at once: voice, the Relay, and the account's routes refuse.
  f.dev.transition(subscription.id, "cancel");
  await f.deliver();
  expect((await f.speak(token)).status).toBe(403);
  expect(await f.burrowCall(API_ROUTES.burrowSetupToken, undefined, burrowToken)).toEqual({
    status: 403,
    json: { error: NOT_ENTITLED_ERROR },
  });
  expect((await member.request("/api/voice/tokens", { method: "POST" })).status).toBe(403);
  expect(await member.summary()).toMatchObject({ plan: null, entitled: false });
  expect(
    await queryDatabase(f.database.url, `SELECT owner_id, status FROM pgstencil_billing.subscriptions`),
  ).toEqual([{ owner_id: userId, status: "canceled" }]);
});

test("a missed renewal webhook is repaired by the hourly resync before the member is refused", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const member = f.browser();
  await member.signIn("renewing@example.test");
  const { subscription } = await member.buy("yearly");
  const token = ((await (await member.request("/api/voice/tokens", { method: "POST" })).json()) as { token: string }).token;
  // Stripe renewed, but the webhook never arrived; the stored period has ended.
  f.dev.transition(subscription.id, "renew");
  f.dev.events.length = 0;
  await queryDatabase(f.database.url, `UPDATE pgstencil_billing.subscriptions SET period_end = now() - interval '1 minute'`);
  expect((await f.speak(token)).status).toBe(403);
  expect((await f.scheduled()).outcome).toBe("ok");
  expect((await f.speak(token)).status).toBe(200);
});

test("founding: the open cohort's Price at checkout, its seats and opted-in founders on the site origin, and refunds returning seats", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const cohorts = async (at = SITE_ORIGIN) => {
    const response = await f.call(at + COHORT_ENDPOINT);
    expect(response.status).toBe(200);
    return response.json();
  };
  /** Moves both clocks past the cohort cache. */
  const later = () => {
    f.time.advanceMilliseconds(COHORT_CACHE_MS + 1);
    return f.now();
  };
  expect(await cohorts()).toEqual({ cohort: 0, seatsLeft: FOUNDING_COHORT_SIZE, founders: { total: 0, shown: [] } });
  // Only the cohort path answers on the site origin.
  for (const path of ["/api/billing", "/api/auth/csrf", "/api/hosted/other", "/"])
    expect((await f.call(SITE_ORIGIN + path)).status, path).toBe(421);
  expect((await f.call(SITE_ORIGIN + COHORT_ENDPOINT, { method: "POST" })).status).toBe(421);

  const ada = f.browser();
  await ada.signIn("ada@example.test");
  // Only a founder joins the row.
  expect((await ada.request("/api/billing/founder", { method: "PUT", body: { shown: true, name: "Ada" } })).status).toBe(409);
  await ada.buy("founding");
  for (const name of ["", " ", "x".repeat(65), "Ada\u0000"])
    expect((await ada.request("/api/billing/founder", { method: "PUT", body: { shown: true, name } })).status, name).toBe(400);
  expect((await ada.request("/api/billing/founder", { method: "PUT", body: { shown: true, name: " Ada L. " } })).status).toBe(204);
  expect(await ada.summary()).toMatchObject({ plan: "founding", founder: "Ada L." });

  const bob = f.browser();
  await bob.signIn("bob@example.test");
  const { subscription: bobs } = await bob.buy("founding");
  // Within the cache, the answer is the one already served.
  expect(await cohorts()).toEqual({ cohort: 0, seatsLeft: FOUNDING_COHORT_SIZE, founders: { total: 0, shown: [] } });
  await later();
  expect(await cohorts(origin)).toEqual({
    cohort: 0,
    seatsLeft: FOUNDING_COHORT_SIZE - 2,
    founders: { total: 2, shown: [{ name: "Ada L." }] },
  });
  // A refund, which cancels at once, returns Bob's seat.
  f.dev.transition(bobs.id, "cancel");
  await f.deliver();
  await later();
  expect(await cohorts()).toMatchObject({ seatsLeft: FOUNDING_COHORT_SIZE - 1, founders: { total: 1 } });
  // Withdrawing leaves the row; the purchase still counts.
  expect((await ada.request("/api/billing/founder", { method: "PUT", body: { shown: false } })).status).toBe(204);
  await later();
  expect(await cohorts()).toMatchObject({ founders: { total: 1, shown: [] } });

  // The first cohort sells out: checkout offers the next step's Price.
  await queryDatabase(
    f.database.url,
    `WITH owners AS (
      INSERT INTO pgstencil_billing.accounts (owner_id, email, created_at)
      SELECT 'filler-' || n, 'filler-' || n || '@example.test', now() FROM generate_series(1, $1::int) n
      RETURNING owner_id)
    INSERT INTO pgstencil_billing.subscriptions
      (id, owner_id, price_id, status, started_at, period_end, cancel_at_period_end, updated_at)
    SELECT 'sub_' || owner_id, owner_id, $2, 'active', now(), now() + interval '1 year', false, now() FROM owners`,
    [FOUNDING_COHORT_SIZE - 1, LADDER[0]],
  );
  await later();
  expect(await cohorts()).toMatchObject({ cohort: 1, seatsLeft: FOUNDING_COHORT_SIZE });
  const carol = f.browser();
  await carol.signIn("carol@example.test");
  await carol.buy("founding");
  expect(
    f.dev.requests.filter((r) => r.path === "/v1/checkout/sessions").map((r) => r.body["line_items[0][price]"]),
  ).toEqual([LADDER[0], LADDER[0], LADDER[1]]);
  expect(await carol.summary()).toMatchObject({ plan: "founding", founding: { cohort: 1, seatsLeft: FOUNDING_COHORT_SIZE - 1 } });
});

test("the webhook takes only Stripe's signed body; checkout takes only this origin; billing off answers 503", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const webhook = (headers: Record<string, string>, body: string) =>
    f.call(origin + BILLING_WEBHOOK_PATH, { method: "POST", headers, body });
  const member = f.browser();
  await member.signIn("signed@example.test");
  await member.request("/api/billing/checkout", { method: "POST", body: { plan: "monthly" } });
  const session = [...f.dev.checkouts.values()][0]!;
  f.dev.completeCheckout(session.id);
  const event = f.dev.events[0]!;
  const { body, signature } = f.dev.signed(event);
  expect((await webhook({}, body)).status).toBe(400);
  expect((await webhook({ "stripe-signature": signature }, body.replace(event.id, "evt_forged"))).status).toBe(400);
  expect((await webhook({ "stripe-signature": "t=1,v1=00" }, body)).status).toBe(400);
  expect((await webhook({ "stripe-signature": signature }, "x".repeat(1024 * 1024 + 1))).status).toBe(413);
  expect(await queryDatabase(f.database.url, `SELECT id FROM pgstencil_billing.events`)).toEqual([]);
  await f.deliver();
  expect(await member.summary()).toMatchObject({ plan: "monthly" });

  // Checkout, the portal, and the founders row: this origin only, and a state change must say so.
  const other = f.browser();
  await other.signIn("other@example.test");
  for (const from of [null, ORIGINS.relay, ORIGINS.voice, SITE_ORIGIN])
    for (const [method, path] of [
      ["POST", "/api/billing/checkout"],
      ["POST", "/api/billing/portal"],
      ["PUT", "/api/billing/founder"],
      ["PUT", "/api/billing/survey"],
    ])
      expect((await other.request(path, { method, body: { plan: "monthly" }, origin: from })).status, `${from} ${path}`).toBe(403);
  const portal = await member.request("/api/billing/portal", { method: "POST" });
  expect(portal.status).toBe(200);
  expect(((await portal.json()) as { url: string }).url).toBe(`${f.dev.origin}/portal/${session.customer}`);
  // An existing subscription is managed in the portal, never bought twice.
  expect((await member.request("/api/billing/checkout", { method: "POST", body: { plan: "yearly" } })).status).toBe(409);

  // The survey: optional answers in whole dollars, one set per account.
  for (const answers of [{}, { bargain: -1 }, { bargain: 1.5 }, { bargain: "50" }])
    expect((await member.request("/api/billing/survey", { method: "PUT", body: answers })).status).toBe(400);
  expect((await member.request("/api/billing/survey", { method: "PUT", body: { tooCheap: 20, bargain: 60 } })).status).toBe(204);
  expect((await member.request("/api/billing/survey", { method: "PUT", body: { tooExpensive: 200 } })).status).toBe(204);
  expect(
    await queryDatabase(f.database.url, `SELECT "tooExpensive", "tooCheap", expensive, bargain FROM dormouse_price_survey`),
  ).toEqual([{ tooExpensive: 200, tooCheap: null, expensive: null, bargain: null }]);

  const off = await fixture({ billing: false });
  onTestFinished(off.close);
  const visitor = off.browser();
  await visitor.signIn("visitor@example.test");
  for (const [method, path] of [
    ["GET", "/api/billing"],
    ["POST", "/api/billing/checkout"],
  ]) {
    const response = await visitor.request(path, { method, ...(method === "POST" && { body: { plan: "monthly" } }) });
    expect([path, response.status, await response.json()]).toEqual([path, 503, { message: CHECKOUT_CLOSED }]);
  }
  expect((await off.call(SITE_ORIGIN + COHORT_ENDPOINT)).status).toBe(503);
  expect((await off.scheduled()).outcome).toBe("ok");
});

test("an account without a public email checks out, and Stripe Checkout collects one", async ({ onTestFinished }) => {
  const context = await createTestContext({ migrations });
  const { dev, setup } = await stripeDevBilling(context.time, context.random);
  onTestFinished(async () => {
    await dev.close();
    await context.close();
  });
  // The routes in Node on StripeDev's client, for a login whose email is null.
  const app = new Hono();
  billingRoutes(app, () => ({
    databaseUrl: context.database.url,
    auth: async () => Response.json({ user: { id: "provider-only", email: null }, session: {} }),
    setup: () => setup,
  }));
  const response = await app.request(`${origin}/api/billing/checkout`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ plan: "yearly" }),
  });
  expect(response.status).toBe(200);
  // No email is sent, so Stripe's hosted page asks the buyer for one.
  expect(dev.requests.find((r) => r.path === "/v1/customers")!.body).toEqual({
    "metadata[pgstencil_owner]": "provider-only",
  });
});
