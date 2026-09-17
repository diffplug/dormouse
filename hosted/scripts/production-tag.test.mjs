import test from "node:test";
import assert from "node:assert/strict";
import {
  productionDay,
  nextProductionTag,
  recordDeployment,
} from "./production-tag.mjs";

test("production dates follow Los Angeles across UTC midnight and DST", () => {
  assert.equal(productionDay("2026-09-11T06:59:59Z"), "2026-09-10");
  assert.equal(productionDay("2026-09-11T07:00:00Z"), "2026-09-11");
  assert.equal(productionDay("2026-01-02T07:59:59Z"), "2026-01-01");
  assert.equal(productionDay("2026-01-02T08:00:00Z"), "2026-01-02");
  assert.throws(() => productionDay("invalid"));
});

test("daily revisions increase numerically without reusing gaps or unrelated tag names", () => {
  const day = "2026-09-10";
  assert.equal(nextProductionTag(day, []), `hosted/${day}`);
  assert.equal(nextProductionTag(day, [`hosted/${day}`]), `hosted/${day}--r2`);
  assert.equal(
    nextProductionTag(day, [`hosted/${day}--r2`, `hosted/${day}--r10`]),
    `hosted/${day}--r11`,
  );
  assert.equal(
    nextProductionTag(day, [
      "hosted/2026-09-09--r20",
      `hosted/${day}-unrelated`,
    ]),
    `hosted/${day}`,
  );
});

const deployment = {
  repository: "test/repo",
  sha: "a".repeat(40),
  verifiedAt: "2026-09-10T22:49:39Z",
  deploymentId: "123/2",
};

function fakeGithub() {
  const refs = [];
  const tags = new Map();
  const writes = [];
  return {
    refs,
    tags,
    writes,
    api: async (path, body) => {
      if (!body && path.includes("matching-refs/")) return refs;
      if (!body) return tags.get(path.split("/").at(-1));
      writes.push({ path, body });
      if (path.endsWith("/tags")) {
        const sha = String(tags.size + 1).padStart(40, "0");
        tags.set(sha, {
          message: body.message,
          object: { type: body.type, sha: body.object },
        });
        return { sha };
      }
      assert.ok(path.endsWith("/refs"));
      assert.equal(
        refs.some((ref) => ref.ref === body.ref),
        false,
        "Must never overwrite a ref",
      );
      refs.push({ ref: body.ref, object: { type: "tag", sha: body.sha } });
      return {};
    },
  };
}

test("annotated tags record the deployed SHA and run, retry idempotently, and distinguish redeployments", async () => {
  const github = fakeGithub();
  assert.equal(
    await recordDeployment(deployment, github.api),
    "hosted/2026-09-10",
  );
  assert.equal(github.writes[0].body.object, deployment.sha);
  assert.match(github.writes[0].body.message, /runs\/123\/attempts\/2/);
  assert.equal(
    await recordDeployment(deployment, github.api),
    "hosted/2026-09-10",
  );
  assert.equal(github.writes.length, 2);
  assert.equal(
    await recordDeployment(
      { ...deployment, deploymentId: "123/3" },
      github.api,
    ),
    "hosted/2026-09-10--r2",
  );
  await assert.rejects(
    recordDeployment({ ...deployment, sha: "b".repeat(40) }, github.api),
    /different commit/,
  );
  assert.equal(github.writes.length, 4);
});

test("a ref creation failure never falls back to updating an existing tag", async () => {
  const calls = [];
  await assert.rejects(
    recordDeployment(deployment, async (path, body) => {
      calls.push(path);
      if (!body) return [];
      if (path.endsWith("/tags")) return { sha: "c".repeat(40) };
      throw new Error("conflict");
    }),
    /conflict/,
  );
  assert.equal(calls.length, 3);
});
