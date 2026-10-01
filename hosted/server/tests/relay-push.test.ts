import { test, expect, vi } from "vitest";
import { createECDH } from "node:crypto";
import { MAX_PUSH_ENDPOINT_LENGTH, MAX_PUSH_SUBSCRIPTIONS_PER_BURROW } from "remote-lib-common";
import type { RelayEnv } from "../bindings";
import {
  deliverPush,
  deliverWithinDeadline,
  MAX_REASON_BYTES,
  knownPushEndpoint,
  pushConfigOf,
  reasonOf,
  vapidAuthorizations,
  type PushConfig,
} from "../relay-push";
import { NAMES, ORIGINS, testVapidKeys, wrangler } from "./bundle";

// The Hosted Relay's push egress (`docs/specs/hosted.md` -> "Relay"): which
// endpoints it registers and fetches, how one delivery is classified, and the
// deadline. The routes run against Postgres in `relay.test.ts`.

test("only a known push service's https endpoint, on the default port and without credentials, is admitted", () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/abc:def",
    "https://fcm.googleapis.com:443/wp/abc",
    "https://web.push.apple.com/QGuQyavXutnMH-5",
    "https://api.push.apple.com/3/device/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB",
    "https://FCM.googleapis.com/fcm/send/abc",
  ])
    expect(knownPushEndpoint(endpoint), endpoint).not.toBeNull();
  for (const endpoint of [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://user:pass@fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com.evil.test/fcm/send/abc",
    "https://push.apple.com/abc",
    "https://evilpush.apple.com/abc",
    "https://web.push.apple.com.evil.test/abc",
    "https://notify.windows.com/w/",
    "https://push.example.com/sub/abc",
    "https://127.0.0.1/abc",
    "https://[::1]/abc",
    "https://localhost/abc",
    `https://fcm.googleapis.com/${"a".repeat(MAX_PUSH_ENDPOINT_LENGTH)}`,
    "not a url",
  ])
    expect(knownPushEndpoint(endpoint), endpoint).toBeNull();
});

const env = (extra: Partial<RelayEnv> = {}) =>
  ({ APP_ORIGIN: ORIGINS.relay, ...testVapidKeys(), ...extra }) as RelayEnv;

test("push is configured only by a matching pair and an https, non-loopback origin", async () => {
  const keys = testVapidKeys();
  expect((await pushConfigOf(env()))?.signer.publicKey).toBe(keys.RELAY_VAPID_PUBLIC_KEY);
  expect((await pushConfigOf(env()))?.subject).toBe(ORIGINS.relay);
  const other = testVapidKeys("another");
  for (const [name, extra] of [
    ["no public key", { RELAY_VAPID_PUBLIC_KEY: undefined }],
    ["no private key", { RELAY_VAPID_PRIVATE_KEY: undefined }],
    ["a mismatched pair", { RELAY_VAPID_PRIVATE_KEY: other.RELAY_VAPID_PRIVATE_KEY }],
    ["a malformed key", { RELAY_VAPID_PUBLIC_KEY: "not-a-key" }],
    ["a loopback origin", { APP_ORIGIN: "http://127.0.0.1:8787" }],
  ] as const)
    expect(await pushConfigOf(env(extra)), name).toBeNull();
});

test("noncanonical VAPID secrets disable push across repeated cached config reads", async () => {
  const keys = testVapidKeys();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (const field of ["RELAY_VAPID_PUBLIC_KEY", "RELAY_VAPID_PRIVATE_KEY"] as const) {
    const value = keys[field];
    const noncanonical = value.slice(0, -1) + alphabet[alphabet.indexOf(value.at(-1)!) | 1];
    expect(noncanonical).not.toBe(value);
    const invalid = env({ [field]: noncanonical });
    expect(await pushConfigOf(invalid), field).toBeNull();
    expect(await pushConfigOf(invalid), `${field} cached`).toBeNull();
  }
  expect(await pushConfigOf(env())).not.toBeNull();
});

/** A subscription a browser could hold. */
function target(endpoint = "https://fcm.googleapis.com/fcm/send/abc") {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: "BTBZMqHH6r4Tts7J_aSIgg" },
  };
}

async function push(): Promise<PushConfig> {
  return (await pushConfigOf(env()))!;
}

