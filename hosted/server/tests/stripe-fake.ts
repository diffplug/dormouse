import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { STRIPE_API_VERSION, Stripe } from "@pgstencil/stripe";
import type { RandomSource, Time } from "pgstencil";
import { stripeDevBilling } from "../billing-dev";

/**
 * StripeDev behind a proxy that adds what billing's refund and dispute
 * handling call and StripeDev does not model: a dispute's retrieval, with
 * its charge expanded, and a subscription's immediate cancellation. Every
 * other request reaches StripeDev unchanged.
 */
export async function stripeFake(time: Time, random: RandomSource) {
  const { dev, setup: devSetup } = await stripeDevBilling(time, random);
  /** Dispute id → its current status, and its charge's customer and PaymentIntent. */
  const disputes = new Map<string, { status: string; customer: string; paymentIntent: string }>();
  /** PaymentIntent id → the subscription whose invoice it paid. */
  const paidInvoices = new Map<string, string>();
  /** Each cancellation billing asked for: the subscription and its comment. */
  const cancels: { subscription: string; comment: string | null }[] = [];
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
    if (url.pathname === "/v1/invoice_payments" && req.method === "GET") {
      const intent = url.searchParams.get("payment[payment_intent]");
      const subscriptionId = intent && url.searchParams.get("payment[type]") === "payment_intent" && paidInvoices.get(intent);
      return json(200, {
        object: "list",
        has_more: false,
        data: subscriptionId
          ? [
              {
                id: `inpay_${intent}`,
                object: "invoice_payment",
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
    event,
    close: async () => {
      server.close();
      await dev.close();
    },
  };
}
