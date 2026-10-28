import { test, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono, type ExecutionContext } from "hono";
import { build } from "esbuild";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { readFileSync } from "node:fs";
import {
  API_ROUTES,
  MAX_PUSH_SEND_BODY_BYTES,
  MAX_REQUEST_BODY_BYTES,
  ONE_TIME_PAGE_PATH,
  ONE_TIME_WS_ROUTES,
  WS_ROUTES,
  pushSubscriptionDeletePath,
} from "remote-lib-common";
import {
  type AccountEnv,
  accountBindings,
  accountPreviewBindings,
  relayBindings,
  voiceBindings,
  voicePreviewBindings,
} from "../bindings";
import {
  ACCOUNT_POLICY,
  RUNS_NOTHING_POLICY,
  accountRules,
  relayRules,
  type RulesFor,
} from "../headers";
import { ADMIN_EMAIL } from "../entitlement";
import { accountApp } from "../account-app";
import { cookieEntitled, openAuthRead } from "../account-gate";
import { createAuthApp } from "@pgstencil/auth/better-auth";
import { authPolicy } from "../policy";
import { prelaunchAuth } from "../prelaunch";
import { BILLING_WEBHOOK_PATH, CHECKOUT_CLOSED } from "../billing-routes";
import { RECENT_LOGIN_REQUIRED, relayAccountRoutes } from "../relay-account";
import type { RelayRoomRpc } from "../relay-room-contract";
import { voiceApp } from "../voice-app";
import { workerApp } from "../worker-app";

// These gate tests run without a database: every login they present is
// entitled, read through the seam rather than a `"user"` row.
vi.mock(import("../entitlement"), async (actual) => ({
  ...(await actual()),
  entitled: async () => true,
}));
import {
  ENTRIES,
  NAMES,
  ORIGINS,
  alone,
  bundleWorker,
  miniflareOptions,
  testVapidKeys,
  type Name,
} from "./bundle";

// The partition between Hosted's three Workers (`docs/specs/hosted.md` ->
// "Application boundary"), each production bundle in real workerd without
// Postgres: nothing here gets past a 421, a 404, a missing bearer token, or a
// bodyless request, so no route reaches the database.

const sha = "a".repeat(40);

/** Every binding any Worker reads, given to each, so only its mapper decides. */
const everything = {
  BUILD_SHA: sha,
  AUTH_SECRET: "dormouse-test-secret-with-at-least-32-characters",
  EMAIL_FROM: "signin@example.test",
  POSTMARK_SERVER_TOKEN: "test-postmark-token",
  ELEVENLABS_API_KEY: "test-elevenlabs-key",
  OAUTH_PROVIDERS: "github",
  GITHUB_CLIENT_ID: "test-github-id",
  GITHUB_CLIENT_SECRET: "test-github-secret",
  RELAY_ENROLL_SECRET: "test-relay-enroll-secret",
  ...testVapidKeys(),
};

/** Billing's, which only the production account's mapper passes; never in {@link everything}, so billing stays closed. */
const STRIPE = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
  STRIPE_PRICE_MONTHLY: "price_m",
  STRIPE_PRICE_YEARLY: "price_y",
  STRIPE_PRICES_FOUNDING: "price_f",
};

const IMMUTABLE = "public, max-age=31536000, immutable";
const HASHED_FILES = ["/assets/app-B39o2E6i.js", `${ONE_TIME_PAGE_PATH}assets/page-B39o2E6i.js`];

/** Every request any Worker sent upstream. */
const outbound: string[] = [];
const workers = {} as Record<Name, Miniflare>;
const bundles = {} as Record<Name, Awaited<ReturnType<typeof bundleWorker>>>;

beforeAll(async () => {
  await Promise.all(
    NAMES.map(async (name) => {
      bundles[name] = await bundleWorker(ENTRIES[name]);
      workers[name] = new Miniflare(
        alone(name, miniflareOptions(name, bundles[name].outputFiles[0].text, {
          bindings: { ...everything, APP_ORIGIN: ORIGINS[name] },
          // Nothing listens here, so any database access would fail the request.
          hyperdrives: { HYPERDRIVE: "postgres://user:pass@127.0.0.1:9/none" },
          // Two content-hashed scripts, one under each Worker's prefix, and an
          // SPA fallback answering every other path, so a route that reached
          // the assets shows as a 200 rather than a 404.
          serviceBindings: {
            ASSETS: (request) =>
              HASHED_FILES.includes(new URL(request.url).pathname)
                ? new WorkerResponse("export {};", {
                    headers: { "content-type": "text/javascript" },
                  })
                : new WorkerResponse("<!doctype html>", {
                    headers: { "content-type": "text/html" },
                  }),
          },
          outboundService(request) {
            outbound.push(request.url);
            if (new URL(request.url).pathname === "/v1/history")
              return WorkerResponse.json({ history: [] });
            return new WorkerResponse("{}", { status: 500 });
          },
        })),
      );
      await workers[name].ready;
    }),
  );
});
afterAll(async () => {
  await Promise.all(NAMES.map((name) => workers[name]?.dispose()));
});

