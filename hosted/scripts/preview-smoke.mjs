import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** @param {{ text: string }} email */
export const codeFrom = (email) => email.text.match(/\b\d{8}\b/)?.[0];

export async function smoke(
  origin,
  sha,
  fetcher = fetch,
  preview = false,
  expectedProviders = [],
  authOrigin = origin,
) {
  assert.equal(
    new URL(origin).origin,
    origin,
    "Supply an exact origin without a trailing slash",
  );
  assert.equal(new URL(origin).protocol, "https:");
  const request = (path, options = {}) =>
    fetcher(origin + path, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      ...options,
    });
  const health = await request("/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    revision: sha,
  });
  assert.equal(
    (await request("/api/ready")).status,
    200,
    "Auth schema must be reachable through Hyperdrive",
  );
  const start = await request("/api/auth/csrf");
  assert.equal(start.status, 200, "Auth must issue a CSRF challenge");
  assert.match(start.headers.get("cache-control"), /no-store/);
  const state = await start.json();
  assert.equal(await (await request("/api/auth/get-session")).json(), null);
  assert.deepEqual(
    await (await request("/api/providers")).json(),
    preview ? [] : expectedProviders,
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
    assert.equal(
      authorization.origin,
      {
        github: "https://github.com",
        google: "https://accounts.google.com",
        apple: "https://appleid.apple.com",
        facebook: "https://www.facebook.com",
        microsoft: "https://login.microsoftonline.com",
      }[provider],
    );
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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [origin, sha] = process.argv.slice(2);
  assert.match(sha ?? "", /^[a-f0-9]{40}$/);
  // A just-uploaded Worker may take a short time to become reachable everywhere.
  for (let attempt = 1; ; attempt++) {
    try {
      await smoke(origin, sha, fetch, true);
      console.log(`Preview smoke checks passed: ${origin}/login (${sha})`);
      break;
    } catch (error) {
      if (attempt === 6) throw error;
      console.log(
        `Preview not ready (attempt ${attempt}/6); retrying in 10 seconds`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
}
