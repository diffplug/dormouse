import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { STRIPE_API_VERSION, Stripe } from "@pgstencil/stripe";
import type { RandomSource, Time } from "pgstencil";
import { LIST_ANNUAL, LIST_MONTHLY } from "../../../website/src/lib/hosted-pricing";
import { stripeDevBilling } from "../billing-dev";

/** The Prices the tests' price changes move monthly and yearly subscribers to, and what they charge. */
export const CHANGED_PRICES = { monthly: "price_dev_monthly_next", yearly: "price_dev_yearly_next" } as const;
export const CHANGED_USD = { monthly: 12, yearly: 120 } as const;

/** What each paid invoice asked for, and each payment paid, in cents. */
const INVOICE_CENTS = 1000;

/**
 * StripeDev behind a proxy that adds what billing's refund, dispute,
 * withdrawal, and closure handling, and the price changes, call and StripeDev
 * does not model: a dispute's retrieval, with its charge expanded, and its charge's, a
 * subscription's immediate cancellation, retrieval, and move to another
 * Price, a customer's retrieval with its billing country, a subscription's
 * paid invoices, why each was billed and when it was paid, and their
 * payments, how each was paid, refunds, and a Price's retrieval. Every other request reaches
 * StripeDev unchanged.
 */
export async function stripeFake(time: Time, random: RandomSource) {
  const { dev, setup: devSetup } = await stripeDevBilling(time, random, undefined, {
    [CHANGED_PRICES.monthly]: "month",
    [CHANGED_PRICES.yearly]: "year",
  });
  /** Price id → what Stripe holds for it; tests may change an entry. */
  const prices = new Map<string, { usd: number; interval: "month" | "year" }>([
    [devSetup.monthly, { usd: LIST_MONTHLY, interval: "month" }],
    [devSetup.yearly, { usd: LIST_ANNUAL, interval: "year" }],
    [CHANGED_PRICES.monthly, { usd: CHANGED_USD.monthly, interval: "month" }],
    [CHANGED_PRICES.yearly, { usd: CHANGED_USD.yearly, interval: "year" }],
  ]);
  /** Each subscription a checkout completed, as StripeDev holds it: changing one changes StripeDev's. */
  const live = new Map<string, Stripe.Subscription>();
  const complete = dev.completeCheckout;
  dev.completeCheckout = (sessionId: string) => {
    const subscription = complete(sessionId);
    live.set(subscription.id, subscription);
    return subscription;
  };
  /** Each move to another Price billing asked for: the subscription, the Price, and the proration. */
  const moves: { subscription: string; price: string; proration: string | null }[] = [];
  /** Dispute id → its current status, and its charge's customer and PaymentIntent. */
  const disputes = new Map<string, { status: string; customer: string; paymentIntent: string }>();
  /** PaymentIntent id → the subscription whose invoice it paid. */
  const paidInvoices = new Map<string, string>();
  /** PaymentIntent id → why its invoice was billed, and when it was paid; else a first payment, paid at no known time. */
  const invoiceFacts = new Map<string, { reason: "subscription_create" | "subscription_cycle"; paidAt: Date }>();
  /**
   * PaymentIntent id → how its invoice was paid instead, when not by that
   * PaymentIntent: by a charge without one (`ch_<id>`), by a payment record
   * (`pr_<id>`), or marked paid out of band, with no payment.
   */
  const paidBy = new Map<string, "charge" | "payment_record" | "out_of_band">();
  /** Each cancellation billing asked for. */
  const cancels: { subscription: string }[] = [];
  /** Customer id → its billing address's country; none, no address. */
  const countries = new Map<string, string>();
  /** Each refund made: its PaymentIntent, or charge when it names one, and its metadata's withdrawal, or closure when it names one. */
  const refunds: { paymentIntent?: string; charge?: string; withdrawal: string | null; closure?: string }[] = [];
  /** How many times billing read a customer, and a Price. */
  const reads = { customers: 0, prices: 0 };
  /** Refund and cancellation requests to fail, before any is made, with a Stripe outage. */
  const failing = { refunds: 0, cancels: 0 };
  /** What runs as each request arrives, before it is answered. */
  const before: { request: ((method: string, path: string) => Promise<void>) | null } = { request: null };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, "http://127.0.0.1");
    await before.request?.(req.method!, url.pathname);
    const json = (status: number, value: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    const disputedCharge = (id: string) => {
      const found = disputes.get(id)!;
      return { id: `ch_for_${id}`, object: "charge", customer: found.customer, payment_intent: found.paymentIntent };
    };
    const dispute = /^\/v1\/disputes\/([^/]+)$/.exec(url.pathname);
    if (dispute && req.method === "GET") {
      const found = disputes.get(dispute[1]!);
      if (!found) return json(404, { error: { message: "No such dispute" } });
      return json(200, { id: dispute[1], object: "dispute", status: found.status, charge: disputedCharge(dispute[1]!) });
    }
    // pgstencil reads a dispute event's customer from its charge, `ch_for_<dispute id>` here.
    const charge = /^\/v1\/charges\/ch_for_([^/]+)$/.exec(url.pathname);
    if (charge && req.method === "GET") {
      if (!disputes.has(charge[1]!)) return json(404, { error: { message: "No such charge" } });
      return json(200, disputedCharge(charge[1]!));
    }
    const customer = /^\/v1\/customers\/([^/]+)$/.exec(url.pathname);
    if (customer && req.method === "GET") {
      reads.customers++;
      const found = dev.customers.get(customer[1]!);
      if (!found) return json(404, { error: { message: "No such customer" } });
      const country = countries.get(customer[1]!);
      return json(200, { ...found, address: country ? { country } : null });
    }
    if (url.pathname === "/v1/invoices" && req.method === "GET") {
      const of = url.searchParams.get("subscription");
      const paid = url.searchParams.get("status") === "paid";
      return json(200, {
        object: "list",
        has_more: false,
        data: [...paidInvoices]
          .filter(([, subscriptionId]) => paid && subscriptionId === of)
          .map(([intent]) => {
            const facts = invoiceFacts.get(intent);
            return {
              id: `in_${intent}`,
              object: "invoice",
              status: "paid",
              amount_due: INVOICE_CENTS,
              currency: "usd",
              billing_reason: facts?.reason ?? "subscription_create",
              status_transitions: { paid_at: facts ? Math.floor(facts.paidAt.getTime() / 1000) : null },
            };
          }),
      });
    }
    if (url.pathname === "/v1/refunds" && req.method === "POST") {
      const body = new URLSearchParams(raw);
      const intent = body.get("payment_intent");
      const charge = body.get("charge")!;
      if (failing.refunds > 0) {
        failing.refunds--;
        return json(500, { error: { type: "api_error", message: "Stripe fake outage" } });
      }
      if (refunds.some((refund) => (intent ? refund.paymentIntent === intent : refund.charge === charge)))
        return json(400, {
          error: { type: "invalid_request_error", code: "charge_already_refunded", message: "Charge has already been refunded." },
        });
      const closure = body.get("metadata[dormouse_closure]");
      const withdrawal = body.get("metadata[dormouse_withdrawal]");
      refunds.push({ ...(intent ? { paymentIntent: intent } : { charge }), withdrawal, ...(closure && { closure }) });
      return json(200, { id: `re_${intent ?? charge}`, object: "refund", payment_intent: intent, status: "succeeded" });
    }
    if (url.pathname === "/v1/invoice_payments" && req.method === "GET") {
      const invoice = url.searchParams.get("invoice");
      const intent = invoice?.startsWith("in_") ? invoice.slice(3) : url.searchParams.get("payment[payment_intent]");
      const by = intent ? paidBy.get(intent) : undefined;
      const listed = invoice ? by !== "out_of_band" : !by && url.searchParams.get("payment[type]") === "payment_intent";
      const subscriptionId = intent && listed && paidInvoices.get(intent);
      const payment =
        by === "charge"
          ? { type: "charge", charge: `ch_${intent}` }
          : by === "payment_record"
            ? { type: "payment_record", payment_record: `pr_${intent}` }
            : { type: "payment_intent", payment_intent: intent };
      return json(200, {
        object: "list",
        has_more: false,
        data: subscriptionId
          ? [
              {
                id: `inpay_${intent}`,
                object: "invoice_payment",
                status: "paid",
                amount_paid: INVOICE_CENTS,
                currency: "usd",
                payment,
                invoice: {
                  id: `in_${intent}`,
                  object: "invoice",
                  parent: { type: "subscription_details", subscription_details: { subscription: subscriptionId, metadata: null } },
                },
              },
            ]
          : [],
      });
    }
    const price = /^\/v1\/prices\/([^/]+)$/.exec(url.pathname);
    if (price && req.method === "GET") {
      reads.prices++;
      const found = prices.get(price[1]!);
      if (!found) return json(404, { error: { message: "No such price" } });
      return json(200, {
        id: price[1],
        object: "price",
        currency: "usd",
        unit_amount: found.usd * 100,
        livemode: false,
        recurring: { interval: found.interval, interval_count: 1 },
      });
    }
    const subscription = /^\/v1\/subscriptions\/([^/]+)$/.exec(url.pathname);
    if (subscription && req.method === "GET") {
      const found = live.get(subscription[1]!);
      return found ? json(200, found) : json(404, { error: { message: "No such subscription" } });
    }
    if (subscription && req.method === "POST") {
      const found = live.get(subscription[1]!);
      if (!found) return json(404, { error: { message: "No such subscription" } });
      const body = new URLSearchParams(raw);
      const item = found.items.data[0]!;
      if (body.get("items[0][id]") !== item.id) return json(400, { error: { message: "No such item" } });
      const to = body.get("items[0][price]")!;
      moves.push({ subscription: found.id, price: to, proration: body.get("proration_behavior") });
      item.price = { id: to } as Stripe.Price;
      return json(200, found);
    }
    if (subscription && req.method === "DELETE") {
      if (failing.cancels > 0) {
        failing.cancels--;
        return json(500, { error: { type: "api_error", message: "Stripe fake outage" } });
      }
      cancels.push({ subscription: subscription[1]! });
      dev.transition(subscription[1]!, "cancel");
      return json(200, dev.events.at(-1)!.data.object);
    }
    const forwarded = await fetch(dev.origin + url.pathname + url.search, {
      method: req.method,
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(([name]) => name !== "host" && name !== "content-length"),
      ) as Record<string, string>,
      ...(req.method === "POST" ? { body: raw } : {}),
    });
    res.writeHead(forwarded.status, { "content-type": "application/json" }).end(await forwarded.text());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const stripe = new Stripe(devSetup.secretKey, {
    host: "127.0.0.1",
    port,
    protocol: "http",
    maxNetworkRetries: 0,
    timeout: 5000,
  });
  let sequence = 0;
  /** A test-mode event of `type` about `object`, as Stripe would sign and send it. */
  const event = (type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({
      id: `evt_fake_${++sequence}`,
      object: "event",
      api_version: STRIPE_API_VERSION,
      created: Math.floor(time.now().getTime() / 1000),
      livemode: false,
      type,
      data: { object },
      pending_webhooks: 1,
      request: null,
      ...extra,
    }) as unknown as Stripe.Event;
  return {
    dev,
    setup: { ...devSetup, stripe, time },
    origin,
    disputes,
    paidInvoices,
    invoiceFacts,
    paidBy,
    cancels,
    countries,
    refunds,
    failing,
    before,
    reads,
    prices,
    moves,
    event,
    close: async () => {
      server.close();
      await dev.close();
    },
  };
}
