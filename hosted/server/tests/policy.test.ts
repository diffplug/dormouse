import { test, expect } from "vitest";
import { providerBindings } from "../policy";
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