const send = (name: Name, url: string, method = "GET") =>
  workers[name].dispatchFetch(url, { method, redirect: "manual" });

/** The Relay's routes the account serves: approval, and its Burrows and passkeys. */
const ACCOUNT_RELAY: [string, string][] = [
  ["POST", "/api/relay/enrollments/approve"],
  ["GET", "/api/relay/enrollments/AAAA-AAAA"],
  ["GET", "/api/relay/burrows"],
  ["DELETE", "/api/relay/burrows/AAAAAAAAAAAAAAAAAAAAAA"],
  ["GET", "/api/relay/passkeys"],
  ["DELETE", "/api/relay/passkeys/AAAA"],
];

/** Billing's routes, which only the account serves. */
const ACCOUNT_BILLING: [string, string][] = [
  ["GET", "/api/billing"],
  ["POST", "/api/billing/checkout"],
  ["POST", "/api/billing/confirm"],
  ["POST", "/api/billing/portal"],
  ["POST", BILLING_WEBHOOK_PATH],
];

/** A route each Worker serves, as method and path. */
const SERVED: Record<Name, [string, string][]> = {
  account: [
    ["GET", "/api/auth/csrf"],
    ["GET", "/api/providers"],
    ["GET", "/api/voice"],
    ["DELETE", "/api/voice"],
    ...ACCOUNT_RELAY,
    ...ACCOUNT_BILLING,
    ["GET", "/login"],
  ],
  relay: [
    ["GET", ONE_TIME_WS_ROUTES.burrow],
    ["GET", ONE_TIME_WS_ROUTES.client],
    ["GET", ONE_TIME_PAGE_PATH],
    ["GET", WS_ROUTES.burrow],
    ["GET", WS_ROUTES.client],
    ["POST", API_ROUTES.setupBegin],
    ["POST", API_ROUTES.signinBegin],
    ["GET", API_ROUTES.burrows],
    ["POST", API_ROUTES.burrowSetupToken],
    ["POST", API_ROUTES.burrowEnrollBegin],
    ["POST", API_ROUTES.burrowEnrollPoll],
    ["GET", API_ROUTES.pushConfig],
    ["POST", API_ROUTES.pushSend],
    ["GET", "/"],
  ],
  voice: [
    ["POST", "/api/voice/speak"],
    ["DELETE", "/api/voice/token"],
  ],
};

/** The Hosted Relay's routes, which only the relay serves. */
const RELAY_API: [string, string][] = [
  ["POST", API_ROUTES.setupBegin],
  ["POST", API_ROUTES.setupFinish],
  ["POST", API_ROUTES.setupRetire],
  ["POST", API_ROUTES.signinBegin],
  ["POST", API_ROUTES.signinFinish],
  ["POST", API_ROUTES.reauthBegin],
  ["POST", API_ROUTES.reauthFinish],
  ["GET", API_ROUTES.burrows],
  ["POST", API_ROUTES.burrowSetupToken],
  ["POST", API_ROUTES.burrowEnroll],
  ["GET", API_ROUTES.pushConfig],
  ["POST", API_ROUTES.pushSubscribe],
  ["POST", API_ROUTES.pushSubscriptionsQuery],
  ["DELETE", pushSubscriptionDeletePath("A".repeat(43))],
  ["GET", API_ROUTES.pushDevices],
  ["POST", API_ROUTES.pushSend],
];

test.for(NAMES)(
  "%s: a foreign origin, each sibling's included, is refused with 421 before any route",
  async (name) => {
    const foreign = [
      ...NAMES.filter((other) => other !== name).map((other) => ORIGINS[other]),
      "https://dormouse.sh",
      `http://${new URL(ORIGINS[name]).host}`,
    ];
    for (const origin of foreign)
      for (const [method, path] of [...SERVED[name], ["GET", "/api/health"], ["GET", "/api/ready"]]) {
        const response = await send(name, origin + path, method);
        expect(response.status, `${method} ${origin}${path}`).toBe(421);
      }
    const health = await send(name, ORIGINS[name] + "/api/health");
    expect(await health.json()).toEqual({ ok: true, revision: sha });
  },
);

