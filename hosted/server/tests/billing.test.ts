import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { BillingError } from "@pgstencil/stripe";
import { createTestContext } from "pgstencil/testing";
import { queryDatabase } from "pgstencil/postgres";
import { FOUNDING_COHORT_SIZE, FOUNDING_LADDER } from "../../../website/src/lib/hosted-pricing";
import { billingSetup, openCohort, resyncBilling, withBilling } from "../billing";
import type { Plan } from "../policy-constants";
import { DEV_FOUNDING_PRICES, stripeDevBilling } from "../billing-dev";
import { ADMIN_EMAIL, entitled, entitledSql } from "../entitlement";
import { migrations } from "../migrations";
import { ORIGINS, bundleWorker, miniflareOptions, alone } from "./bundle";
import { workerDatabases } from "./worker-roles";

// Billing's core: the setup from bindings, the founding cohort, the
// subscription as the entitlement on every Worker's role, and the resync,
// against StripeDev on real Postgres.

const origin = ORIGINS.account;
const LADDER = DEV_FOUNDING_PRICES;
/** No withdrawal in these tests asks for mail. */
const noMail = () => {
  throw new Error("No mail in this test");
};
const zeros = () => Array<number>(FOUNDING_LADDER.length).fill(0);

test("billing is closed without every Stripe binding, and refuses a ladder the page does not publish", () => {
  const env = {
    STRIPE_SECRET_KEY: "sk_live_x",
    STRIPE_WEBHOOK_SECRET: "whsec_x",
    STRIPE_PRICE_MONTHLY: "price_m",
    STRIPE_PRICE_YEARLY: "price_y",
    STRIPE_PRICES_FOUNDING: LADDER.join(", "),
  };
  expect(billingSetup(env)).toEqual({
    secretKey: "sk_live_x",
    webhookSecret: "whsec_x",
    live: true,
    monthly: "price_m",
    yearly: "price_y",
    founding: LADDER,
  });
  for (const name of Object.keys(env)) {
    expect(billingSetup({ ...env, [name]: undefined }), name).toBeNull();
    expect(billingSetup({ ...env, [name]: "" }), name).toBeNull();
  }
  expect(billingSetup({ ...env, STRIPE_SECRET_KEY: "rk_live_x" })?.live).toBe(true);
  expect(billingSetup({ ...env, STRIPE_SECRET_KEY: "sk_test_x" })?.live).toBe(false);
  expect(() => billingSetup({ ...env, STRIPE_PRICES_FOUNDING: LADDER.slice(1).join(",") })).toThrow(
    /published ladder/,
  );
  expect(() => billingSetup({ ...env, STRIPE_PRICE_YEARLY: "price_m" })).toThrow(/distinct/);
  expect(() => billingSetup({ ...env, STRIPE_PRICE_MONTHLY: "prod_m" })).toThrow(/distinct/);
  expect(() => billingSetup({ ...env, STRIPE_PRICE_MONTHLY: "price_m'" })).toThrow(/distinct/);
});

test("the open cohort is the last one bought at until its net count fills: a refund there returns a seat, one before never reopens", () => {
  const full = FOUNDING_COHORT_SIZE;
  const counts = (...head: number[]) => [...head, ...zeros().slice(head.length)];
  expect(openCohort(zeros(), zeros())).toEqual({ cohort: 0, seatsLeft: full });
  expect(openCohort(counts(3), counts(3))).toEqual({ cohort: 0, seatsLeft: full - 3 });
  // A refund in the open cohort returns its seat, and it closes on its net count.
  expect(openCohort(counts(3), counts(2))).toEqual({ cohort: 0, seatsLeft: full - 2 });
  expect(openCohort(counts(full - 1), counts(full - 5))).toEqual({ cohort: 0, seatsLeft: 5 });
  expect(openCohort(counts(full + 2), counts(full - 1))).toEqual({ cohort: 0, seatsLeft: 1 });
  expect(openCohort(counts(full), counts(full))).toEqual({ cohort: 1, seatsLeft: full });
  // Refunded once a purchase landed at the next step: the price stays up.
  expect(openCohort(counts(full, 1), counts(full - 1, 1))).toEqual({ cohort: 1, seatsLeft: full - 1 });
  // Concurrent checkouts oversold it; the next still opens at a full count.
  expect(openCohort(counts(full + 4), counts(full + 4))).toEqual({ cohort: 1, seatsLeft: full });
  const all = Array<number>(FOUNDING_LADDER.length).fill(full);
  expect(openCohort(all, all)).toBeNull();
  // A refund in the last cohort reopens its seat; one in an earlier cohort does not.
  expect(openCohort(all, all.map((n, step) => (step === all.length - 1 ? n - 1 : n)))).toEqual({
    cohort: all.length - 1,
    seatsLeft: 1,
  });
  expect(openCohort(all, all.map((n, step) => (step === 0 ? n - 1 : n)))).toBeNull();
});

