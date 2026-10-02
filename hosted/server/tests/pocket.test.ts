import { test, expect, beforeAll, afterAll } from "vitest";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import {
  API_ROUTES,
  ONE_TIME_PAGE_PATH,
  WS_ROUTES,
  fromBase64Url,
  isEnrollUserCode,
  isBurrowEnrollBeginResponse,
  isRelayBearer,
  pocketContentSecurityPolicy,
  toBase64Url,
} from "remote-lib-common";
import { RUNS_NOTHING_POLICY, oneTimePagePolicy } from "../headers";
import { ENTRIES, ORIGINS, TEST_ENROLL_SECRET, bundleWorker, miniflareOptions } from "./bundle";
import { limitOf, untilLimited } from "./rate-limit";

// Pocket at the relay's root (`docs/specs/pocket-app.md` -> "Serving the
// built bundle"), the production relay bundle in real workerd without
// Postgres: no route here reads the database.

const origin = ORIGINS.relay;
const SHELL = "<!doctype html><title>Pocket</title>";
const DIAGNOSTICS = "<!doctype html><title>Diagnostics</title>";
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * The staged Pocket build as Cloudflare's assets serve it with the relay's
 * config: `auto-trailing-slash` HTML handling (a directory answers with its
 * `index.html`, which itself redirects to the directory) and no not-found
 * handling, so a missing file is a bare 404.
 */
/** Every path the relay asked its assets for, in order. */
const fetched: string[] = [];

function assets(request: Request) {
  const { pathname } = new URL(request.url);
  fetched.push(pathname);
  const file = (body: string, type: string) =>
    new WorkerResponse(body, { headers: { "content-type": type } });
  switch (pathname) {
    case "/":
      return file(SHELL, "text/html");
    case "/diagnostics/":
      return file(DIAGNOSTICS, "text/html");
    case "/index.html":
    case "/diagnostics/index.html":
      return new WorkerResponse(null, {
        status: 307,
        headers: { location: pathname.slice(0, -"index.html".length) },
      });
    case "/assets/index-abc123.js":
    case "/sw.js":
      return file("export {};", "text/javascript");
    case "/manifest.webmanifest":
      return file("{}", "application/manifest+json");
    default:
      return new WorkerResponse("Not Found", { status: 404 });
  }
}

let relay: Miniflare;
beforeAll(async () => {
  relay = new Miniflare(
    miniflareOptions("relay", (await bundleWorker(ENTRIES.relay)).outputFiles[0].text, {
      bindings: { APP_ORIGIN: origin, RELAY_ENROLL_SECRET: TEST_ENROLL_SECRET },
      // Nothing listens here, so a route that reached the database would fail.
      hyperdrives: { HYPERDRIVE: "postgres://user:pass@127.0.0.1:9/none" },
      serviceBindings: { ASSETS: assets },
    }),
  );
  await relay.ready;
});
afterAll(async () => {
  await relay?.dispose();
});

const get = (path: string, init?: { method?: string }) =>
  relay.dispatchFetch(origin + path, { redirect: "manual", ...init });

test("the shell answers the root, every deep link, and its own name, uncached-until-revalidated under Pocket's policy", async () => {
  for (const path of ["/", "/index.html", "/pair", "/some/deep/link?x=1"]) {
    const response = await get(path);
    expect(response.status, path).toBe(200);
    expect(await response.text(), path).toBe(SHELL);
    expect(response.headers.get("content-security-policy"), path).toBe(
      pocketContentSecurityPolicy(origin),
    );
    expect(response.headers.get("cache-control"), path).toBe("no-cache");
    expect(response.headers.get("x-frame-options"), path).toBe("DENY");
    // The camera is Pocket's alone, for its pairing-code scanner.
    expect(response.headers.get("permissions-policy"), path).toBe(
      "camera=(self), microphone=(), geolocation=()",
    );
  }
});