/** What each Worker must not serve: every other Worker's routes, and anything unknown. */
const ABSENT: Record<Name, [string, string][]> = {
  account: [
    ["GET", ONE_TIME_WS_ROUTES.burrow],
    ["GET", ONE_TIME_WS_ROUTES.client],
    ["POST", "/api/voice/speak"],
    ["DELETE", "/api/voice/token"],
    ...RELAY_API,
  ],
  relay: [
    ["GET", "/api/auth/csrf"],
    ["GET", "/api/auth/get-session"],
    ["POST", "/api/auth/sign-out"],
    ["GET", "/api/providers"],
    ["GET", "/api/voice"],
    ["DELETE", "/api/voice"],
    ...ACCOUNT_RELAY,
    ...ACCOUNT_BILLING,
    ["POST", "/api/voice/speak"],
    ["DELETE", "/api/voice/token"],
    // The self-host installers' probe; neither a Burrow nor Pocket asks Hosted for it.
    ["GET", "/api/hello"],
    // The non-page prefixes 404 whole.
    ["GET", "/ws/other"],
    ["GET", "/api"],
    ["GET", "/ws"],
  ],
  voice: [
    ["GET", "/api/auth/csrf"],
    ["GET", "/api/auth/get-session"],
    ["GET", "/api/providers"],
    ["GET", "/api/voice"],
    ["DELETE", "/api/voice"],
    ["GET", "/api/voice/speak"],
    ["GET", ONE_TIME_WS_ROUTES.burrow],
    ["GET", ONE_TIME_PAGE_PATH],
    ["GET", "/"],
    ["GET", "/login"],
    ...RELAY_API,
    ...ACCOUNT_RELAY,
    ...ACCOUNT_BILLING,
    ["GET", WS_ROUTES.burrow],
    ["GET", WS_ROUTES.client],
  ],
};

test.for(NAMES)("%s: serves only its own routes", async (name) => {
  for (const [method, path] of ABSENT[name]) {
    const response = await send(name, ORIGINS[name] + path, method);
    expect(response.status, `${method} ${path}`).toBe(404);
    expect(
      response.headers.get("content-security-policy"),
      `${method} ${path}`,
    ).toBe(name === "account" ? ACCOUNT_POLICY : RUNS_NOTHING_POLICY);
  }
  expect(outbound).toEqual([]);
});

test("without Stripe bindings the account's webhook is closed before any database or Stripe request", async () => {
  const response = await workers.account.dispatchFetch(ORIGINS.account + BILLING_WEBHOOK_PATH, {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=00", "content-type": "application/json" },
    body: "{}",
  });
  expect([response.status, await response.json()]).toEqual([503, { message: CHECKOUT_CLOSED }]);
  expect(response.headers.get("content-security-policy")).toBe(ACCOUNT_POLICY);
  expect(outbound).toEqual([]);
});

test("the account answers /connect/ with its own shell and policy, never the phone page", async () => {
  for (const path of [ONE_TIME_PAGE_PATH, `${ONE_TIME_PAGE_PATH}assets/x.js`]) {
    const response = await send("account", ORIGINS.account + path);
    expect(response.headers.get("content-security-policy"), path).toBe(
      ACCOUNT_POLICY,
    );
  }
});

test("readiness without a database binding is down, saying nothing more", async () => {
  const app = workerApp({
    bindings: (env) => env,
    rules: relayRules,
    ready: "SELECT 1 LIMIT 0",
    unavailable: "unavailable",
    routes: () => {},
  });
  const response = await app.fetch(new Request(ORIGINS.relay + "/api/ready"), {
    APP_ORIGIN: ORIGINS.relay,
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ ok: false });
});

test("each Worker caches only its own hashed assets as immutable", async () => {
  const [pocket, phone] = HASHED_FILES;
  const cache = (response: { headers: { get(name: string): string | null } }) =>
    response.headers.get("cache-control");
  expect(cache(await send("account", ORIGINS.account + pocket))).toBe(IMMUTABLE);
  expect(cache(await send("account", ORIGINS.account + phone))).toBe("no-store");
  expect(cache(await send("relay", ORIGINS.relay + pocket))).toBe(IMMUTABLE);
  expect(cache(await send("relay", ORIGINS.relay + phone))).toBe(IMMUTABLE);
  // Each Worker's rules, checked on an app that serves a script at every path.
  const serving = (rules: RulesFor) =>
    workerApp({
      bindings: (env) => env,
      rules,
      nonPagePrefixes: [],
      unavailable: "",
      routes: (app) =>
        app.get("*", () =>
          new Response("export {};", { headers: { "content-type": "text/javascript" } }),
        ),
    });
  const env = { APP_ORIGIN: ORIGINS.relay };
  const relay = serving(relayRules);
  for (const path of [pocket, phone, "/%61ssets/app-B39o2E6i.js", "/assets/pocket-private-key-ChSkpulJ.js"])
    expect(cache(await relay.fetch(new Request(ORIGINS.relay + path), env)), path).toBe(IMMUTABLE);
  // A name without the content hash can change in place, so it is cached as its path otherwise is.
  for (const path of ["/sw.js", "/assets/plain.js", "/assets/app-B39o2E6.js"])
    expect(cache(await relay.fetch(new Request(ORIGINS.relay + path), env)), path).toBe("no-cache");
  for (const path of ["/connect/x.js", `${ONE_TIME_PAGE_PATH}assets/plain.js`, "/api/assets/x.js", "/ws/assets/x.js"])
    expect(cache(await relay.fetch(new Request(ORIGINS.relay + path), env)), path).toBe("no-store");
  const account = serving(accountRules);
  const accountEnv = { APP_ORIGIN: ORIGINS.account };
  expect(cache(await account.fetch(new Request(ORIGINS.account + pocket), accountEnv))).toBe(IMMUTABLE);
  for (const path of [phone, "/assets/plain.js"])
    expect(cache(await account.fetch(new Request(ORIGINS.account + path), accountEnv)), path).toBe("no-store");
});

