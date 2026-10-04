import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { providerAuthorizationOrigins } from "../server/providers.js";
import { oneTimeSmoke } from "./one-time-smoke.mjs";

/** @param {{ text: string }} email */
export const codeFrom = (email) => email.text.match(/\b\d{8}\b/)?.[0];

// Only the initial health GET can retry a transport failure while a new custom
// domain becomes reachable, or a healthy older revision during rollout.
// OAuth starts may retry one explicit rejection after
// Retry-After (or Better Auth's X-Retry-After); never replay a POST whose
// transport outcome is unknown.
export async function smokeRequest(fetcher, url, options, wait = delay, expectedRevision) {
  const path = new URL(url).pathname;
  const health = path === "/api/health" && !options.method;
  const social = path === "/api/auth/sign-in/social" && options.method === "POST";
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetcher(url, {
        ...options,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (
        !health ||
        attempt >= 6 ||
        !(error instanceof TypeError) ||
        error.message !== "fetch failed"
      )
        throw error;
      await wait(5_000);
      continue;
    }
    if (health && expectedRevision && response.status === 200) {
      const body = await response.clone().json();
      assert.deepEqual(body, { ok: true, revision: body?.revision });
      assert.match(body.revision, /^[a-f0-9]{40}$/);
      if (body.revision !== expectedRevision && attempt < 6) {
        await response.body?.cancel();
        await wait(5_000);
        continue;
      }
      assert.equal(body.revision, expectedRevision, "Deployed revision must become live");
    }
    if (social && attempt === 0 && response.status === 429) {
      const value =
        response.headers.get("retry-after") ??
        response.headers.get("x-retry-after");
      const seconds = value && /^\d+$/.test(value) ? Number(value) : 0;
      if (seconds >= 1 && seconds <= 60) {
        await response.body?.cancel();
        await wait(seconds * 1_000);
        continue;
      }
    }
    return response;
  }
}

/** A Worker reports `sha` live from its health route; retries as `smokeRequest` does. */
export async function healthSmoke(origin, sha, fetcher = fetch) {
  assert.equal(
    new URL(origin).origin,
    origin,
    "Supply an exact origin without a trailing slash",
  );
  const health = await smokeRequest(fetcher, origin + "/api/health", {}, delay, sha);
  assert.equal(health.status, 200, `${origin} must be healthy`);
  assert.deepEqual(await health.json(), { ok: true, revision: sha });
}

/**
 * A Worker reaches Postgres as its deployment binds it: its `/api/ready` runs a
 * query only its own role's grants admit.
 */
export async function readySmoke(origin, fetcher = fetch) {
  const response = await smokeRequest(fetcher, origin + "/api/ready", {});
  await response.body?.cancel();
  assert.equal(response.status, 200, `${origin} must reach Postgres through its Hyperdrive`);
}

/**
 * The relay answers a VAPID key from `/api/push/config`. Cloudflare exposes a
 * Worker secret's name and never its value, so preflight sees only that both
 * halves exist; a pair that does not match turns push off, and fails here.
 */
export async function pushConfigSmoke(origin, fetcher = fetch) {
  const response = await smokeRequest(fetcher, origin + "/api/push/config", {});
  assert.equal(response.status, 200, `${origin} must answer its push config`);
  const { applicationServerKey } = await response.json();
  assert.match(
    applicationServerKey ?? "",
    /^B[A-Za-z0-9_-]{86}$/,
    `${origin} must answer a VAPID key: both relay secrets set, as one pair`,
  );
}

