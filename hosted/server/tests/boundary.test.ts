import { test, expect, beforeAll, afterAll, vi } from "vitest";
import type { ExecutionContext } from "hono";
import { build } from "esbuild";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { ONE_TIME_PAGE_PATH, ONE_TIME_WS_ROUTES } from "remote-lib-common";
import {
  accountBindings,
  accountPreviewBindings,
  relayBindings,
  voiceBindings,
  voicePreviewBindings,
} from "../bindings";
import {
  ACCOUNT_POLICY,
  RELAY_HASHED_ASSETS,
  RUNS_NOTHING_POLICY,
} from "../headers";
import { voiceApp } from "../voice-app";
import { workerApp } from "../worker-app";
import {
  ENTRIES,
  NAMES,
  ORIGINS,
  bundleWorker,
  miniflareOptions,
  type Name,
} from "./bundle";

// The partition between Hosted's three Workers (`docs/specs/hosted.md` ->
// "Application boundary"), each production bundle in real workerd without
// Postgres: nothing here gets past a 421, a 404, or a missing bearer token, so
// no route reaches the database.

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
};

const IMMUTABLE = "public, max-age=31536000, immutable";
const HASHED_FILES = ["/assets/app-abc123.js", `${ONE_TIME_PAGE_PATH}assets/page-abc123.js`];

/** Every request any Worker sent upstream. */
const outbound: string[] = [];
const workers = {} as Record<Name, Miniflare>;
const bundles = {} as Record<Name, Awaited<ReturnType<typeof bundleWorker>>>;