async function fixture() {
  // The entitlement reads the database's clock, so the test clock starts at it.
  const context = await createTestContext({ migrations, now: new Date().toISOString() });
  const databases = await workerDatabases(context.database.url);
  const { dev, setup } = await stripeDevBilling(context.time, context.random);
  const sql = <Row extends Record<string, unknown>>(text: string, values?: unknown[]) =>
    queryDatabase<Row>(context.database.url, text, values);
  const billing = <T>(action: Parameters<typeof withBilling<T>>[3]) =>
    withBilling(setup, context.database.url, origin, action);

  /** A user row; verified unless said otherwise. */
  const user = async (email = `${randomUUID()}@example.test`, emailVerified = true) => {
    const id = randomUUID();
    await sql(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $1, $2, $3)`, [
      id,
      email,
      emailVerified,
    ]);
    return id;
  };
  /** Delivers every pending StripeDev event, signed, to the webhook. */
  const deliver = async () => {
    while (dev.events.length) {
      const { body, signature } = dev.signed(dev.events.shift()!);
      await billing((b) => b.webhook(body, signature));
    }
  };
  /** Checks `owner` out on `plan` and completes it in StripeDev. */
  const buy = async (owner: string, plan: Plan) => {
    const { url } = await billing((b) => b.checkout(owner, `${owner}@example.test`, plan));
    const session = [...dev.checkouts.values()].find((s) => s.url === url)!;
    const subscription = dev.completeCheckout(session.id);
    await deliver();
    return subscription;
  };
  /** Whether `userId` is entitled, as each Worker's own role reads it. */
  const entitledOn = async (userId: string) =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(databases).map(async ([worker, url]) => {
          const [row] = await queryDatabase<{ is: boolean }>(
            url,
            `SELECT ${entitledSql("u")} AS is FROM "user" u WHERE u.id = $1`,
            [userId],
          );
          return [worker, row?.is];
        }),
      ),
    );
  return {
    ...context,
    dev,
    setup,
    sql,
    billing,
    user,
    deliver,
    buy,
    entitledOn,
    close: async () => {
      await dev.close();
      await context.close();
    },
  };
}

const everywhere = (is: boolean) => ({ account: is, relay: is, voice: is });

test("a subscription entitles its account on every Worker's role while it grants access, and a payment due grants nothing", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const member = await f.user();
  expect(await f.entitledOn(member)).toEqual(everywhere(false));

  const subscription = await f.buy(member, "monthly");
  // Stripe Billing with Stripe Tax: no Managed Payments, no trial.
  const sent = f.dev.requests.find((r) => r.path === "/v1/checkout/sessions")!.body;
  expect(sent).toMatchObject({
    "line_items[0][price]": f.setup.monthly,
    "automatic_tax[enabled]": "true",
    "customer_update[address]": "auto",
    success_url: expect.stringMatching(new RegExp(`^${origin}/billing\\?`)),
  });
  expect(sent["managed_payments[enabled]"]).toBeUndefined();
  expect(sent["subscription_data[trial_period_days]"]).toBeUndefined();
  expect(await f.entitledOn(member)).toEqual(everywhere(true));
  expect(await entitled(f.database.url, member)).toBe(true);

  // A failed renewal ends access until it is paid.
  f.dev.transition(subscription.id, "payment-failed");
  await f.deliver();
  expect(await f.entitledOn(member)).toEqual(everywhere(false));
  f.dev.transition(subscription.id, "renew");
  await f.deliver();
  expect(await f.entitledOn(member)).toEqual(everywhere(true));

  // A period that ended without a renewal grants nothing, whatever the row's status.
  await f.sql(`UPDATE pgstencil_billing.subscriptions SET period_end = now() - interval '1 second'`);
  expect(await f.entitledOn(member)).toEqual(everywhere(false));
  await f.sql(`UPDATE pgstencil_billing.subscriptions SET period_end = now() + interval '1 day'`);
  // Two current subscriptions grant nothing, as `status()` reads them.
  await f.sql(
    `INSERT INTO pgstencil_billing.subscriptions
      (id, owner_id, price_id, status, period_end, cancel_at_period_end, updated_at)
    VALUES ('sub_second', $1, $2, 'past_due', now() + interval '1 day', false, now())`,
    [member, f.setup.yearly],
  );
  expect(await f.entitledOn(member)).toEqual(everywhere(false));
  await f.sql(`DELETE FROM pgstencil_billing.subscriptions WHERE id = 'sub_second'`);
  expect(await f.entitledOn(member)).toEqual(everywhere(true));

  // Canceled, as a refund cancels: refused on the next read.
  f.dev.transition(subscription.id, "cancel");
  await f.deliver();
  expect(await f.entitledOn(member)).toEqual(everywhere(false));
  expect(await f.sql(`SELECT owner_id, status FROM pgstencil_billing.subscriptions`)).toEqual([
    { owner_id: member, status: "canceled" },
  ]);

  // The admin is a standing comp, while that address is verified; an unverified one is not.
  expect(await f.entitledOn(await f.user(ADMIN_EMAIL))).toEqual(everywhere(true));
  await f.sql(`DELETE FROM "user" WHERE email = $1`, [ADMIN_EMAIL]);
  expect(await f.entitledOn(await f.user(ADMIN_EMAIL, false))).toEqual(everywhere(false));
});

test("founding checkout offers the open cohort's Price, returns a refunded seat in it, holds it after one before, and refuses once full", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  /** `count` paid founders at ladder step `step`, started 40 days ago. */
  const fill = (step: number, count: number) =>
    f.sql(
      `WITH owners AS (
        INSERT INTO pgstencil_billing.accounts (owner_id, email, created_at)
        SELECT 'filler-' || $2::int || '-' || gen_random_uuid(), 'filler@example.test', now() FROM generate_series(1, $1::int)
        RETURNING owner_id)
      INSERT INTO pgstencil_billing.subscriptions
        (id, owner_id, price_id, status, started_at, period_end, cancel_at_period_end, updated_at)
      SELECT 'sub_' || owner_id, owner_id, $3, 'active', now() - interval '40 days',
        now() + interval '325 days', false, now() FROM owners`,
      [count, step, LADDER[step]],
    );
  const offered = () => f.billing((b) => b.offeredPrice("founding"));

  expect(await offered()).toBe(LADDER[0]);
  const ada = await f.user();
  await f.buy(ada, "founding");
  expect(await f.entitledOn(ada)).toEqual(everywhere(true));
  const refund = (owner: string) =>
    f.sql(
      `UPDATE pgstencil_billing.subscriptions SET status = 'canceled', ended_at = started_at + interval '1 day'
      WHERE owner_id = $1`,
      [owner],
    );
  // Ada is refunded in the open cohort: her seat returns, so it takes one more to close it.
  await refund(ada);
  await fill(0, FOUNDING_COHORT_SIZE - 1);
  expect(await offered()).toBe(LADDER[0]);
  const bea = await f.user();
  await f.buy(bea, "founding");
  expect(await offered()).toBe(LADDER[1]);
  // Bea is refunded once a purchase landed at the next step: the price stays up.
  await fill(1, 1);
  await refund(bea);
  expect(await offered()).toBe(LADDER[1]);

  for (let step = 1; step < LADDER.length; step++) await fill(step, FOUNDING_COHORT_SIZE);
  const late = await f.user();
  await expect(f.billing((b) => b.checkout(late, null, "founding"))).rejects.toEqual(
    new BillingError("Founding is closed.", 409),
  );
  // Every past cohort's Price still grants its plan.
  expect(await f.billing(async (b) => LADDER.map((price) => b.planOf(price)))).toEqual(
    LADDER.map(() => "founding"),
  );
});

test("the resync repairs a missed renewal, and does nothing while billing is closed", async ({ onTestFinished }) => {
  const f = await fixture();
  onTestFinished(f.close);
  // Closed: no setup, so not even the database is asked.
  await expect(resyncBilling(null, "postgres://user:pass@127.0.0.1:9/none", origin, noMail)).resolves.toBeUndefined();

  const member = await f.user();
  const subscription = await f.buy(member, "yearly");
  // Stripe renewed, but the webhook never arrived, and the stored period has ended.
  f.dev.transition(subscription.id, "renew");
  f.dev.events.length = 0;
  await f.sql(`UPDATE pgstencil_billing.subscriptions SET period_end = now() - interval '1 minute'`);
  expect(await f.entitledOn(member)).toEqual(everywhere(false));
  await resyncBilling(f.setup, f.database.url, origin, noMail);
  expect(await f.entitledOn(member)).toEqual(everywhere(true));
});

test("the account Worker's cron resyncs through Stripe's API in workerd, and only with every binding", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const member = await f.user();
  const subscription = await f.buy(member, "yearly");
  f.dev.transition(subscription.id, "renew");
  f.dev.events.length = 0;
  await f.sql(`UPDATE pgstencil_billing.subscriptions SET period_end = now() - interval '1 minute'`);

  const bundle = await bundleWorker("server/tests/worker-entry.ts", [
    fileURLToPath(import.meta.resolve("@pgstencil/auth/better-auth-testing")),
  ]);
  const outbound: string[] = [];
  const worker = async (stripe: Record<string, string>) => {
    const mf = new Miniflare(
      alone(
        "account",
        miniflareOptions("account", bundle.outputFiles[0].text, {
          bindings: {
            APP_ORIGIN: origin,
            AUTH_SECRET: "dormouse-test-secret-with-at-least-32-characters",
            EMAIL_FROM: "signin@example.test",
            POSTMARK_SERVER_TOKEN: "test-token",
            ...stripe,
          },
          hyperdrives: { HYPERDRIVE: f.database.url },
          serviceBindings: { ASSETS: () => new WorkerResponse("<!doctype html>") },
          // Stripe's API is StripeDev here; nothing else may be reached.
          async outboundService(request: Request) {
            const url = new URL(request.url);
            outbound.push(url.origin);
            if (url.origin !== "https://api.stripe.com") throw new Error(`Unexpected outbound host: ${url.host}`);
            const response = await fetch(f.dev.origin + url.pathname + url.search, {
              method: request.method,
              headers: Object.fromEntries(request.headers),
              ...(request.method === "POST" ? { body: await request.text() } : {}),
            });
            return new WorkerResponse(await response.arrayBuffer(), {
              status: response.status,
              headers: { "content-type": "application/json" },
            });
          },
        }),
      ),
    );
    onTestFinished(() => mf.dispose());
    await mf.ready;
    // The Worker's clock is the fixture's, which the stale renewal is stale by.
    await mf.dispatchFetch(origin + "/__test/time", { method: "POST", body: f.time.now().toISOString() });
    // Without @cloudflare/workers-types, the Fetcher's scheduled() is untyped.
    return (await mf.getWorker()) as unknown as {
      scheduled(options: { cron: string }): Promise<{ outcome: string }>;
    };
  };
  const bindings = {
    STRIPE_SECRET_KEY: f.setup.secretKey,
    STRIPE_WEBHOOK_SECRET: f.setup.webhookSecret,
    STRIPE_PRICE_MONTHLY: f.setup.monthly,
    STRIPE_PRICE_YEARLY: f.setup.yearly,
    STRIPE_PRICES_FOUNDING: f.setup.founding.join(","),
  };
  const { STRIPE_SECRET_KEY: _, ...missingKey } = bindings;
  expect((await (await worker(missingKey)).scheduled({ cron: "*/10 * * * *" })).outcome).toBe("ok");
  expect(outbound).toEqual([]);
  expect(await f.entitledOn(member)).toEqual(everywhere(false));

  expect((await (await worker(bindings)).scheduled({ cron: "*/10 * * * *" })).outcome).toBe("ok");
  expect(outbound.length).toBeGreaterThan(0);
  expect(new Set(outbound)).toEqual(new Set(["https://api.stripe.com"]));
  expect(await f.entitledOn(member)).toEqual(everywhere(true));
});
