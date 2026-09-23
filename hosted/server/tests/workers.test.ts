import { test, expect, vi } from "vitest";
import { digest } from "@pgstencil/auth/security";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import {
  Miniflare,
  convertV4MiniflareOptions,
  Request as WorkerRequest,
  Response as WorkerResponse,
} from "miniflare";
import { createTestContext } from "pgstencil/testing";
import { queryDatabase } from "pgstencil/postgres";
import { migrations } from "../migrations";
import { previewMigrations } from "../preview-migrations";
import { postgresInbox } from "../preview-inbox";
import { smoke } from "../../scripts/preview-smoke.mjs";
import { providerIds } from "../policy";
import {
  betterAuthCredentials,
  endpointPaths,
  mockOAuthServer,
} from "./oauth-server";
import type { Session } from "../../src/api";
import { ADMIN_EMAIL } from "../admin";
import { CRON_SWEEP_CAP, SPEECH_SWEEP_CAP, VOICE_DAILY_CAP } from "../voice";

const origin = "https://hosted.dormouse.sh";
const bundle = (production: boolean | "preview") =>
  build({
    entryPoints: [
      production === "preview"
        ? "server/preview-worker.ts"
        : production
          ? "server/worker.ts"
          : "server/tests/worker-entry.ts",
    ],
    inject: production
      ? []
      : [
          fileURLToPath(
            import.meta.resolve("@pgstencil/auth/better-auth-testing"),
          ),
        ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    conditions: ["workerd", "worker"],
    external: ["node:*", "cloudflare:*"],
    alias: Object.fromEntries(
      builtinModules
        .filter((name) => !name.startsWith("node:"))
        .map((name) => [name, `node:${name}`]),
    ),
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire('/worker.js');",
    },
  });
const testBundle = bundle(false);
const productionBundle = bundle(true);
const previewBundle = bundle("preview");
type Result = Awaited<ReturnType<Miniflare["dispatchFetch"]>>;
type Handler = (
  request: WorkerRequest,
) => WorkerResponse | Promise<WorkerResponse>;

/** One Worker under Miniflare; `database` backs the HYPERDRIVE binding. */
const workerOptions = ({
  script,
  database,
  assets,
  ...rest
}: {
  script: string;
  database: string;
  assets: Handler;
  bindings: Record<string, string>;
  outboundService: Handler;
}) =>
  convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_compat"],
    hyperdrives: { HYPERDRIVE: database },
    serviceBindings: { ASSETS: assets },
    ...rest,
  });

