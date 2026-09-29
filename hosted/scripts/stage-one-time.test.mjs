import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageOneTime } from "./stage-one-time.mjs";

/** A `lib/dist-one-time` whose shell loads `script`, and an emptied Hosted `dist/`. */
function fixture(script = '<script type="module" src="/connect/assets/index-abc.js"></script>') {
  const root = mkdtempSync(join(tmpdir(), "stage-one-time-"));
  const built = join(root, "dist-one-time");
  mkdirSync(join(built, "assets"), { recursive: true });
  writeFileSync(join(built, "index.html"), `<!doctype html><head>${script}</head>`);
  writeFileSync(join(built, "assets", "index-abc.js"), "export {};\n");
  const dist = join(root, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>accounts</title>");
  return { built, dist };
}

test("the built page lands at the page path, replacing any earlier copy", () => {
  const { built, dist } = fixture();
  mkdirSync(join(dist, "connect", "assets"), { recursive: true });
  writeFileSync(join(dist, "connect", "assets", "stale.js"), "");
  assert.equal(stageOneTime(built, dist), 1);
  assert.ok(existsSync(join(dist, "connect", "index.html")));
  assert.ok(existsSync(join(dist, "connect", "assets", "index-abc.js")));
  assert.ok(!existsSync(join(dist, "connect", "assets", "stale.js")));
  assert.match(readFileSync(join(dist, "index.html"), "utf8"), /accounts/);
});

test("a shell the page's policy would refuse is not staged quietly", () => {
  for (const script of [
    '<script type="module">alert(1)</script>',
    '<script type="module" src="/assets/index-abc.js"></script>',
    '<script type="module" src="https://cdn.example/connect/assets/x.js"></script>',
    "",
  ]) {
    const { built, dist } = fixture(script);
    assert.throws(() => stageOneTime(built, dist), undefined, script);
  }
});

test("staging refuses to run before either build", () => {
  const { built, dist } = fixture();
  assert.throws(() => stageOneTime(join(built, "missing"), dist), /build:one-time/);
  assert.throws(() => stageOneTime(built, join(dist, "missing")), /Vite build/);
});