test("a deep link costs one asset fetch: the shell's", async () => {
  for (const path of ["/pair", "/some/deep/link?x=1", "/"]) {
    fetched.length = 0;
    expect(await (await get(path)).text(), path).toBe(SHELL);
    expect(fetched, path).toEqual(["/"]);
  }
  // A file-like miss is asked for itself first, then answered with the shell.
  fetched.length = 0;
  expect(await (await get("/missing.png")).text()).toBe(SHELL);
  expect(fetched).toEqual(["/missing.png", "/"]);
});

test("the diagnostics harness is served at its own name, never the shell", async () => {
  const response = await get("/diagnostics/index.html");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(DIAGNOSTICS);
});

test("hashed assets are immutable; root files revalidate; a missing asset is a 404, never the shell", async () => {
  const script = await get("/assets/index-abc123.js");
  expect(script.status).toBe(200);
  expect(script.headers.get("cache-control")).toBe(IMMUTABLE);
  for (const path of ["/sw.js", "/manifest.webmanifest"]) {
    const response = await get(path);
    expect(response.status, path).toBe(200);
    expect(response.headers.get("cache-control"), path).toBe("no-cache");
  }
  // A percent-encoded `/assets/` is the same route, and as much a hashed asset.
  for (const path of ["/assets/missing-abc123.js", "/assets/", "/%61ssets/missing-abc123.js"]) {
    const response = await get(path);
    expect(response.status, path).toBe(404);
    expect(response.headers.get("content-type") ?? "", path).not.toContain("text/html");
    expect(response.headers.get("cache-control"), path).not.toBe(IMMUTABLE);
  }
});

test("the API and socket routes are never Pocket's: no shell, no page policy, no camera, never stored", async () => {
  for (const [method, path] of [
    ["GET", "/api/unknown"],
    ["GET", API_ROUTES.pushConfig],
    ["GET", WS_ROUTES.client],
    ["GET", WS_ROUTES.burrow],
    ["GET", "/ws/other"],
  ]) {
    const response = await get(path, { method });
    expect(response.headers.get("content-type") ?? "", path).not.toContain("text/html");
    expect(response.headers.get("content-security-policy"), path).toBe(RUNS_NOTHING_POLICY);
    expect(response.headers.get("cache-control"), path).toBe("no-store");
    expect(response.headers.get("permissions-policy"), path).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  }
  // The self-host installers' probe is not Hosted's.
  expect((await get("/api/hello")).status).toBe(404);
  expect(await (await get(API_ROUTES.pushConfig)).json()).toEqual({ applicationServerKey: null });
  // A socket route answers only an upgrade, and only after its Origin check.
  expect((await get(WS_ROUTES.client)).status).toBe(403);
  expect((await get(WS_ROUTES.burrow)).status).toBe(426);
});

test("a percent-encoded /connect path is the page's route, under its policy and without the camera", async () => {
  for (const path of ["/%63onnect/", "/%63onnect", `${ONE_TIME_PAGE_PATH}%61ssets/x.js`]) {
    const response = await get(path);
    expect(response.headers.get("content-type") ?? "", path).not.toContain("text/html");
    expect(response.headers.get("content-security-policy"), path).toBe(oneTimePagePolicy(origin));
    expect(response.headers.get("permissions-policy"), path).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  }
});

test("the self-host password enrollment answers the 401 a wrong credential does", async () => {
  const response = await get(API_ROUTES.burrowEnroll, { method: "POST" });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthorized" });
});