async function fixture(
  production: boolean | "preview" = false,
  enabled = providerIds.join(","),
  overrides: Record<string, string> = {},
) {
  const context = await createTestContext({
    migrations: production === "preview" ? previewMigrations : migrations,
  });
  const provider = await mockOAuthServer({
    betterAuth: true,
    now: production ? undefined : () => context.time.now(),
  });
  // Simulated ElevenLabs: tests swap `respond` and read what the Worker sent.
  const elevenLabs = {
    requests: [] as { url: string; key: string | null; body: unknown }[],
    /** History list calls; the simulated history is always empty. */
    sweeps: [] as string[],
    respond: (): WorkerResponse | Promise<WorkerResponse> =>
      new WorkerResponse(new Uint8Array([0xff, 0xfb, 0x90, 0x64]), {
        headers: { "content-type": "audio/mpeg" },
      }),
  };
  const bindings: Record<string, string> = {
    APP_ORIGIN: origin,
    BUILD_SHA: "a".repeat(40),
    AUTH_SECRET: "dormouse-test-secret-with-at-least-32-characters",
    EMAIL_FROM: "signin@example.test",
    POSTMARK_SERVER_TOKEN: "test-token",
    ELEVENLABS_API_KEY: "test-elevenlabs-key",
    OAUTH_PROVIDERS: enabled,
  };
  for (const [id, credentials] of Object.entries(betterAuthCredentials)) {
    bindings[`${id.toUpperCase()}_CLIENT_ID`] = credentials.clientId;
    bindings[`${id.toUpperCase()}_CLIENT_SECRET`] = credentials.clientSecret;
  }
  Object.assign(bindings, overrides);
  const worker = new Miniflare(
    workerOptions({
      script: (
        await (production === "preview"
          ? previewBundle
          : production
            ? productionBundle
            : testBundle)
      ).outputFiles![0].text,
      bindings,
      database: context.database.url,
      // Vite's content-hashed build output, with the SPA fallback answering
      // every other path — including an unknown one under /assets/ — with the shell.
      assets: (request) =>
          new URL(request.url).pathname === "/assets/app-abc123.js"
            ? new WorkerResponse("export const build = 1;\n", {
                headers: { "content-type": "text/javascript" },
              })
            : new WorkerResponse(
                "<!doctype html><html><title>Dormouse Hosted</title></html>",
                {
                  headers: { "content-type": "text/html" },
                },
              ),
      async outboundService(request) {
        if (production === "preview")
          throw new Error(
            "Preview must never send external mail or OAuth requests",
          );
        const url = new URL(request.url);
        if (url.href === "https://api.postmarkapp.com/email") {
          expect(request.headers.get("x-postmark-server-token")).toBe(
            "test-token",
          );
          const mail = (await request.json()) as {
            To: string;
            From: string;
            Subject: string;
            HtmlBody: string;
            TextBody: string;
          };
          await context.email.send({
            to: [mail.To],
            from: mail.From,
            subject: mail.Subject,
            html: mail.HtmlBody,
            text: mail.TextBody,
          });
          return new WorkerResponse(JSON.stringify({ ErrorCode: 0 }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.href.startsWith("https://api.elevenlabs.io/v1/history?")) {
          elevenLabs.sweeps.push(url.href);
          return WorkerResponse.json({ history: [] });
        }
        if (url.origin === "https://api.elevenlabs.io") {
          elevenLabs.requests.push({
            url: url.href,
            key: request.headers.get("xi-api-key"),
            body: await request.json(),
          });
          return elevenLabs.respond();
        }
        const path = endpointPaths[url.origin + url.pathname];
        if (!path) throw new Error(`Unexpected outbound host: ${url.hostname}`);
        const response = await fetch(provider.origin + path + url.search, {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          ...(request.method === "POST" ? { body: await request.text() } : {}),
        });
        return new WorkerResponse(await response.arrayBuffer(), {
          status: response.status,
          headers: {
            "content-type":
              response.headers.get("content-type") ?? "application/json",
          },
        });
      },
    }),
  );
  try {
    await worker.ready;
  } catch (error) {
    await worker.dispose();
    await provider.close();
    await context.close();
    throw error;
  }
  function browser() {
    const jar = new Map<string, string>();
    let csrf = "";
    async function request(
      path: string,
      init: {
        method?: string;
        body?: string;
        headers?: Record<string, string>;
      } = {},
    ) {
      const response = await worker.dispatchFetch(new URL(path, origin).href, {
        ...init,
        redirect: "manual",
        headers: {
          cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
          "cf-connecting-ip": "203.0.113.10",
          ...init.headers,
        },
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0];
        const split = pair.indexOf("=");
        jar.set(pair.slice(0, split), pair.slice(split + 1));
      }
      return response;
    }
    const post = async (
      path: string,
      body: unknown = {},
      requestOrigin = origin,
    ) => {
      if (!csrf)
        csrf = (
          (await (await request("/api/auth/csrf")).json()) as { csrf: string }
        ).csrf;
      return request("/api/auth/" + path, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          origin: requestOrigin,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
      });
    };
    const session = async () =>
      (
        await request("/api/auth/get-session")
      ).json() as Promise<Session | null>;
    const email = async (address: string) => {
      expect(
        (
          await post("email-otp/send-verification-otp", {
            email: address,
            type: "sign-in",
          })
        ).status,
      ).toBe(200);
      const message = await context.email.next();
      const result = await post("sign-in/email-otp", {
        email: address,
        otp: message.text.match(/\b\d{8}\b/)![0],
      });
      expect(result.status).toBe(200);
      return result;
    };
    async function oauth(
      id: (typeof providerIds)[number],
      profile: Record<string, unknown> = {},
      link = false,
    ) {
      const started = await post(link ? "link-social" : "sign-in/social", {
        provider: id,
      });
      expect(started.status).toBe(200);
      const url = new URL(((await started.json()) as { url: string }).url);
      const callback = provider.authorize(id, url, profile);
      let path = callback.href;
      if (id === "apple") {
        const relay = await worker.dispatchFetch(origin + callback.pathname, {
          method: "POST",
          redirect: "manual",
          headers: {
            origin: "https://appleid.apple.com",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: callback.searchParams.toString(),
        });
        expect(relay.status).toBe(302);
        path = relay.headers.get("location")!;
      }
      return { path, result: await request(path) };
    }
    // Token management is same-origin JSON; speak is bearer-only, with no cookie.
    const voice = (method: string, path = "") =>
      request("/api/voice/tokens" + path, { method, headers: { origin } });
    const speak = (token: string | undefined, body: unknown) =>
      worker.dispatchFetch(origin + "/api/voice/speak", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    const mint = async () =>
      (await (await voice("POST")).json()) as { id: string; token: string };
    return { request, post, session, email, oauth, voice, speak, mint };
  }
  return {
    ...context,
    worker,
    provider,
    elevenLabs,
    browser,
    advance: (time: string) =>
      worker.dispatchFetch(origin + "/__test/time", {
        method: "POST",
        body: time,
      }),
    /** Background passes scheduled so far; the test entry only. */
    waitUntilCalls: async () =>
      Number(
        await (
          await worker.dispatchFetch(origin + "/__test/wait-until")
        ).text(),
      ),
    close: async () => {
      await worker.dispose();
      await provider.close();
      await context.close();
    },
  };
}

test("independent logins, current-browser logout, 24-hour expiry and private cookies", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const first = f.browser(),
    second = f.browser();
  const login = await first.email("owner@example.test");
  const cookie = login.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-pgstencil.session_token="))!;
  for (const attribute of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"])
    expect(cookie).toContain(attribute);
  expect(cookie).not.toContain("Domain=");
  expect(JSON.stringify(await first.session())).not.toContain("token");
  await f.advance("2020-01-01T00:01:01Z");
  await second.email("owner@example.test");
  expect((await second.session())!.user.id).toBe(
    (await first.session())!.user.id,
  );
  expect((await first.post("sign-out")).status).toBe(200);
  expect(await first.session()).toBeNull();
  expect(await second.session()).not.toBeNull();
  await f.advance("2020-01-02T00:01:01.001Z");
  expect(await second.session()).toBeNull();
});

test.for(providerIds)(
  "%s: callback, replay and explicit linking",
  async (id, { onTestFinished }) => {
    const f = await fixture();
    onTestFinished(f.close);
    const owner = f.browser(),
      other = f.browser();
    await owner.email("oauth@example.test");
    const ownerId = (await owner.session())!.user.id;
    const collision = await other.oauth(id);
    expect(collision.result.headers.get("location")).toContain("/login?error=");
    expect(await other.session()).toBeNull();
    const linked = await owner.oauth(
      id,
      {
        email:
          id === "apple"
            ? "private@privaterelay.appleid.com"
            : "oauth@example.test",
      },
      true,
    );
    expect(linked.result.headers.get("location")).toBe(origin + "/account");
    expect((await other.oauth(id)).result.headers.get("location")).toBe(
      origin + "/account",
    );
    expect((await other.session())!.user.id).toBe(ownerId);
    expect(await owner.session()).not.toBeNull();
    expect(
      (await owner.request(linked.path)).headers.get("location"),
    ).toContain("/login?error=");
  },
);

test.for(providerIds)(
  "%s: missing email can create an account without a mailbox identity",
  async (id, { onTestFinished }) => {
    const f = await fixture();
    onTestFinished(f.close);
    const browser = f.browser();
    const result = await browser.oauth(
      id,
      id === "github" ? { githubEmails: [] } : { email: "" },
    );
    expect(result.result.headers.get("location")).toBe(origin + "/account");
    expect((await browser.session())!.user.email).toBeNull();
  },
);

test("same-site marketing requests fail; production excludes dev endpoints and unconfigured providers", async ({
  onTestFinished,
}) => {
  const f = await fixture(true, "github");
  onTestFinished(f.close);
  const browser = f.browser();
  expect(await (await browser.request("/api/providers")).json()).toEqual([
    "github",
  ]);
  expect(
    (
      await browser.post(
        "email-otp/send-verification-otp",
        { email: "x@example.test", type: "sign-in" },
        "https://dormouse.sh",
      )
    ).status,
  ).toBe(403);
  const shell = await browser.request("/login");
  expect(shell.headers.get("content-security-policy")).toContain(
    "script-src 'self'",
  );
  expect(shell.headers.get("cache-control")).toBe("no-store");
  expect(shell.headers.get("access-control-allow-origin")).toBeNull();
  expect(
    (await browser.request("/api/auth/csrf")).headers.get("cache-control"),
  ).toBe("no-store");
  const asset = await browser.request("/assets/app-abc123.js");
  expect(asset.headers.get("cache-control")).toBe(
    "public, max-age=31536000, immutable",
  );
  expect(asset.headers.get("x-frame-options")).toBe("DENY");
  expect(asset.headers.get("strict-transport-security")).toBe(
    "max-age=31536000",
  );
  expect(asset.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
  // The SPA fallback serves the shell for an unknown asset path; it must stay uncached.
  expect(
    (await browser.request("/assets/missing-abc123.js")).headers.get(
      "cache-control",
    ),
  ).toBe("no-store");
  for (const path of [
    "/api/dev/emails",
    "/dev/emails",
    "/__test/time",
    "/api/auth/revoke-sessions",
  ])
    expect((await browser.request(path)).status).toBe(404);
  expect(
    (await f.worker.dispatchFetch("https://dormouse.sh/api/auth/csrf")).status,
  ).toBe(421);
  await browser.email("real-clock@example.test");
  expect(
    Math.abs(
      Date.parse((await browser.session())!.session.createdAt) - Date.now(),
    ),
  ).toBeLessThan(60000);
  expect((await browser.request("/api/ready")).status).toBe(200);
  await queryDatabase(
    f.database.url,
    'ALTER TABLE "session" DROP COLUMN "emailAuthenticated"',
  );
  expect((await browser.request("/api/ready")).status).toBe(503);
});

test("an enabled provider missing its credential fails closed with the secure headers", async ({
  onTestFinished,
}) => {
  const f = await fixture(true, "github", { GITHUB_CLIENT_SECRET: "" });
  onTestFinished(f.close);
  const browser = f.browser();
  for (const path of ["/login", "/api/providers", "/api/auth/csrf"]) {
    const response = await browser.request(path);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      message: "Sign-in is temporarily unavailable. Please try again.",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  }
});

test("explicit connection callback cannot outlive its initiating login", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const browser = f.browser();
  await browser.email("owner@example.test");
  const started = await browser.post("link-social", { provider: "github" });
  const callback = f.provider.authorize(
    "github",
    new URL(((await started.json()) as { url: string }).url),
  );
  await browser.post("sign-out");
  expect(
    (await browser.request(callback.href)).headers.get("location"),
  ).toContain("/login?error=");
});

test("preview runs cloud smoke against real auth, ignores stale providers, and persists escaped inbox messages", async ({
  onTestFinished,
}) => {
  const f = await fixture("preview");
  onTestFinished(f.close);
  await smoke(
    origin,
    "a".repeat(40),
    // Miniflare's Response type is not the DOM's; the smoke reads only the shared surface.
    ((url: string, init?: Parameters<typeof f.worker.dispatchFetch>[1]) =>
      f.worker.dispatchFetch(url, init)) as unknown as typeof fetch,
    true,
  );
  const inbox = postgresInbox(f.database.url);
  await inbox.send({
    to: ["<script>@example.test"],
    from: "test@example.test",
    subject: "<script>alert(1)</script>",
    text: "<img src=x onerror=alert(1)>",
    html: "<script>alert(1)</script>",
  });
  const messages = await inbox.all();
  const id = messages[0].id;
  const detail = await f.worker.dispatchFetch(origin + `/dev/emails/${id}`);
  expect(await detail.text()).toContain("&lt;img");
  const page = await f.worker.dispatchFetch(origin + "/dev/emails");
  expect(await page.text()).not.toContain("<script>");
  expect(
    (await f.worker.dispatchFetch("https://wrong.invalid/dev/emails")).status,
  ).toBe(421);
  // The independently allocated pool reads the same persisted mail.
  expect((await postgresInbox(f.database.url).get(id))?.subject).toContain(
    "<script>",
  );
  await queryDatabase(
    f.database.url,
    "UPDATE preview.email_messages SET captured_at = now() - interval '25 hours' WHERE id = $1",
    [id],
  );
  expect(await inbox.get(id)).toBeUndefined();
});

const voiceId = "21m00Tcm4TlvDq8ikWAM";
const hi = { text: "hi", voiceId };

test("managed voice: only the verified admin mints, speaks, and revokes", async ({
  onTestFinished,
}) => {
  const f = await fixture();
  onTestFinished(f.close);
  const admin = f.browser(),
    other = f.browser();
  expect((await admin.voice("GET")).status).toBe(401);
  await other.email("other@example.test");
  expect((await other.voice("GET")).status).toBe(403);
  expect((await other.voice("POST")).status).toBe(403);
  await admin.email(ADMIN_EMAIL);
  expect(await (await admin.voice("GET")).json()).toEqual({ tokens: [] });
  // A same-site page carries the cookie but not this origin.
  expect(
    (
      await admin.request("/api/voice/tokens", {
        method: "POST",
        headers: { origin: "https://dormouse.sh" },
      })
    ).status,
  ).toBe(403);

  const minted = await admin.voice("POST");
  expect(minted.status).toBe(201);
  const { id, token } = (await minted.json()) as { id: string; token: string };
  expect(token).toMatch(/^dmv_[A-Za-z0-9_-]{43}$/);
  const stored = await queryDatabase<{ hash: string }>(
    f.database.url,
    "SELECT hash FROM dormouse_voice_tokens",
  );
  expect(stored).toEqual([{ hash: digest(token) }]);

  const spoken = await admin.speak(token, {
    text: "  Build passed.  ",
    voiceId,
  });
  expect(spoken.status).toBe(200);
  expect(spoken.headers.get("content-type")).toBe("audio/mpeg");
  expect(spoken.headers.get("cache-control")).toBe("no-store");
  expect([...new Uint8Array(await spoken.arrayBuffer())]).toEqual([
    0xff, 0xfb, 0x90, 0x64,
  ]);
  expect(f.elevenLabs.requests).toEqual([
    {
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      key: "test-elevenlabs-key",
      body: { text: "Build passed.", model_id: "eleven_flash_v2_5" },
    },
  ]);
  // A successful speech schedules one history sweep (undelayed in the test entry).
  expect(await f.waitUntilCalls()).toBe(1);
  await vi.waitFor(() =>
    expect(f.elevenLabs.sweeps).toEqual([
      `https://api.elevenlabs.io/v1/history?page_size=${SPEECH_SWEEP_CAP}`,
    ]),
  );
  const [listed] = (
    (await (await admin.voice("GET")).json()) as {
      tokens: { id: string; lastUsedAt: string | null; revokedAt: null }[];
    }
  ).tokens;
  expect(listed.id).toBe(id);
  expect(listed.lastUsedAt).not.toBeNull();
  expect(Object.keys(listed).sort()).toEqual([
    "createdAt",
    "id",
    "lastUsedAt",
    "revokedAt",
  ]);

  for (const body of [
    "not json",
    JSON.stringify({ ...hi, pad: "x".repeat(4096) }),
    { voiceId },
    { text: "   ", voiceId },
    { text: "x".repeat(201), voiceId },
    { ...hi, voiceId: "../v1/voices" },
    { ...hi, voiceId: "x".repeat(65) },
  ])
    expect((await admin.speak(token, body)).status).toBe(400);
  for (const bad of [undefined, "dmv_unknown", "dmv_" + "A".repeat(43)])
    expect((await admin.speak(bad, hi)).status).toBe(401);

  // Upstream failure: 502, and nothing of the upstream body reaches the caller.
  for (const respond of [
    () => new WorkerResponse("upstream-secret-detail", { status: 401 }),
    () => {
      throw new Error("upstream-secret-detail");
    },
  ]) {
    f.elevenLabs.respond = respond;
    const failed = await admin.speak(token, hi);
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("upstream-secret-detail");
  }

  // The daily cap counts attempts that reached the upstream call.
  expect(
    await queryDatabase(
      f.database.url,
      "SELECT count FROM dormouse_voice_usage",
    ),
  ).toEqual([{ count: 3 }]);
  await queryDatabase(
    f.database.url,
    "UPDATE dormouse_voice_usage SET count = $1",
    [VOICE_DAILY_CAP],
  );
  const requests = f.elevenLabs.requests.length;
  expect((await admin.speak(token, hi)).status).toBe(429);
  expect(f.elevenLabs.requests.length).toBe(requests);

  // A token held by any other account is refused even though it is valid.
  const otherToken = "dmv_" + "B".repeat(43);
  await queryDatabase(
    f.database.url,
    `INSERT INTO dormouse_voice_tokens ("userId", hash) VALUES ($1, $2)`,
    [(await other.session())!.user.id, digest(otherToken)],
  );
  expect((await other.speak(otherToken, hi)).status).toBe(
    403,
  );

  // No refused or failed speech (400, 401, 403, 429, 502) scheduled a sweep.
  expect(await f.waitUntilCalls()).toBe(1);

  expect((await admin.voice("DELETE", "/" + id)).status).toBe(204);
  expect((await admin.speak(token, hi)).status).toBe(401);
  expect((await admin.voice("DELETE", "/not-a-token")).status).toBe(404);
  expect(
    (await admin.voice("DELETE", "/00000000-0000-4000-8000-000000000000"))
      .status,
  ).toBe(404);

  // The admin address counts only while verified, rechecked on every request.
  const second = await admin.mint();
  await queryDatabase(
    f.database.url,
    `UPDATE "user" SET "emailVerified" = false WHERE email = $1`,
    [ADMIN_EMAIL],
  );
  expect((await admin.voice("GET")).status).toBe(403);
  expect((await admin.voice("POST")).status).toBe(403);
  expect(
    (await admin.speak(second.token, hi)).status,
  ).toBe(403);
});

test("managed voice fails closed in production without an ElevenLabs key", async ({
  onTestFinished,
}) => {
  const f = await fixture(true, "", { ELEVENLABS_API_KEY: "" });
  onTestFinished(f.close);
  const admin = f.browser();
  await admin.email(ADMIN_EMAIL);
  const response = await admin.speak((await admin.mint()).token, hi);
  expect(response.status).toBe(503);
  expect(f.elevenLabs.requests).toEqual([]);
});

test("sweep caps fit Workers Free's 50 subrequests per invocation", () => {
  // One list, then one DELETE per item.
  expect(1 + CRON_SWEEP_CAP).toBeLessThanOrEqual(50);
  // The speak request's database connection and synthesize call come first.
  expect(1 + 1 + 1 + SPEECH_SWEEP_CAP).toBeLessThanOrEqual(50);
});

test("production cron sweeps ElevenLabs history with only its key and no database", async ({
  onTestFinished,
}) => {
  // Simulated history, newest first.
  const history = new Set(
    Array.from({ length: CRON_SWEEP_CAP + 12 }, (_, i) => `item${i}`),
  );
  const listed: string[] = [];
  const deleted: string[] = [];
  let gone = "item3";
  let failing = "item5";
  let inFlight = 0,
    maxInFlight = 0;
  const sweeper = async (bindings: Record<string, string>) => {
    const worker = new Miniflare(
      workerOptions({
        script: (await productionBundle).outputFiles![0].text,
        // No AUTH_SECRET, APP_ORIGIN, or mail and OAuth credentials.
        bindings,
        // Nothing listens here, so any database access would fail the run.
        database: "postgres://user:pass@127.0.0.1:9/none",
        assets: () => new WorkerResponse("", { status: 500 }),
        async outboundService(request) {
          const url = new URL(request.url);
          expect(url.origin).toBe("https://api.elevenlabs.io");
          expect(request.headers.get("xi-api-key")).toBe("sweep-key");
          if (request.method === "GET" && url.pathname === "/v1/history") {
            listed.push(url.search);
            const size = Number(url.searchParams.get("page_size"));
            return WorkerResponse.json({
              history: [...history].slice(0, size).map((history_item_id) => ({
                history_item_id,
                text: "spoken text",
              })),
            });
          }
          const id = /^\/v1\/history\/(\w+)$/.exec(url.pathname)?.[1];
          expect(request.method).toBe("DELETE");
          maxInFlight = Math.max(maxInFlight, ++inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight--;
          if (id === failing) return new WorkerResponse("{}", { status: 500 });
          deleted.push(id!);
          history.delete(id!);
          return id === gone
            ? new WorkerResponse("{}", { status: 404 })
            : WorkerResponse.json({ status: "ok" });
        },
      }),
    );
    onTestFinished(() => worker.dispose());
    // Without @cloudflare/workers-types, the Fetcher's scheduled() is untyped.
    const fetcher = (await worker.getWorker()) as unknown as {
      scheduled(options: { cron: string }): Promise<{ outcome: string }>;
    };
    return () => fetcher.scheduled({ cron: "*/5 * * * *" });
  };

  // Without a key: no upstream call at all.
  expect((await (await sweeper({}))()).outcome).toBe("ok");
  expect(listed).toEqual([]);

  const scheduled = await sweeper({ ELEVENLABS_API_KEY: "sweep-key" });
  // First pass: one list, deletes up to the cap, and survives one failure and
  // one item already gone (404).
  expect((await scheduled()).outcome).toBe("ok");
  expect(listed).toEqual([`?page_size=${CRON_SWEEP_CAP}`]);
  expect(deleted).toHaveLength(CRON_SWEEP_CAP - 1);
  expect(deleted).toContain(gone);
  expect(deleted).not.toContain(failing);
  expect(maxInFlight).toBeGreaterThan(1);
  expect(maxInFlight).toBeLessThanOrEqual(6);

  // The next pass takes the rest of the backlog, including the item that failed.
  failing = "";
  gone = "";
  expect((await scheduled()).outcome).toBe("ok");
  expect(history.size).toBe(0);
});
