import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageFrames } from "./stage-frames.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stage-frames-"));
  const built = join(root, "dist-frame-origin");
  mkdirSync(join(built, "__dormouse-frame"), { recursive: true });
  writeFileSync(join(built, "__dormouse-frame-sw.js"), "");
  writeFileSync(join(built, "__dormouse-frame", "bootstrap.js"), "");
  writeFileSync(join(built, "__dormouse-frame", "bootstrap.html"), "");
  const assets = join(root, "dist", "frames");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, "stale.js"), "");
  return { built, assets };
}

test("stages the three files, and clears what an earlier build left", () => {
  const { built, assets } = fixture();
  stageFrames(built, assets);
  assert.ok(existsSync(join(assets, "__dormouse-frame-sw.js")));
  assert.ok(!existsSync(join(assets, "stale.js")));
});

test("reads a Windows path's backslashes as the slashes the list spells", () => {
  const root = mkdtempSync(join(tmpdir(), "stage-frames-"));
  const built = join(root, "dist-frame-origin");
  mkdirSync(built, { recursive: true });
  writeFileSync(join(built, "__dormouse-frame-sw.js"), "");
  // What `path.join` makes of the nested two there, spelled here as flat names.
  writeFileSync(join(built, "__dormouse-frame\\bootstrap.js"), "");
  writeFileSync(join(built, "__dormouse-frame\\bootstrap.html"), "");
  stageFrames(built, join(root, "assets"));
});

test("refuses a build holding anything else, which would be served beside a page", () => {
  const { built, assets } = fixture();
  writeFileSync(join(built, "extra.js"), "");
  assert.throws(() => stageFrames(built, assets), /extra\.js/);
});

test("refuses a build missing a file", () => {
  const { built, assets } = fixture();
  assert.throws(() => stageFrames(join(built, "nowhere"), assets), /holds no build/);
});