test("speak and a token's own delete are the voice Worker's, bearer-only", async () => {
  for (const [method, path] of SERVED.voice) {
    const response = await send("voice", ORIGINS.voice + path, method);
    expect(response.status, `${method} ${path}`).toBe(401);
    expect(response.headers.get("content-security-policy")).toBe(
      RUNS_NOTHING_POLICY,
    );
  }
});

test("the local development entry serves no speak", async () => {
  // A Hosted build speaks only at the fixed voice origin, so a local speak
  // would be unreachable; the bundle keeps only what the entry mounts.
  const {
    outputFiles: [dev],
  } = await build({
    entryPoints: ["server/dev.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    packages: "external",
  });
  expect(dev.text).toContain('"/api/voice"');
  expect(dev.text).not.toContain("/api/voice/speak");
  expect(dev.text).not.toContain("/api/voice/token");
  expect(dev.text).not.toContain("api.elevenlabs.io");
});

test("the ElevenLabs history sweep runs on the voice Worker alone", async () => {
  outbound.length = 0;
  for (const name of ["account", "relay"] as const) {
    // Without @cloudflare/workers-types, the Fetcher's scheduled() is untyped.
    const fetcher = (await workers[name].getWorker()) as unknown as {
      scheduled(options: { cron: string }): Promise<{ outcome: string }>;
    };
    await fetcher.scheduled({ cron: "*/5 * * * *" }).catch(() => undefined);
    expect(outbound, name).toEqual([]);
  }
  const voice = (await workers.voice.getWorker()) as unknown as {
    scheduled(options: { cron: string }): Promise<{ outcome: string }>;
  };
  expect((await voice.scheduled({ cron: "*/5 * * * *" })).outcome).toBe("ok");
  expect(outbound).toEqual([
    "https://api.elevenlabs.io/v1/history?page_size=40",
  ]);
  outbound.length = 0;
});

test("the cron handler gets the mapped bindings: a key the mapper drops never sweeps", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ history: [] }));
  try {
    const env = {
      APP_ORIGIN: ORIGINS.voice,
      HYPERDRIVE: { connectionString: "postgres://example.test/none" },
      ELEVENLABS_API_KEY: "test-elevenlabs-key",
    };
    const ctx = {} as ExecutionContext;
    await voiceApp(voicePreviewBindings).scheduled!({}, env, ctx);
    expect(fetch).not.toHaveBeenCalled();
    // The production mapper passes the same key on, and it sweeps.
    await voiceApp(voiceBindings).scheduled!({}, env, ctx);
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    fetch.mockRestore();
  }
});