export async function smoke(
  origin,
  sha,
  fetcher = fetch,
  preview = false,
  expectedProviders = [],
  authOrigin = origin,
) {
  assert.equal(new URL(origin).protocol, "https:");
  await healthSmoke(origin, sha, fetcher);
  const request = (path, options = {}) =>
    smokeRequest(fetcher, origin + path, {
      redirect: "manual",
      ...options,
    }, delay, sha);
  await readySmoke(origin, fetcher);
  const start = await request("/api/auth/csrf");
  assert.equal(start.status, 200, "Auth must issue a CSRF challenge");
  assert.match(start.headers.get("cache-control"), /no-store/);
  const state = await start.json();
  assert.equal(await (await request("/api/auth/get-session")).json(), null);
  // The packed adapter emits its own fixed provider order, not the configured
  // one, so compare the enabled set rather than the sequence.
  const providers = await (await request("/api/providers")).json();
  assert.ok(Array.isArray(providers), "Provider list must be an array");
  assert.deepEqual(
    [...providers].sort(),
    [...(preview ? [] : expectedProviders)].sort(),
    "Unexpected enabled OAuth providers",
  );
  assert.ok(state.csrf);
  const cookies = start.headers.getSetCookie();
  assert.ok(cookies.length);
  for (const cookie of cookies) {
    assert.match(cookie, /^__Host-/);
    assert.match(cookie, /; Secure(?:;|$)/);
    assert.match(cookie, /; HttpOnly(?:;|$)/);
    assert.match(cookie, /; SameSite=Lax(?:;|$)/);
    assert.doesNotMatch(cookie, /; Domain=/i);
  }
  const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
  const rejected = await request("/api/auth/email-otp/send-verification-otp", {
    method: "POST",
    headers: {
      origin: "https://wrong-origin.invalid",
      "content-type": "application/json",
      "x-csrf-token": state.csrf,
      cookie: cookieHeader,
    },
    body: JSON.stringify({
      email: "must-not-send@example.invalid",
      type: "sign-in",
    }),
  });
  assert.equal(rejected.status, 403);
  for (const path of ["/dev/emails", "/api/dev/emails"])
    assert.equal((await request(path)).status, preview ? 200 : 404, path);
  assert.equal((await request("/api/billing")).status, 404);
  assert.equal((await request("/__test/time")).status, 404);
  for (const provider of preview ? [] : expectedProviders) {
    const started = await request("/api/auth/sign-in/social", {
      method: "POST",
      headers: {
        origin: authOrigin,
        "content-type": "application/json",
        "x-csrf-token": state.csrf,
        cookie: cookieHeader,
      },
      body: JSON.stringify({ provider }),
    });
    assert.equal(started.status, 200, `${provider} authorization must start`);
    const authorization = new URL((await started.json()).url);
    assert.equal(authorization.origin, providerAuthorizationOrigins[provider]);
    assert.equal(
      authorization.searchParams.get("redirect_uri"),
      `${authOrigin}/api/auth/callback/${provider}`,
    );
    assert.ok(authorization.searchParams.get("client_id"));
    assert.ok(authorization.searchParams.get("state"));
    if (provider === "google" || provider === "microsoft") {
      assert.equal(authorization.searchParams.get("prompt"), "select_account");
      assert.equal(
        authorization.searchParams.get("code_challenge_method"),
        "S256",
      );
      assert.ok(authorization.searchParams.get("code_challenge"));
    }
    if (
      provider === "google" ||
      provider === "apple" ||
      provider === "microsoft"
    )
      assert.ok(authorization.searchParams.get("nonce"));
    if (provider === "apple")
      assert.equal(
        authorization.searchParams.get("response_mode"),
        "form_post",
      );
  }
  if (preview) await emailLoginSmoke(request, origin);
  let login = await request("/login");
  // Workers Assets canonicalizes prerendered index pages to a trailing slash.
  if (login.status === 307 || login.status === 308) {
    assert.equal(
      new URL(login.headers.get("location"), origin).href,
      `${origin}/login/`,
    );
    login = await request("/login/");
  }
  assert.equal(login.status, 200);
  assert.match(login.headers.get("content-type"), /text\/html/);
  assert.match(await login.text(), /<html/i);
}

