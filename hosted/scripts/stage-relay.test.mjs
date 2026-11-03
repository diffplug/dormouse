import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageConnect } from "./stage-connect.mjs";
import { stageRelay } from "./stage-relay.mjs";

/**
 * A `lib/dist-pocket` and `lib/dist-one-time` whose shells load `pocketScript`
 * and `oneTimeScript`, and each Worker's assets directory from an earlier build.
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
  const connect = join(root, "dist", "connect");
  mkdirSync(join(connect, "connect", "assets"), { recursive: true });
  writeFileSync(join(connect, "connect", "assets", "stale.js"), "");
  writeFileSync(join(connect, "stray.html"), "<!doctype html><title>stray</title>");
  return { pocket, oneTime, assets, connect, root };
}

test("Pocket lands at the root, and it is all the relay's assets hold: no one-time page beside it", () => {
  const { pocket, assets } = fixture();
  assert.equal(stageRelay(pocket, assets), 1);
  assert.ok(existsSync(join(assets, "index.html")));
  assert.ok(existsSync(join(assets, "sw.js")));
  assert.ok(existsSync(join(assets, "diagnostics", "index.html")));
  assert.deepEqual(readdirSync(assets).sort(), [
    "assets",
    "deployment.json",
    "diagnostics",
    "index.html",
    "manifest.webmanifest",
    "sw.js",
  ]);
  // What tells the one Pocket bundle that Hosted serves it.
  assert.deepEqual(JSON.parse(readFileSync(join(assets, "deployment.json"), "utf8")), {
    deployment: "hosted",
  });
});

test("the one-time page lands at its path, and it is all the connect Worker's assets hold", () => {
  const { oneTime, connect } = fixture();
  assert.equal(stageConnect(oneTime, connect), 1);
  assert.ok(existsSync(join(connect, "connect", "index.html")));
  assert.ok(existsSync(join(connect, "connect", "assets", "index-abc.js")));
  assert.ok(!existsSync(join(connect, "connect", "assets", "stale.js")));
  assert.deepEqual(readdirSync(connect), ["connect"]);
});

test("a Pocket build carrying the deployment file is refused, since a self-host Relay serves it as it is", () => {
  const { pocket, assets } = fixture();
  writeFileSync(join(pocket, "deployment.json"), '{"deployment":"hosted"}');
  assert.throws(() => stageRelay(pocket, assets), /only Hosted's staging writes/);
});

test("a shell its policy would refuse is not staged quietly", () => {
  for (const oneTimeScript of [
    '<script type="module">alert(1)</script>',
    '<script type="module" src="/assets/index-abc.js"></script>',
    '<script type="module" src="https://cdn.example/connect/assets/x.js"></script>',
    "",
  ]) {
    const { oneTime, connect } = fixture({ oneTimeScript });
    assert.throws(() => stageConnect(oneTime, connect), undefined, oneTimeScript);
  }
  for (const pocketScript of [
    '<script type="module">alert(1)</script>',
    '<script type="module" src="//cdn.example/assets/x.js"></script>',
    "",
  ]) {
    const { pocket, assets } = fixture({ pocketScript });
    assert.throws(() => stageRelay(pocket, assets), undefined, pocketScript);
  }
});

test("staging refuses to run before its build", () => {
  const { pocket, oneTime, assets, connect } = fixture();
  assert.throws(() => stageRelay(join(pocket, "missing"), assets), /build:pocket/);
  assert.throws(() => stageConnect(join(oneTime, "missing"), connect), /build:one-time/);
});