test("each bindings mapper passes only what its Worker uses", () => {
  const env = {
    ...everything,
    APP_ORIGIN: "https://example.test",
    HYPERDRIVE: { connectionString: "postgres://example.test/none" },
    ASSETS: { fetch: async () => new Response() },
    ONE_TIME_ROOM: {} as DurableObjectNamespace,
    RELAY_ROOM: {} as DurableObjectNamespace<RelayRoomRpc>,
    ONE_TIME_MINT_LIMIT: {} as RateLimit,
    ONE_TIME_JOIN_LIMIT: {} as RateLimit,
    RELAY_SIGNIN_LIMIT: {} as RateLimit,
    RELAY_SETUP_LIMIT: {} as RateLimit,
    RELAY_ENROLL_BEGIN_LIMIT: {} as RateLimit,
    RELAY_ENROLL_POLL_LIMIT: {} as RateLimit,
    RELAY_APPROVE_LIMIT: {} as RateLimit,
    ACCOUNT_ORIGIN: "https://account.example.test",
    ...STRIPE,
  };
  const keys = (bindings: object) => Object.keys(bindings).sort();
  expect(keys(accountBindings(env))).toEqual(
    [
      "APP_ORIGIN",
      "ASSETS",
      "AUTH_SECRET",
      "BUILD_SHA",
      "EMAIL_FROM",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "HYPERDRIVE",
      "POSTMARK_SERVER_TOKEN",
      "RELAY_APPROVE_LIMIT",
      "RELAY_ROOM",
      ...Object.keys(STRIPE),
    ].sort(),
  );
  expect(accountPreviewBindings(env)).toEqual({
    APP_ORIGIN: env.APP_ORIGIN,
    ASSETS: env.ASSETS,
    RELAY_APPROVE_LIMIT: env.RELAY_APPROVE_LIMIT,
    RELAY_ROOM: env.RELAY_ROOM,
    AUTH_SECRET: env.AUTH_SECRET,
    BUILD_SHA: sha,
    HYPERDRIVE: env.HYPERDRIVE,
    EMAIL_FROM: "",
    POSTMARK_SERVER_TOKEN: "",
  });
  // No auth secret: the Relay reads its own tables and a user row, never a login.
  expect(keys(relayBindings(env))).toEqual(
    [
      "ACCOUNT_ORIGIN",
      "APP_ORIGIN",
      "ASSETS",
      "BUILD_SHA",
      "HYPERDRIVE",
      "ONE_TIME_JOIN_LIMIT",
      "ONE_TIME_MINT_LIMIT",
      "ONE_TIME_ROOM",
      "RELAY_ENROLL_BEGIN_LIMIT",
      "RELAY_ENROLL_POLL_LIMIT",
      "RELAY_ENROLL_SECRET",
      "RELAY_ROOM",
      "RELAY_SETUP_LIMIT",
      "RELAY_SIGNIN_LIMIT",
      "RELAY_VAPID_PRIVATE_KEY",
      "RELAY_VAPID_PUBLIC_KEY",
    ].sort(),
  );
  // `ACCOUNT_ORIGIN` reaches the routes exactly an origin, or not at all.
  expect(relayBindings(env).ACCOUNT_ORIGIN).toBe(env.ACCOUNT_ORIGIN);
  for (const loose of [
    "https://account.example.test/",
    "https://account.example.test/enroll",
    "https://account.example.test\nX: y",
    "javascript:alert(1)",
    "",
    undefined,
  ])
    expect(relayBindings({ ...env, ACCOUNT_ORIGIN: loose }).ACCOUNT_ORIGIN, String(loose)).toBeUndefined();
  // No auth secret: speak reads the token's owner, never a login.
  expect(keys(voiceBindings(env))).toEqual(
    ["APP_ORIGIN", "BUILD_SHA", "ELEVENLABS_API_KEY", "HYPERDRIVE"].sort(),
  );
  expect(keys(voicePreviewBindings(env))).toEqual(
    ["APP_ORIGIN", "BUILD_SHA", "HYPERDRIVE"].sort(),
  );
});

test("the relay answers its VAPID key, and push routes gate on a bearer before the database", async () => {
  const relay = ORIGINS.relay;
  const config = await send("relay", relay + API_ROUTES.pushConfig);
  expect(await config.json()).toEqual({
    applicationServerKey: everything.RELAY_VAPID_PUBLIC_KEY,
  });
  for (const [method, path] of RELAY_API.filter(([, path]) => path.startsWith("/api/push/")))
    if (path !== API_ROUTES.pushConfig)
      expect((await send("relay", relay + path, method)).status, `${method} ${path}`).toBe(401);
  expect(outbound).toEqual([]);
});

test("only the push send outgrows the request body bound, and only to its derived bound", async () => {
  const post = (path: string, bytes: number) =>
    workers.relay.dispatchFetch(ORIGINS.relay + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(bytes),
    });
  // Past the general bound, a send reaches its Burrow-token gate; anything else is 413.
  expect((await post(API_ROUTES.pushSend, MAX_REQUEST_BODY_BYTES + 1)).status).toBe(401);
  expect((await post(API_ROUTES.pushSubscribe, MAX_REQUEST_BODY_BYTES + 1)).status).toBe(413);
  expect((await post(API_ROUTES.pushSend, MAX_PUSH_SEND_BODY_BYTES + 1)).status).toBe(413);
  expect(MAX_PUSH_SEND_BODY_BYTES).toBeGreaterThan(MAX_REQUEST_BODY_BYTES);
});

test("neither the relay nor the voice bundle carries Better Auth or billing", async () => {
  const pattern = /better-auth|postmark|stripe|server\/billing/;
  for (const [entry, bundle] of [
    [ENTRIES.relay, bundles.relay],
    [ENTRIES.voice, bundles.voice],
    ["server/voice-preview-worker.ts", await bundleWorker("server/voice-preview-worker.ts")],
  ] as const) {
    const inputs = Object.keys(bundle.metafile.inputs);
    expect(
      inputs.filter((input) => pattern.test(input)),
      entry,
    ).toEqual([]);
  }
  // The pattern finds each where it is.
  const account = Object.keys(bundles.account.metafile.inputs);
  for (const name of ["better-auth", "@pgstencil/stripe", "node_modules/stripe/", "server/billing.ts"])
    expect(account.filter((input) => pattern.test(input) && input.includes(name)), name).not.toEqual([]);
});

