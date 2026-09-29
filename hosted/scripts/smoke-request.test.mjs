import test from "node:test";
import assert from "node:assert/strict";
import { smokeRequest } from "./preview-smoke.mjs";

const origin = "https://hosted.example.test";
const unavailable = () => new TypeError("fetch failed");
const neverWait = async () => assert.fail("must not wait");
const noWait = async () => {};

test("new hostname transport failure can recover, with a bounded retry budget", async () => {
  const waits = [];
  let calls = 0;
  const fetcher = async () => {
    if (++calls < 3) throw unavailable();
    return new Response("ready");
  };
  const response = await smokeRequest(
    fetcher, origin + "/api/health", {}, async (ms) => waits.push(ms),
  );
  assert.equal(await response.text(), "ready");
  assert.deepEqual(waits, [5000, 5000]);
  calls = 0;
  await assert.rejects(
    smokeRequest(async () => {
      calls++;
      throw unavailable();
    }, origin + "/api/health", {}, noWait),
    /fetch failed/,
  );
  assert.equal(calls, 7);
});

test("four provider starts respect the three-per-window limiter", async () => {
  let inWindow = 0;
  const waits = [];
  const providers = [];
  const fetcher = async (_url, options) => {
    if (++inWindow > 3)
      return new Response(null, { status: 429, headers: { "x-retry-after": "10" } });
    providers.push(JSON.parse(options.body).provider);
    return Response.json({ ok: true });
  };
  for (const provider of ["github", "google", "microsoft", "apple"]) {
    const response = await smokeRequest(
      fetcher,
      origin + "/api/auth/sign-in/social",
      { method: "POST", body: JSON.stringify({ provider }) },
      async (ms) => {
        waits.push(ms);
        inWindow = 0;
      },
    );
    assert.equal(response.status, 200);
  }
  assert.deepEqual(providers, ["github", "google", "microsoft", "apple"]);
  assert.deepEqual(waits, [10000]);
});

test("rate-limit waits require a bounded numeric Retry-After and retry only once", async () => {
  for (const value of [null, "", "0", "-1", "61", "nope", "10"]) {
    let calls = 0;
    const waits = [];
    const response = await smokeRequest(async () => {
      calls++;
      return new Response(null, {
        status: 429,
        headers: value === null ? {} : { "retry-after": value },
      });
    }, origin + "/api/auth/sign-in/social", { method: "POST" }, async (ms) => waits.push(ms));
    assert.equal(response.status, 429);
    assert.equal(calls, value === "10" ? 2 : 1);
    assert.deepEqual(waits, value === "10" ? [10000] : []);
  }
});

test("transport failures never replay auth POSTs or later readiness requests", async () => {
  for (const [path, options] of [
    ["/api/auth/sign-in/social", { method: "POST" }],
    ["/api/auth/email-otp/send-verification-otp", { method: "POST" }],
    ["/api/ready", {}],
  ]) {
    let calls = 0;
    await assert.rejects(
      smokeRequest(async () => {
        calls++;
        throw unavailable();
      }, origin + path, options, neverWait),
      /fetch failed/,
    );
    assert.equal(calls, 1);
  }
});

test("HTTP failures and programmer errors fail immediately", async () => {
  for (const status of [403, 500]) {
    const response = await smokeRequest(
      async () => new Response(null, { status }),
      origin + "/api/health", {}, neverWait,
    );
    assert.equal(response.status, status);
  }
  await assert.rejects(
    smokeRequest(async () => {
      throw new Error("fixture error");
    }, origin + "/api/health", {}, neverWait),
    /fixture error/,
  );
});

const oldRevision = "a".repeat(40);
const newRevision = "b".repeat(40);

test("deployment waits for the selected revision before continuing", async () => {
  const waits = [];
  let calls = 0;
  const response = await smokeRequest(async () => {
    calls++;
    if (calls === 1) throw unavailable();
    return Response.json({ ok: true, revision: calls < 4 ? oldRevision : newRevision });
  }, origin + "/api/health", {}, async (ms) => waits.push(ms), newRevision);
  assert.deepEqual(await response.json(), { ok: true, revision: newRevision });
  assert.equal(calls, 4);
  assert.deepEqual(waits, [5000, 5000, 5000]);
});

test("transport and stale revisions share one bounded retry budget", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(smokeRequest(async () => {
    if (++calls % 2 === 0) throw unavailable();
    return Response.json({ ok: true, revision: oldRevision });
  }, origin + "/api/health", {}, async (ms) => waits.push(ms), newRevision),
  /Deployed revision must become live/);
  assert.equal(calls, 7);
  assert.deepEqual(waits, Array(6).fill(5000));
});

test("unhealthy or malformed revision responses fail without rollout retries", async () => {
  for (const body of [
    { ok: false, revision: oldRevision },
    { ok: true },
    { ok: true, revision: "invalid" },
    { ok: true, revision: oldRevision, unexpected: true },
    null,
  ]) {
    await assert.rejects(smokeRequest(async () => Response.json(body),
      origin + "/api/health", {}, neverWait, newRevision));
  }
  await assert.rejects(smokeRequest(async () => new Response("not JSON"),
    origin + "/api/health", {}, neverWait, newRevision), SyntaxError);
});
