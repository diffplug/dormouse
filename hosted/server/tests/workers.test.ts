import { test, expect } from "vitest";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import {
  Miniflare,
  convertV4MiniflareOptions,
  Response as WorkerResponse,
} from "miniflare";
import { createTestContext } from "pgstencil/testing";
import { queryDatabase } from "pgstencil/postgres";
import { migrations } from "../migrations";
import { previewMigrations } from "../preview-migrations";
import { postgresInbox } from "../preview-inbox";
// @ts-expect-error Deployment smoke is shared with the Node CLI.
import { smoke } from "../../scripts/preview-smoke.mjs";
import { providerIds } from "../policy";
import {
  betterAuthCredentials,
  endpointPaths,
  mockOAuthServer,
} from "./oauth-server";
import type { Session } from "../../src/api";

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

async function fixture(
  production: boolean | "preview" = false,
  enabled = providerIds.join(","),
) {
  const context = await createTestContext({
    migrations: production === "preview" ? previewMigrations : migrations,
  });
  const provider = await mockOAuthServer({
    betterAuth: true,
    now: production ? undefined : () => context.time.now(),
  });
  const bindings: Record<string, string> = {
    APP_ORIGIN: origin,
    BUILD_SHA: "a".repeat(40),
    AUTH_SECRET: "dormouse-test-secret-with-at-least-32-characters",
    EMAIL_FROM: "signin@example.test",
    POSTMARK_SERVER_TOKEN: "test-token",
    OAUTH_PROVIDERS: enabled,
  };
  for (const [id, credentials] of Object.entries(betterAuthCredentials)) {
    bindings[`${id.toUpperCase()}_CLIENT_ID`] = credentials.clientId;
    bindings[`${id.toUpperCase()}_CLIENT_SECRET`] = credentials.clientSecret;
  }
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: (
        await (production === "preview"
          ? previewBundle
          : production
            ? productionBundle
            : testBundle)
      ).outputFiles![0].text,
      compatibilityDate: "2026-09-08",
      compatibilityFlags: ["nodejs_compat"],
      bindings,
      hyperdrives: { HYPERDRIVE: context.database.url },
      serviceBindings: {
        ASSETS: () =>
          new WorkerResponse(
            "<!doctype html><html><title>Dormouse Hosted</title></html>",
            {
              headers: { "content-type": "text/html" },
            },
          ),
      },
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
    return { request, post, session, email, oauth };
  }
  return {
    ...context,
    worker,
    provider,
    browser,
    advance: (time: string) =>
      worker.dispatchFetch(origin + "/__test/time", {
        method: "POST",
        body: time,
      }),
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
    (url: string, init: Parameters<typeof f.worker.dispatchFetch>[1]) =>
      f.worker.dispatchFetch(url, init),
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