test("the relay bundle reads no cookie and never asks auth", () => {
  const inputs = Object.keys(bundles.relay.metafile.inputs);
  expect(inputs.filter((input) => /cookie/.test(input))).toEqual([]);
  // Its own modules: no cookie header, helper, or auth route in any code line.
  const ours = inputs.filter((input) => input.startsWith("server/"));
  expect(ours).toContain("server/relay-api.ts");
  for (const input of ours) {
    const code = readFileSync(input, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(code, input).not.toMatch(/["'`]cookie["'`]|getCookie|\.cookie\b|\/api\/auth\//i);
  }
  // The pattern finds it where it is.
  expect(readFileSync("server/account-gate.ts", "utf8")).toMatch(/["'`]cookie["'`]/);
});

/** Every state-changing Better Auth route the packed adapter admits. */
const AUTH_WRITES = [
  "/email-otp/send-verification-otp",
  "/sign-in/email-otp",
  "/sign-in/social",
  "/link-social",
  "/sign-out",
];

/** The account's CSRF cookie and the token a page sends beside it. */
async function csrfChallenge() {
  const issued = await send("account", ORIGINS.account + "/api/auth/csrf");
  const { csrf } = (await issued.json()) as { csrf: string };
  return { csrfCookie: issued.headers.get("set-cookie")!.split(";")[0]!, csrf };
}

test("an auth write carrying the login cookie needs the account's own Origin and the CSRF token", async () => {
  // `/api/auth/*` writes go straight to the packed adapter (`accountApp`), so
  // its gate is the one between another site and the victim's login. Each refusal
  // comes before Better Auth runs, so none reaches the database.
  const account = ORIGINS.account;
  const { csrfCookie, csrf } = await csrfChallenge();
  expect(csrfCookie).toMatch(/^__Host-pgstencil\.csrf=/);
  const post = (path: string, headers: Record<string, string>) =>
    workers.account.dispatchFetch(`${account}/api/auth${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: `__Host-pgstencil.session_token=victim; ${csrfCookie}`,
        "content-type": "application/json",
        ...headers,
      },
      body: "{}",
    });
  const foreign = [
    ...NAMES.filter((name) => name !== "account").map((name) => ORIGINS[name]),
    "https://dormouse.sh",
    "https://attacker.example",
    "null",
  ];
  for (const path of AUTH_WRITES) {
    for (const origin of foreign)
      expect((await post(path, { origin, "x-csrf-token": csrf })).status, `${origin} ${path}`).toBe(403);
    expect((await post(path, { "x-csrf-token": csrf })).status, `no Origin ${path}`).toBe(403);
    expect((await post(path, { origin: account })).status, `no token ${path}`).toBe(403);
    expect((await post(path, { origin: account, "x-csrf-token": "0".repeat(64) })).status, `wrong token ${path}`).toBe(403);
    // A CORS-safelisted type is what a form or an unpreflighted fetch could send.
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"])
      expect((await post(path, { origin: account, "x-csrf-token": csrf, "content-type": type })).status, `${type} ${path}`).toBe(415);
    // A GET is no write: without Fetch Metadata, the read gate refuses it first.
    expect((await send("account", `${account}/api/auth${path}`)).status, `GET ${path}`).toBe(403);
  }
  // Better Auth's other state-changing endpoints are not served at all.
  for (const path of ["/update-user", "/delete-user", "/change-email", "/unlink-account", "/revoke-session", "/revoke-sessions", "/revoke-other-sessions", "/sign-in/email", "/sign-up/email"])
    expect((await post(path, { origin: account, "x-csrf-token": csrf })).status, path).toBe(404);
  expect(outbound).toEqual([]);
});

test("auth reads answer only the account's own page; writes, callbacks, and the CSRF challenge pass untouched", async () => {
  // The packed adapter admits `get-session` and `list-accounts` whatever their
  // `Origin`; `accountApp` refuses every auth request but a POST, a callback,
  // or `/csrf` that the account's own page did not send, a read the adapter
  // does not serve (yet) included. Without a database, a request the gate
  // admits fails inside the handler (5xx).
  const account = ORIGINS.account;
  const cookie = "__Host-pgstencil.session_token=victim";
  const fetch = (path: string, headers: Record<string, string>, method = "GET", body?: string) =>
    workers.account.dispatchFetch(account + path, { method, redirect: "manual", headers, body });
  const refused: ({ what: string } & Record<string, string>)[] = [
    { what: "no Fetch Metadata" },
    { what: "a typed URL", "sec-fetch-site": "none" },
    ...NAMES.filter((name) => name !== "account").map((name) => ({
      what: `the ${name} origin`,
      "sec-fetch-site": "same-site",
      origin: ORIGINS[name],
    })),
    { what: "an unlisted sibling", "sec-fetch-site": "same-site", origin: "https://dormouse.sh" },
    { what: "another site", "sec-fetch-site": "cross-site", origin: "https://attacker.example" },
    { what: "another site, navigating", "sec-fetch-site": "cross-site" },
    // Only a non-browser can forge Fetch Metadata; it still cannot name another Origin.
    { what: "a forged same-origin", "sec-fetch-site": "same-origin", origin: ORIGINS.relay },
    { what: "a forged same-origin, opaque", "sec-fetch-site": "same-origin", origin: "null" },
  ];
  const reads = ["/api/auth/get-session", "/api/auth/list-accounts"];
  for (const path of [...reads, "/api/auth/list-sessions"])
    for (const { what, ...headers } of refused)
      for (const method of ["GET", "HEAD", "DELETE"]) {
        const response = await fetch(path, { cookie, ...headers }, method);
        expect(response.status, `${method} ${path} from ${what}`).toBe(403);
        if (method !== "HEAD") expect(await response.json()).toEqual({ message: "Invalid origin." });
      }
  for (const path of reads) {
    // The account's own page, fetching: `Origin` absent (a GET) or exactly its own.
    for (const origin of [undefined, account]) {
      const headers = { cookie, "sec-fetch-site": "same-origin", ...(origin && { origin }) };
      expect((await fetch(path, headers)).status, `${path} from ${origin}`).toBeGreaterThanOrEqual(500);
    }
  }
  // Writes keep the adapter's own rules, Fetch Metadata or none; any page may
  // start from the CSRF challenge.
  const { csrfCookie, csrf } = await csrfChallenge();
  const write = { cookie: `${cookie}; ${csrfCookie}`, origin: account, "x-csrf-token": csrf, "content-type": "application/json" };
  expect((await fetch("/api/auth/sign-out", write, "POST", "{}")).status).toBeGreaterThanOrEqual(500);
  // A provider's callback arrives from its own site, carrying the login for a
  // connection; neither it nor the CSRF challenge nor the provider list is
  // looked up pre-launch, which without a database would fail them (5xx).
  const callback = await fetch("/api/auth/callback/github?code=x&state=y", { cookie, "sec-fetch-site": "cross-site" });
  expect(callback.status).toBe(303);
  const sibling = { cookie, "sec-fetch-site": "same-site", origin: ORIGINS.relay };
  expect((await fetch("/api/auth/csrf", sibling)).status).toBe(200);
  const providers = await fetch("/api/providers", sibling);
  expect(providers.status).toBe(200);
  expect(await providers.json()).toEqual(["github"]);
  const apple = await fetch("/api/auth/callback/apple", {
    "sec-fetch-site": "cross-site",
    origin: "https://appleid.apple.com",
    "content-type": "application/x-www-form-urlencoded",
  }, "POST", "code=x&state=y");
  expect(apple.status).toBeGreaterThanOrEqual(500);
  expect(outbound).toEqual([]);
});

test("pre-launch looks a login up for every read the account's own page made, and only then", async () => {
  const origin = "https://account.example.test";
  const seen: string[] = [];
  const auth = prelaunchAuth(async (request) => {
    seen.push(new URL(request.url).pathname);
    return Response.json(null);
  });
  const env = { HYPERDRIVE: { connectionString: "postgres://user:pass@127.0.0.1:9/none" } } as AccountEnv;
  const send = (path: string, headers: Record<string, string> = {}, method = "GET") => {
    seen.length = 0;
    return auth(new Request(origin + path, { method, headers: { cookie: "session=victim", ...headers } }), env, {} as ExecutionContext);
  };
  // Any read carrying a login is refused before any lookup unless the page
  // made it, however the path is spelled and whether or not the adapter serves it.
  const reads = ["/api/auth/get-session", "/api/auth/list-sessions", "/api/auth/list%2Dsessions", "/api/auth/account-info", "/api/providers"];
  for (const path of reads)
    for (const method of ["GET", "HEAD", "DELETE"])
      for (const headers of <Record<string, string>[]>[{}, { "sec-fetch-site": "same-site", origin: "https://relay.example.test" }, { "sec-fetch-site": "same-origin", origin: "null" }]) {
        expect((await send(path, headers, method)).status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(403);
        expect(seen, path).toEqual([]);
      }
  // The page's read, or a cookie route's lookup: looked up, then answered.
  for (const path of ["/api/auth/get-session", "/api/auth/account-info"]) {
    expect((await send(path, { "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect(seen).toEqual(["/api/auth/get-session", path]);
  }
  // A provider callback, the CSRF challenge, and a write go straight through,
  // cookie and all, with no lookup.
  for (const [path, method] of [
    ["/api/auth/callback/github", "GET"],
    ["/api/auth/%63srf", "GET"],
    ["/api/auth/callback/apple", "POST"],
    ["/api/auth/sign-out", "POST"],
  ]) {
    await send(path, { "sec-fetch-site": "cross-site" }, method);
    expect(seen, path).toEqual([path]);
  }
});

test("every GET the installed Better Auth serves is gated and looked up pre-launch, a provider callback alone excepted", async () => {
  const built = createAuthApp({
    ...authPolicy,
    databaseUrl: "postgres://user:pass@127.0.0.1:9/none",
    origin: ORIGINS.account,
    secret: everything.AUTH_SECRET,
    email: { send: async () => {} } as never,
  });
  const endpoints = Object.values(built.auth.api as Record<string, { path?: string; options?: { method?: string | string[] } }>);
  await built.close();
  const gets = endpoints.flatMap(({ path, options }) =>
    path && [options?.method].flat().includes("GET") ? ["/api/auth" + path.replace(/:\w+/g, "x")] : [],
  );
  // The enumeration finds the reads the adapter does not serve today.
  expect(gets).toEqual(expect.arrayContaining(["/api/auth/get-session", "/api/auth/list-sessions", "/api/auth/account-info"]));
  const cookie = "__Host-pgstencil.session_token=victim";
  for (const path of gets) {
    const read = (headers: Record<string, string>) =>
      workers.account.dispatchFetch(ORIGINS.account + path, { redirect: "manual", headers: { cookie, ...headers } });
    const sibling = (await read({ "sec-fetch-site": "same-site", origin: ORIGINS.relay })).status;
    // Without a database, a looked-up login fails the request (5xx).
    const own = (await read({ "sec-fetch-site": "same-origin" })).status;
    if (openAuthRead(path)) {
      expect(path).toMatch(/^\/api\/auth\/callback\//);
      expect(sibling, path).not.toBe(403);
      expect(own, path).toBeLessThan(500);
    } else {
      expect(sibling, path).toBe(403);
      expect(own, path).toBeGreaterThanOrEqual(500);
    }
  }
});

test("the provider list never carries the login cookie to the auth handler", async () => {
  const cookies: (string | null)[] = [];
  const app = accountApp(async (request) => {
    cookies.push(request.headers.get("cookie"));
    return Response.json([]);
  }, (env) => env);
  const response = await app.fetch(
    new Request(ORIGINS.account + "/api/providers", {
      headers: { cookie: "session=victim", "sec-fetch-site": "same-site", origin: ORIGINS.relay },
    }),
    { APP_ORIGIN: ORIGINS.account } as AccountEnv,
    {} as ExecutionContext,
  );
  expect(response.status).toBe(200);
  expect(cookies).toEqual([null]);
});

test("the cookie gate refuses a foreign Origin on every method, and a read the account's page did not make", async () => {
  const origin = "https://account.example.test";
  const app = new Hono();
  const gate = cookieEntitled(
    () => ({
      databaseUrl: "postgres://user:pass@127.0.0.1:9/none",
      auth: async () =>
        Response.json({ user: { id: "admin" }, session: {} }),
    }),
    () => new Response(null, { status: 403 }),
  );
  app.on(["GET", "HEAD", "POST"], "/gated", gate, (c) => c.body(null, 204));
  const sibling = "https://relay.example.test";
  const own = { "sec-fetch-site": "same-origin" };
  for (const method of ["GET", "HEAD", "POST"]) {
    const send = (headers: Record<string, string>) =>
      app.request(`${origin}/gated`, { method, headers });
    const read = method !== "POST";
    expect((await send({ ...own, origin: sibling })).status, method).toBe(403);
    expect((await send({ ...own, origin: "null" })).status, method).toBe(403);
    expect((await send({ ...own, origin })).status, method).toBe(204);
    // Only a read may omit `Origin`, and only a read needs Fetch Metadata.
    expect((await send(own)).status, method).toBe(read ? 204 : 403);
    expect((await send({ origin })).status, method).toBe(read ? 403 : 204);
    for (const site of ["same-site", "none", "cross-site"])
      expect((await send({ "sec-fetch-site": site })).status, `${method} ${site}`).toBe(403);
  }
});

test("the cookie gate needs no login creation time; approval reads it and fails closed", async () => {
  // `get-session` as the packed adapter answers it, `createdAt` as given.
  const host = (createdAt?: unknown) => () => ({
    databaseUrl: "postgres://user:pass@127.0.0.1:9/none",
    auth: async () =>
      Response.json({
        user: { id: "admin" },
        session: createdAt === undefined ? {} : { createdAt },
      }),
    approveLimit: {
      limit: async () => {
        throw new Error("The limit is past the recent-login check");
      },
    } as RateLimit,
    closeBurrow: async () => {
      throw new Error("No approval removes a Burrow");
    },
  });
  const origin = "https://account.example.test";
  // The voice-token routes' gate admits an entitled login whatever `createdAt` says.
  for (const createdAt of [undefined, "garbage", new Date().toISOString()]) {
    const app = new Hono();
    app.get("/gated", cookieEntitled(host(createdAt), () => new Response(null, { status: 403 })), (c) =>
      c.json(c.get("login").userId),
    );
    const response = await app.request(`${origin}/gated`, {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(response.status, String(createdAt)).toBe(200);
    expect(await response.json()).toBe("admin");
  }
  // Approval refuses a login it cannot date, before the limit or the database.
  for (const createdAt of [undefined, "garbage", null, new Date(Date.now() - 11 * 60_000).toISOString()]) {
    const app = new Hono();
    relayAccountRoutes(app, host(createdAt));
    const response = await app.request(`${origin}/api/relay/enrollments/approve`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ userCode: "ZZZZ-ZZZZ", confirmDigits: "00" }),
    });
    expect(response.status, String(createdAt)).toBe(403);
    expect(await response.json()).toEqual({ message: RECENT_LOGIN_REQUIRED });
  }
});
