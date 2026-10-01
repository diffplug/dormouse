import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageOneTime } from "./stage-one-time.mjs";

/** A `lib/dist-one-time` whose shell loads `script`, and the relay's assets directory from an earlier build. */
function fixture(script = '<script type="module" src="/connect/assets/index-abc.js"></script>') {
  const root = mkdtempSync(join(tmpdir(), "stage-one-time-"));
  const built = join(root, "dist-one-time");
  mkdirSync(join(built, "assets"), { recursive: true });
  writeFileSync(join(built, "index.html"), `<!doctype html><head>${script}</head>`);
  writeFileSync(join(built, "assets", "index-abc.js"), "export {};\n");
  const assets = join(root, "dist", "relay");
  mkdirSync(join(assets, "connect", "assets"), { recursive: true });
  writeFileSync(join(assets, "connect", "assets", "stale.js"), "");
  writeFileSync(join(assets, "index.html"), "<!doctype html><title>stray</title>");
  return { built, assets };
}

test("the built page lands at the page path, and is all the relay's assets hold", () => {
  const { built, assets } = fixture();
  assert.equal(stageOneTime(built, assets), 1);
  assert.ok(existsSync(join(assets, "connect", "index.html")));
  assert.ok(existsSync(join(assets, "connect", "assets", "index-abc.js")));
  assert.ok(!existsSync(join(assets, "connect", "assets", "stale.js")));
  assert.deepEqual(readdirSync(assets), ["connect"]);
});

test("a shell the page's policy would refuse is not staged quietly", () => {
  for (const script of [
    '<script type="module">alert(1)</script>',
    '<script type="module" src="/assets/index-abc.js"></script>',
    '<script type="module" src="https://cdn.example/connect/assets/x.js"></script>',
    "",
  ]) {
    const { built, assets } = fixture(script);
    assert.throws(() => stageOneTime(built, assets), undefined, script);
  }
});

test("staging refuses to run before the page's build", () => {
  const { built, assets } = fixture();
  assert.throws(() => stageOneTime(join(built, "missing"), assets), /build:one-time/);
});
