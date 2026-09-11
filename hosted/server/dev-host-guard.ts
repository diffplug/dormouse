import type { IncomingMessage } from "node:http";

// The local inbox holds login codes. Loopback binding alone is not access control.
export function allowedDevRequest(
  request: IncomingMessage,
  origin: string,
): boolean {
  return (
    request.headers.host === new URL(origin).host &&
    (!request.headers.origin || request.headers.origin === origin) &&
    request.headers["sec-fetch-site"] !== "cross-site"
  );
}