/** Exercise real auth HTTP calls and the public preview database inbox without a mail provider. */
async function emailLoginSmoke(request, origin) {
  const inbox = await request("/dev/emails");
  assert.equal(inbox.status, 200, "The preview inbox must be available");
  assert.match(await inbox.text(), /Preview inbox/);
  const cookies = new Map();
  const browser = async (path, options = {}) => {
    const result = await request(path, {
      ...options,
      headers: {
        ...options.headers,
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
    });
    for (const value of result.headers.getSetCookie()) {
      const pair = value.split(";", 1)[0];
      const separator = pair.indexOf("=");
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return result;
  };
  const { csrf } = await (await browser("/api/auth/csrf")).json();
  const post = (path, body) =>
    browser(path, {
      method: "POST",
      headers: {
        origin,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const email = `preview-smoke-${crypto.randomUUID()}@example.invalid`;
  assert.equal(
    (
      await post("/api/auth/email-otp/send-verification-otp", {
        email,
        type: "sign-in",
      })
    ).status,
    200,
    "Capture sign-in email",
  );
  const response = await request("/api/dev/emails");
  assert.equal(response.status, 200);
  const message = (await response.json()).find((message) =>
    message.to.includes(email),
  );
  assert.ok(message, "The requested email must appear in the database inbox");
  const otp = codeFrom(message);
  assert.ok(otp, "Email must contain an eight-digit code");
  const detail = await request(`/dev/emails/${message.id}`);
  assert.equal(detail.status, 200);
  assert.ok((await detail.text()).includes(otp));
  assert.equal(
    (await post("/api/auth/sign-in/email-otp", { email, otp })).status,
    200,
    "Email code verification",
  );
  const signedIn = await (await browser("/api/auth/get-session")).json();
  assert.equal(signedIn?.user.email, email);
  assert.equal((await post("/api/auth/sign-out", {})).status, 200);
  assert.equal(
    await (await browser("/api/auth/get-session")).json(),
    null,
    "Logout must clear the session",
  );
}

/** Runs `check` up to `limit` times, `retryMs` apart, logging each retry. */
async function retrying(limit, what, check, { retryMs, wait }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await check();
    } catch (error) {
      if (attempt >= limit) throw error;
      console.log(
        `${what} not ready (attempt ${attempt}/${limit}); retrying in ${retryMs / 1000} seconds`,
      );
      await wait(retryMs);
    }
  }
}

/**
 * A relay or voice Worker's revision, then its readiness, each retried on its
 * own up to `attempts` (`retrying`'s `retry`), so a passed check never runs
 * again and readiness never runs on a revision that did not pass.
 */
async function liveSmoke(origin, sha, fetcher, attempts, retry) {
  await retrying(attempts, origin, () => healthSmoke(origin, sha, fetcher), retry);
  await retrying(attempts, `${origin} ready`, () => readySmoke(origin, fetcher), retry);
}

/**
 * The relay's smoke: `liveSmoke`, then its push config and its one-time
 * rendezvous, each retried on its own the same way.
 */
export async function relaySmoke(
  origin,
  sha,
  {
    fetcher = fetch,
    oneTime = (origin) => oneTimeSmoke(origin),
    attempts = 1,
    retryMs = 10_000,
    wait = delay,
  } = {},
) {
  const retry = { retryMs, wait };
  await liveSmoke(origin, sha, fetcher, attempts, retry);
  await retrying(attempts, `${origin} push`, () => pushConfigSmoke(origin, fetcher), retry);
  await retrying(attempts, `${origin} one-time`, () => oneTime(origin), retry);
}

/**
 * Every Worker's smoke: the account's auth boundary, the voice's `liveSmoke`,
 * and `relaySmoke` — never waiting on the account, so an account failure hides
 * no relay one. The three run concurrently, each retrying on its own up to its
 * `attempts` (one count for all, or `{ account, relay, voice }`), `retryMs`
 * apart. Every part settles before the smoke fails, and the failure names each
 * part that failed.
 */
export async function smokeAll(
  { account, relay, voice },
  sha,
  {
    fetcher = fetch,
    preview = false,
    providers = [],
    oneTime = (origin) => oneTimeSmoke(origin),
    attempts = 1,
    retryMs = 10_000,
    wait = delay,
  } = {},
) {
  const limit = (part) =>
    typeof attempts === "number" ? attempts : (attempts[part] ?? 1);
  const retry = { retryMs, wait };
  const results = await Promise.allSettled([
    retrying(limit("account"), account, () =>
      smoke(account, sha, fetcher, preview, providers), retry),
    relaySmoke(relay, sha, { fetcher, oneTime, attempts: limit("relay"), retryMs, wait }),
    liveSmoke(voice, sha, fetcher, limit("voice"), retry),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, failures.map((error) => error.message).join("\n"));
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [origins, sha] = process.argv.slice(2);
  assert.match(sha ?? "", /^[a-f0-9]{40}$/);
  const { account, relay, voice } = JSON.parse(origins);
  // A just-uploaded Worker may take a short time to become reachable everywhere.
  await smokeAll({ account, relay, voice }, sha, { preview: true, attempts: 6 });
  console.log(
    `Preview smoke checks passed: ${account}/login, ${relay}/connect/, ${voice} (${sha})`,
  );
}