test("only a Node Burrow begins or polls an enrollment, per-address limited, and begin writes nothing", async () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    relay.dispatchFetch(origin + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  // A browser always sends Origin on a POST; the relay's own is refused too.
  for (const path of [API_ROUTES.burrowEnrollBegin, API_ROUTES.burrowEnrollPoll])
    for (const sent of [origin, "https://evil.example.test", "null"]) {
      const response = await post(path, { origin }, { origin: sent, "cf-connecting-ip": "192.0.2.1" });
      expect(response.status, `${path} ${sent}`).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
  // Begin reaches no database — this one refuses every connection — and answers
  // a code whose expiry it carries; an expired code is answered the same way.
  const begun = await post(API_ROUTES.burrowEnrollBegin, { origin }, { "cf-connecting-ip": "192.0.2.4" });
  expect(begun.status).toBe(200);
  const answer = await begun.json();
  // What the desktop's Burrow holds an answer to before it polls.
  expect(isBurrowEnrollBeginResponse(answer)).toBe(true);
  const { deviceCode, userCode } = answer as { deviceCode: string; userCode: string };
  expect(isRelayBearer(deviceCode) && isEnrollUserCode(userCode)).toBe(true);
  const expired = fromBase64Url(deviceCode);
  expired.set([0, 0, 0, 1]);
  expect(
    await (await post(API_ROUTES.burrowEnrollPoll, { deviceCode: toBase64Url(expired) }, { "cf-connecting-ip": "192.0.2.4" })).json(),
  ).toEqual({ status: "expired" });
  // Neither answer below reads the database either. A mismatched origin spends
  // the address's budget, and a matching one is refused once it is spent.
  const beginLimit = limitOf("RELAY_ENROLL_BEGIN_LIMIT");
  const limited = await untilLimited(beginLimit, async (i) => {
    const mismatched = i < beginLimit;
    const response = await post(
      API_ROUTES.burrowEnrollBegin,
      { origin: mismatched ? "https://other.example.test" : origin },
      { "cf-connecting-ip": "192.0.2.2" },
    );
    if (response.status !== 429) {
      expect(response.status).toBe(mismatched ? 409 : 200);
      if (mismatched) expect(await response.json()).toEqual({ error: "origin mismatch", origin });
    }
    return response;
  });
  expect(limited.headers.get("retry-after")).toBe("60");
  expect(await limited.json()).toEqual({ error: "too many enrollment attempts" });
  const pollLimited = await untilLimited(limitOf("RELAY_ENROLL_POLL_LIMIT"), async () => {
    const unknown = await post(API_ROUTES.burrowEnrollPoll, { deviceCode: "short" }, { "cf-connecting-ip": "192.0.2.3" });
    if (unknown.status !== 429) expect(await unknown.json()).toEqual({ status: "expired" });
    return unknown;
  });
  expect(await pollLimited.json()).toEqual({ error: "too many enrollment attempts" });
  // Another address is another caller.
  for (const path of [API_ROUTES.burrowEnrollBegin, API_ROUTES.burrowEnrollPoll])
    expect((await post(path, { origin, deviceCode: "short" }, { "cf-connecting-ip": "192.0.2.5" })).status, path).not.toBe(429);
});

test("every body is bounded before any route, a credential gate included", async () => {
  for (const path of [
    API_ROUTES.setupFinish,
    API_ROUTES.signinFinish,
    API_ROUTES.burrowEnroll,
    API_ROUTES.burrowEnrollBegin,
    API_ROUTES.burrowEnrollPoll,
  ]) {
    const response = await relay.dispatchFetch(origin + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(64 * 1024) }),
    });
    expect(response.status, path).toBe(413);
    expect(await response.json(), path).toEqual({ error: "request body too large" });
  }
});

test("a bearer of the wrong shape never reaches the database", async () => {
  // The database URL above refuses every connection, so reaching it would be a 503.
  for (const path of [API_ROUTES.burrows, API_ROUTES.reauthBegin, API_ROUTES.burrowSetupToken]) {
    for (const authorization of [undefined, "Bearer short", `Bearer ${"A".repeat(44)}`, `Basic ${"A".repeat(43)}`]) {
      const response = await relay.dispatchFetch(origin + path, {
        method: path === API_ROUTES.burrows ? "GET" : "POST",
        headers: authorization ? { authorization } : {},
      });
      expect(response.status, `${path} ${authorization}`).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  }
  for (const setupToken of [undefined, 7, "short", "A".repeat(44)]) {
    const response = await relay.dispatchFetch(origin + API_ROUTES.setupBegin, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupToken }),
    });
    expect(response.status, String(setupToken)).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid setup token" });
  }
});