test("one delivery: 2xx delivered, 404 and 410 expired, a redirect or refusal or throw failed", async () => {
  const config = await push();
  const seen: RequestInit[] = [];
  const answering = (response: () => Response) =>
    (async (url: string, init: RequestInit) => {
      expect(url).toBe("https://fcm.googleapis.com/fcm/send/abc");
      seen.push(init);
      return response();
    }) as unknown as typeof fetch;
  const outcome = (response: () => Response) =>
    deliverPush(target(), '{"v":1}', vapidAuthorizations(config), { fetch: answering(response) });
  expect(await outcome(() => new Response(null, { status: 201 }))).toBe("delivered");
  expect(await outcome(() => new Response(null, { status: 404 }))).toBe("expired");
  expect(await outcome(() => new Response(null, { status: 410 }))).toBe("expired");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(
      await outcome(() => new Response(null, { status: 302, headers: { location: "https://evil.test/" } })),
    ).toBe("failed");
    expect(await outcome(() => new Response(`  {"reason":\n"BadJwtToken"}${" x".repeat(5000)}`, { status: 403 }))).toBe(
      "failed",
    );
    // The reason is collapsed and clamped; the endpoint's path never reaches the log.
    const logged = warn.mock.calls.at(-1)!.map(String).join(" ");
    expect(logged).toContain('{"reason": "BadJwtToken"}');
    expect(logged.length).toBeLessThan(400);
    expect(logged).not.toContain("/fcm/send/abc");
    expect(
      await deliverPush(target(), "{}", vapidAuthorizations(config), {
        fetch: (async () => {
          throw new Error("connection reset");
        }) as unknown as typeof fetch,
      }),
    ).toBe("failed");
  } finally {
    warn.mockRestore();
  }
  // Every request: POST, never following a redirect, aes128gcm under VAPID.
  for (const init of seen) {
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(headers.ttl).toBe("300");
    expect(headers.authorization).toMatch(/^vapid t=[^,]+, k=/);
  }
});

test("an endpoint outside the allowlist is never fetched, whatever the row says", async () => {
  const fetched = vi.fn();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(
      await deliverPush(target("https://push.example.com/sub/abc"), "{}", vapidAuthorizations(await push()), {
        fetch: fetched as unknown as typeof fetch,
      }),
    ).toBe("failed");
  } finally {
    warn.mockRestore();
  }
  expect(fetched).not.toHaveBeenCalled();
});

test("a delivery past its deadline is failed and aborted; a throw is failed", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    let aborted = false;
    const started = Date.now();
    const result = await deliverWithinDeadline(
      (signal) =>
        new Promise(() => {
          signal.addEventListener("abort", () => (aborted = true));
        }),
      50,
    );
    expect(result).toBe("failed");
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(
      await deliverWithinDeadline(() => {
        throw new Error("synchronous");
      }, 1000),
    ).toBe("failed");
    expect(await deliverWithinDeadline(async () => "delivered", 1000)).toBe("delivered");
  } finally {
    warn.mockRestore();
  }
});

test("a refusal's reason keeps at most its bound of the body, however large a chunk, and cancels the rest", async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    // One chunk far past the bound: blank up to it, a marker after.
    pull(controller) {
      pulls++;
      controller.enqueue(new TextEncoder().encode(`${" ".repeat(MAX_REASON_BYTES)}beyond${"x".repeat(64 * 1024)}`));
    },
    cancel() {
      cancelled = true;
    },
  });
  expect(await reasonOf(new Response(body, { status: 500 }))).toBe("");
  expect(pulls).toBe(1);
  expect(cancelled).toBe(true);
  // Small chunks are kept up to the bound across reads.
  const chunks = ['{"reason":', '"Overloaded"}'];
  const small = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next) controller.enqueue(new TextEncoder().encode(next));
      else controller.close();
    },
  });
  expect(await reasonOf(new Response(small, { status: 500 }))).toBe('{"reason":"Overloaded"}');
});

test("a send's VAPID JWT is signed once per push-service origin", async () => {
  const config = await push();
  const sign = vi.spyOn(config.signer, "authorization");
  const authorize = vapidAuthorizations(config);
  const fcm = await authorize(new URL("https://fcm.googleapis.com/fcm/send/a"));
  expect(await authorize(new URL("https://fcm.googleapis.com/fcm/send/b"))).toBe(fcm);
  const apple = await authorize(new URL("https://web.push.apple.com/c"));
  expect(apple).not.toBe(fcm);
  expect(sign).toHaveBeenCalledTimes(2);
  // The JWT's `aud` is the origin, so one serves every endpoint there.
  const audience = (authorization: string) =>
    JSON.parse(Buffer.from(/t=[^.]+\.([^.]+)\./.exec(authorization)![1], "base64url").toString()).aud;
  expect([audience(fcm), audience(apple)]).toEqual(["https://fcm.googleapis.com", "https://web.push.apple.com"]);
});

test("a send fits Workers Free's 50 subrequests, and no Wrangler config carries a VAPID key", () => {
  // One fetch per distinct subscription of the sending Burrow, and its two
  // database connections: the read, and the prune.
  expect(MAX_PUSH_SUBSCRIPTIONS_PER_BURROW + 2).toBeLessThanOrEqual(50);
  for (const name of NAMES)
    expect(Object.keys((wrangler[name] as { vars: object }).vars).filter((key) => /VAPID/.test(key)), name).toEqual([]);
});
