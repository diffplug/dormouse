import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageRelay } from "./stage-relay.mjs";

/**
 * A `lib/dist-pocket` and `lib/dist-one-time` whose shells load `pocketScript`
 * and `oneTimeScript`, and the relay's assets directory from an earlier build.
 */
function fixture({
  pocketScript = '<script type="module" src="/assets/index-p.js"></script>',
  oneTimeScript = '<script type="module" src="/connect/assets/index-abc.js"></script>',
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "stage-relay-"));
  const pocket = join(root, "dist-pocket");
  mkdirSync(join(pocket, "assets"), { recursive: true });
  mkdirSync(join(pocket, "diagnostics"), { recursive: true });
  writeFileSync(join(pocket, "index.html"), `<!doctype html><head>${pocketScript}</head>`);
  writeFileSync(join(pocket, "assets", "index-p.js"), "export {};\n");
  writeFileSync(join(pocket, "sw.js"), "self.addEventListener('push', () => {});\n");
  writeFileSync(join(pocket, "manifest.webmanifest"), "{}");
  writeFileSync(join(pocket, "diagnostics", "index.html"), "<!doctype html>");
  const oneTime = join(root, "dist-one-time");
  mkdirSync(join(oneTime, "assets"), { recursive: true });
  writeFileSync(join(oneTime, "index.html"), `<!doctype html><head>${oneTimeScript}</head>`);
  writeFileSync(join(oneTime, "assets", "index-abc.js"), "export {};\n");
  const assets = join(root, "dist", "relay");
  mkdirSync(join(assets, "connect", "assets"), { recursive: true });
  writeFileSync(join(assets, "connect", "assets", "stale.js"), "");
  writeFileSync(join(assets, "stray.html"), "<!doctype html><title>stray</title>");
  return { pocket, oneTime, assets, root };
}

test("Pocket lands at the root and the one-time page at its path, and they are all the relay's assets hold", () => {
  const { pocket, oneTime, assets } = fixture();
  assert.deepEqual(stageRelay({ pocket, oneTime }, assets), { pocket: 1, oneTime: 1 });
  assert.ok(existsSync(join(assets, "index.html")));
  assert.ok(existsSync(join(assets, "sw.js")));
  assert.ok(existsSync(join(assets, "diagnostics", "index.html")));
  assert.ok(existsSync(join(assets, "connect", "index.html")));
  assert.ok(existsSync(join(assets, "connect", "assets", "index-abc.js")));
  assert.ok(!existsSync(join(assets, "connect", "assets", "stale.js")));
  assert.deepEqual(readdirSync(assets).sort(), [
    "assets",
    "connect",
    "diagnostics",
    "index.html",
    "manifest.webmanifest",
    "sw.js",
  ]);
});

test("a shell its policy would refuse is not staged quietly", () => {
  for (const oneTimeScript of [
    '<script type="module">alert(1)</script>',
    '<script type="module" src="/assets/index-abc.js"></script>',
    '<script type="module" src="https://cdn.example/connect/assets/x.js"></script>',
    "",
  ]) {
    const { pocket, oneTime, assets } = fixture({ oneTimeScript });
    assert.throws(() => stageRelay({ pocket, oneTime }, assets), undefined, oneTimeScript);
  }
  for (const pocketScript of [
    '<script type="module">alert(1)</script>',
    '<script type="module" src="//cdn.example/assets/x.js"></script>',
    "",
  ]) {
    const { pocket, oneTime, assets } = fixture({ pocketScript });
    assert.throws(() => stageRelay({ pocket, oneTime }, assets), undefined, pocketScript);
  }
});

test("a Pocket build reaching into the one-time page's path is refused", () => {
  const { pocket, oneTime, assets } = fixture();
  mkdirSync(join(pocket, "connect"));
  assert.throws(() => stageRelay({ pocket, oneTime }, assets), /one-time page owns/);
});

test("staging refuses to run before either build", () => {
  const { pocket, oneTime, assets } = fixture();
  assert.throws(
    () => stageRelay({ pocket: join(pocket, "missing"), oneTime }, assets),
    /build:pocket/,
  );
  assert.throws(
    () => stageRelay({ pocket, oneTime: join(oneTime, "missing") }, assets),
    /build:one-time/,
  );
});
