import type { IncomingMessage } from "node:http";

/** Stripe's return path, which StripeDev's page on 127.0.0.1 navigates back to. */
const STRIPE_RETURN = "/billing";

// The local inbox holds login codes. Loopback binding alone is not access control.
export function allowedDevRequest(
  request: IncomingMessage,
  origin: string,
): boolean {
  const { headers } = request;
  if (headers.host !== new URL(origin).host) return false;
  if (headers.origin && headers.origin !== origin) return false;
  if (headers["sec-fetch-site"] !== "cross-site") return true;
  // The one cross-site request it takes: a top-level GET of Stripe's return,
  // which serves the page shell and reads nothing.
  return (
    request.method === "GET" &&
    headers["sec-fetch-mode"] === "navigate" &&
    new URL(request.url ?? "/", origin).pathname === STRIPE_RETURN
  );
}
