import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { STRIPE_API_VERSION, Stripe } from "@pgstencil/stripe";
import type { RandomSource, Time } from "pgstencil";
import { stripeDevBilling } from "../billing-dev";

/**
 * StripeDev behind a proxy that adds what billing's refund, dispute, and
 * withdrawal handling call and StripeDev does not model: a dispute's
 * retrieval, with its charge expanded, a subscription's immediate
 * cancellation, a customer's retrieval with its billing country, a
 * subscription's paid invoices and their payments, and refunds. Every other
 * request reaches StripeDev unchanged.
 */
export async function stripeFake(time: Time, random: RandomSource) {
  const { dev, setup: devSetup } = await stripeDevBilling(time, random);
  /** Dispute id → its current status, and its charge's customer and PaymentIntent. */
  const disputes = new Map<string, { status: string; customer: string; paymentIntent: string }>();
  /** PaymentIntent id → the subscription whose invoice it paid. */
  const paidInvoices = new Map<string, string>();
  /** Each cancellation billing asked for: the subscription and its comment. */
  const cancels: { subscription: string; comment: string | null }[] = [];
  /** Customer id → its billing address's country; none, no address. */
  const countries = new Map<string, string>();
  /** Each refund made: its PaymentIntent and its metadata's withdrawal. */
  const refunds: { paymentIntent: string; withdrawal: string | null }[] = [];
  /** Refund and cancellation requests to fail, before any is made, with a Stripe outage. */
  const failing = { refunds: 0, cancels: 0 };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url!, "http://127.0.0.1");
    const json = (status: number, value: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    const dispute = /^\/v1\/disputes\/([^/]+)$/.exec(url.pathname);
    if (dispute && req.method === "GET") {
      const found = disputes.get(dispute[1]!);
      if (!found) return json(404, { error: { message: "No such dispute" } });
      return json(200, {
        id: dispute[1],
        object: "dispute",
        status: found.status,
        charge: { id: `ch_for_${dispute[1]}`, object: "charge", customer: found.customer, payment_intent: found.paymentIntent },
      });
    }
    const customer = /^\/v1\/customers\/([^/]+)$/.exec(url.pathname);
    if (customer && req.method === "GET") {
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
          .map(([intent]) => ({ id: `in_${intent}`, object: "invoice", status: "paid" })),
      });
    }
    if (url.pathname === "/v1/refunds" && req.method === "POST") {
      const body = new URLSearchParams(raw);
      const intent = body.get("payment_intent")!;
      if (failing.refunds > 0) {
        failing.refunds--;
        return json(500, { error: { type: "api_error", message: "Stripe fake outage" } });
      }
      if (refunds.some((refund) => refund.paymentIntent === intent))
        return json(400, {
          error: { type: "invalid_request_error", code: "charge_already_refunded", message: "Charge has already been refunded." },
        });
      refunds.push({ paymentIntent: intent, withdrawal: body.get("metadata[dormouse_withdrawal]") });
      return json(200, { id: `re_${intent}`, object: "refund", payment_intent: intent, status: "succeeded" });
    }
    if (url.pathname === "/v1/invoice_payments" && req.method === "GET") {
      const invoice = url.searchParams.get("invoice");
      const intent = invoice?.startsWith("in_") ? invoice.slice(3) : url.searchParams.get("payment[payment_intent]");
      const subscriptionId =
        intent && (invoice || url.searchParams.get("payment[type]") === "payment_intent") && paidInvoices.get(intent);
      return json(200, {
        object: "list",
        has_more: false,
        data: subscriptionId
          ? [
              {
                id: `inpay_${intent}`,
                object: "invoice_payment",
                status: "paid",
                payment: { type: "payment_intent", payment_intent: intent },
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
    const subscription = /^\/v1\/subscriptions\/([^/]+)$/.exec(url.pathname);
    if (subscription && req.method === "DELETE") {
      if (failing.cancels > 0) {
        failing.cancels--;
        return json(500, { error: { type: "api_error", message: "Stripe fake outage" } });
      }
      // The SDK sends a DELETE's parameters in its query.
      const comment = new URLSearchParams(raw || url.search).get("cancellation_details[comment]");
      cancels.push({ subscription: subscription[1]!, comment });
      dev.transition(subscription[1]!, "cancel");
      // Stripe carries the comment on the subscription it ends.
      const ended = dev.events.at(-1)!.data.object as Stripe.Subscription;
      ended.cancellation_details = { comment } as Stripe.Subscription.CancellationDetails;
      return json(200, ended);
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
    setup: { ...devSetup, stripe },
    origin,
    disputes,
    paidInvoices,
    cancels,
    countries,
    refunds,
    failing,
    event,
    close: async () => {
      server.close();
      await dev.close();
    },
  };
}
