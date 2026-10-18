import type { IncomingMessage } from "node:http";
import { BILLING_RETURN_PATH } from "./policy-constants";

// The local inbox holds login codes. Loopback binding alone is not access control.
export function allowedDevRequest(
  request: IncomingMessage,
  origin: string,
): boolean {
  const { headers } = request;
  if (headers.host !== new URL(origin).host) return false;
  if (headers.origin && headers.origin !== origin) return false;
  if (headers["sec-fetch-site"] !== "cross-site") return true;
  // The one cross-site request it takes: a top-level GET of Stripe's return
  // (StripeDev's page is on 127.0.0.1), which serves the shell and reads nothing.
  return (
    request.method === "GET" &&
    headers["sec-fetch-mode"] === "navigate" &&
    new URL(request.url ?? "/", origin).pathname === BILLING_RETURN_PATH
  );
}
