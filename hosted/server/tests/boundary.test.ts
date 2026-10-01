import { test, expect, beforeAll, afterAll } from "vitest";
import {
  Miniflare,
  convertV4MiniflareOptions,
  Response as WorkerResponse,
} from "miniflare";
import { ONE_TIME_PAGE_PATH, ONE_TIME_WS_ROUTES } from "remote-lib-common";
import {
  accountBindings,
  accountPreviewBindings,
  relayBindings,
  voiceBindings,
  voicePreviewBindings,
} from "../bindings";
import { ACCOUNT_POLICY, RUNS_NOTHING_POLICY } from "../headers";
import { bundleWorker, wrangler } from "./bundle";

// The partition between Hosted's three Workers (`docs/specs/hosted.md` ->
// "Application boundary"), each production bundle in real workerd without
// Postgres: nothing here gets past a 421, a 404, or a missing bearer token, so
// no route reaches the database.

const ORIGINS = {
  account: "https://hosted.dormouse.sh",
  relay: "https://relay.dormouse.sh",
  voice: "https://voice.dormouse.sh",
} as const;
type Name = keyof typeof ORIGINS;
const NAMES = Object.keys(ORIGINS) as Name[];
const ENTRIES: Record<Name, string> = {
  account: "server/worker.ts",
  relay: "server/relay-worker.ts",
  voice: "server/voice-worker.ts",
};
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

/** Every request any Worker sent upstream. */
const outbound: string[] = [];
const workers = {} as Record<Name, Miniflare>;

beforeAll(async () => {
  await Promise.all(
    NAMES.map(async (name) => {
      // The relay's own Durable Object; the others implement none to bind.
      const relay = name === "relay";
      workers[name] = new Miniflare(
        convertV4MiniflareOptions({
          modules: true,
          script: (await bundleWorker(ENTRIES[name])).outputFiles[0].text,
          compatibilityDate: wrangler[name].compatibility_date,
          compatibilityFlags: wrangler[name].compatibility_flags,
          bindings: { ...everything, APP_ORIGIN: ORIGINS[name] },
          // Nothing listens here, so any database access would fail the request.
          hyperdrives: { HYPERDRIVE: "postgres://user:pass@127.0.0.1:9/none" },
          ...(relay
            ? {
                durableObjects: {
                  ONE_TIME_ROOM: { className: "OneTimeRoom", useSQLite: true },
                },
              }
            : {}),
          ratelimits: Object.fromEntries(
            wrangler.relay.ratelimits!.map(({ name, ...limit }) => [name, limit]),
          ),
          // An SPA fallback answering every path, so a route that reached the
          // assets shows as a 200 rather than a 404.
          serviceBindings: {
            ASSETS: () =>
              new WorkerResponse("<!doctype html>", {
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

test("speak is the voice Worker's, bearer-only", async () => {
  const response = await send("voice", ORIGINS.voice + "/api/voice/speak", "POST");
  expect(response.status).toBe(401);
  expect(response.headers.get("content-security-policy")).toBe(
    RUNS_NOTHING_POLICY,
  );
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
  for (const entry of [ENTRIES.relay, ENTRIES.voice, "server/voice-preview-worker.ts"]) {
    const inputs = Object.keys((await bundleWorker(entry)).metafile.inputs);
    expect(
      inputs.filter((input) => /better-auth|postmark/.test(input)),
      entry,
    ).toEqual([]);
  }
  // The pattern finds it where it is.
  const account = Object.keys((await bundleWorker(ENTRIES.account)).metafile.inputs);
  expect(account.some((input) => /better-auth/.test(input))).toBe(true);
});
