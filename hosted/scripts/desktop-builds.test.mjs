import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { supportedReleases } from "./desktop-builds.mjs";

test("the gate covers every release tag from the floor on, in version order", () => {
  const tags = ["v1.3.0", "v2.10.0", "v2.0.0", "v2.1.0-rc.1", "v2.2.0", "hosted/2026-11-11", "v10.0.0", "v2.0.1"];
  assert.deepEqual(supportedReleases(tags, "v2.0.0"), ["v2.0.0", "v2.0.1", "v2.2.0", "v2.10.0", "v10.0.0"]);
  assert.throws(() => supportedReleases(tags, "2.0.0"), /not a vX\.Y\.Z tag/);
});

test("the floor is a release tag", () => {
  const { floor } = JSON.parse(readFileSync(new URL("../desktop-compat.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => supportedReleases([floor], floor));
});
