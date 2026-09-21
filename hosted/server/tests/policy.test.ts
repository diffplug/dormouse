import { test, expect } from "vitest";
import { authPolicy, providerBindings, LOGIN_FRESH_AGE_MS } from "../policy";
import { allowedDevRequest } from "../dev-host-guard";
import type { IncomingMessage } from "node:http";
test("provider allowlist fails closed on typos and partial credentials", () => {
  expect(
    providerBindings({
      GOOGLE_CLIENT_ID: "stale",
      GOOGLE_CLIENT_SECRET: "stale",
    }),
  ).toEqual({});
  expect(() => providerBindings({ OAUTH_PROVIDERS: "facebook" })).toThrow();
  expect(() =>
    providerBindings({ OAUTH_PROVIDERS: "github", GITHUB_CLIENT_ID: "id" }),
  ).toThrow();
});
test("local inbox is guarded against rebinding and cross-origin requests", () => {
  const origin = "http://127.0.0.1:5188";
  const check = (headers: IncomingMessage["headers"]) =>
    allowedDevRequest({ headers } as IncomingMessage, origin);
  expect(check({ host: "127.0.0.1:5188" })).toBe(true);
  expect(check({ host: "attacker.test:5188" })).toBe(false);
  expect(check({ host: "127.0.0.1:5188", origin: "https://dormouse.sh" })).toBe(
    false,
  );
  expect(
    check({ host: "127.0.0.1:5188", "sec-fetch-site": "cross-site" }),
  ).toBe(false);
});
// The account screen and the packed adapter gate on the same window; nothing
// else would notice a pgstencil bump moving one of them.
test("the recent-login window matches the adapter's own freshAge", async () => {
  const { authOptions } = await import("@pgstencil/auth/better-auth");
  const built = authOptions({
    ...authPolicy,
    database: {} as never,
    origin: "https://hosted.dormouse.sh",
    secret: "x".repeat(32),
    email: { send: async () => {} } as never,
  });
  expect(built.session?.freshAge).toBe(LOGIN_FRESH_AGE_MS / 1000);
});
