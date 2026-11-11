import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  assert.ok(!existsSync(assets));
});

test("refuses a missing build and removes stale output", () => {
  const { built, assets } = fixture();
  assert.throws(() => stageFrames(join(built, "nowhere"), assets), /holds no build/);
  assert.ok(!existsSync(assets));
});

for (const name of ["extra.txt", "__dormouse-frame/bootstrap.js", "__dormouse-frame/linked-dir"]) {
  test(`refuses a symlink at ${name} and removes the rejected output`, () => {
    const { built, assets } = fixture();
    const target = join(built, "..", "outside");
    // Directory junctions need no Windows symlink privilege and exercise the
    // same non-regular Dirent rejection, including an expected asset name.
    mkdirSync(target);
    writeFileSync(join(target, "secret.txt"), "must never be staged");
    const link = join(built, name);
    rmSync(link, { force: true });
    symlinkSync(target, link, "junction");
    assert.throws(() => stageFrames(built, assets), /non-regular entry/);
    assert.ok(!existsSync(assets));
  });
}

test("refuses an extra file symlink without retaining it", { skip: process.platform === "win32" }, () => {
  const { built, assets } = fixture();
  symlinkSync(join(built, "__dormouse-frame-sw.js"), join(built, "extra.txt"));
  assert.throws(() => stageFrames(built, assets), /non-regular entry/);
  assert.ok(!existsSync(assets));
});

test("refuses a build missing a required asset", () => {
  const { built, assets } = fixture();
  rmSync(join(built, "__dormouse-frame-sw.js"));
  assert.throws(() => stageFrames(built, assets), /not .*__dormouse-frame-sw/);
  assert.ok(!existsSync(assets));
});