beforeAll(async () => {
  await Promise.all(
    NAMES.map(async (name) => {
      bundles[name] = await bundleWorker(ENTRIES[name]);
      workers[name] = new Miniflare(
        miniflareOptions(name, bundles[name].outputFiles[0].text, {
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
        }),
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

/** A route each Worker serves, as method and path. */
const SERVED: Record<Name, [string, string][]> = {
  account: [
    ["GET", "/api/auth/csrf"],
    ["GET", "/api/providers"],
    ["GET", "/api/voice/tokens"],
    ["POST", "/api/voice/tokens"],
    ["GET", "/login"],
  ],
  relay: [
    ["GET", ONE_TIME_WS_ROUTES.burrow],
    ["GET", ONE_TIME_WS_ROUTES.client],
    ["GET", ONE_TIME_PAGE_PATH],
  ],
  voice: [["POST", "/api/voice/speak"]],
};

test.for(NAMES)(
  "%s: a foreign origin, each sibling's included, is refused with 421 before any route",
  async (name) => {
    const foreign = [
      ...NAMES.filter((other) => other !== name).map((other) => ORIGINS[other]),
      "https://dormouse.sh",
      `http://${new URL(ORIGINS[name]).host}`,
    ];
    for (const origin of foreign)
      for (const [method, path] of [...SERVED[name], ["GET", "/api/health"]]) {
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
  ],
  relay: [
    ["GET", "/api/auth/csrf"],
    ["GET", "/api/auth/get-session"],
    ["POST", "/api/auth/sign-out"],
    ["GET", "/api/providers"],
    ["GET", "/api/ready"],
    ["GET", "/api/voice/tokens"],
    ["POST", "/api/voice/tokens"],
    ["DELETE", "/api/voice/tokens/00000000-0000-4000-8000-000000000000"],
    ["POST", "/api/voice/speak"],
    ["GET", "/"],
    ["GET", "/login"],
    ["GET", "/account"],
    ["GET", "/assets/app-abc123.js"],
  ],
  voice: [
    ["GET", "/api/auth/csrf"],
    ["GET", "/api/auth/get-session"],
    ["GET", "/api/providers"],
    ["GET", "/api/ready"],
    ["GET", "/api/voice/tokens"],
    ["POST", "/api/voice/tokens"],
    ["GET", "/api/voice/speak"],
    ["GET", ONE_TIME_WS_ROUTES.burrow],
    ["GET", ONE_TIME_PAGE_PATH],
    ["GET", "/"],
    ["GET", "/login"],
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

test("the account answers /connect/ with its own shell and policy, never the phone page", async () => {
  for (const path of [ONE_TIME_PAGE_PATH, `${ONE_TIME_PAGE_PATH}assets/x.js`]) {
    const response = await send("account", ORIGINS.account + path);
    expect(response.headers.get("content-security-policy"), path).toBe(
      ACCOUNT_POLICY,
    );
  }
});

test("each Worker caches only its own hashed assets as immutable", async () => {
  const [account, phone] = HASHED_FILES;
  const cache = (response: { headers: { get(name: string): string | null } }) =>
    response.headers.get("cache-control");
  expect(cache(await send("account", ORIGINS.account + account))).toBe(IMMUTABLE);
  expect(cache(await send("account", ORIGINS.account + phone))).toBe("no-store");
  // The relay hands its assets only `/connect/` paths, so its prefixes are
  // checked on an app that serves a script at both.
  const relay = workerApp({
    bindings: (env) => env,
    policy: () => RUNS_NOTHING_POLICY,
    hashedAssets: RELAY_HASHED_ASSETS,
    unavailable: "",
    routes: (app) =>
      app.get("*", () =>
        new Response("export {};", { headers: { "content-type": "text/javascript" } }),
      ),
  });
  const env = { APP_ORIGIN: ORIGINS.relay };
  expect(cache(await relay.fetch(new Request(ORIGINS.relay + phone), env))).toBe(IMMUTABLE);
  expect(cache(await relay.fetch(new Request(ORIGINS.relay + account), env))).toBe("no-store");
});

test("speak is the voice Worker's, bearer-only", async () => {
  const response = await send("voice", ORIGINS.voice + "/api/voice/speak", "POST");
  expect(response.status).toBe(401);
  expect(response.headers.get("content-security-policy")).toBe(
    RUNS_NOTHING_POLICY,
  );
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
  expect(dev.text).toContain("/api/voice/tokens");
  expect(dev.text).not.toContain("/api/voice/speak");
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
    ONE_TIME_MINT_LIMIT: {} as RateLimit,
    ONE_TIME_JOIN_LIMIT: {} as RateLimit,
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
    ].sort(),
  );
  expect(accountPreviewBindings(env)).toEqual({
    APP_ORIGIN: env.APP_ORIGIN,
    ASSETS: env.ASSETS,
    AUTH_SECRET: env.AUTH_SECRET,
    BUILD_SHA: sha,
    HYPERDRIVE: env.HYPERDRIVE,
    EMAIL_FROM: "",
    POSTMARK_SERVER_TOKEN: "",
  });
  // No auth secret, and no database: the rendezvous reaches neither.
  expect(keys(relayBindings(env))).toEqual(
    [
      "APP_ORIGIN",
      "ASSETS",
      "BUILD_SHA",
      "ONE_TIME_JOIN_LIMIT",
      "ONE_TIME_MINT_LIMIT",
      "ONE_TIME_ROOM",
    ].sort(),
  );
  // No auth secret: speak reads the token's owner, never a login.
  expect(keys(voiceBindings(env))).toEqual(
    ["APP_ORIGIN", "BUILD_SHA", "ELEVENLABS_API_KEY", "HYPERDRIVE"].sort(),
  );
  expect(keys(voicePreviewBindings(env))).toEqual(
    ["APP_ORIGIN", "BUILD_SHA", "HYPERDRIVE"].sort(),
  );
});

test("neither the relay nor the voice bundle carries Better Auth", async () => {
  for (const [entry, bundle] of [
    [ENTRIES.relay, bundles.relay],
    [ENTRIES.voice, bundles.voice],
    ["server/voice-preview-worker.ts", await bundleWorker("server/voice-preview-worker.ts")],
  ] as const) {
    const inputs = Object.keys(bundle.metafile.inputs);
    expect(
      inputs.filter((input) => /better-auth|postmark/.test(input)),
      entry,
    ).toEqual([]);
  }
  // The pattern finds it where it is.
  const account = Object.keys(bundles.account.metafile.inputs);
  expect(account.some((input) => /better-auth/.test(input))).toBe(true);
});
