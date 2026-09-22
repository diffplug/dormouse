import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("consumed package bytes match the recorded source snapshot", () => {
  const provenance = JSON.parse(
    readFileSync("../vendor/build.json", "utf8"),
  ) as {
    commit: string;
    files: { filename: string; sha256: string }[];
  };
  expect(provenance.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(provenance.files.map((file) => file.filename).sort()).toEqual([
    "pgstencil-0.1.0.tgz",
    "pgstencil-auth-0.1.0.tgz",
  ]);
  for (const file of provenance.files)
    expect(
      createHash("sha256")
        .update(readFileSync("../vendor/" + file.filename))
        .digest("hex"),
    ).toBe(file.sha256);
  // Same-version tarball refreshes must update installed code as well as metadata.
  for (const [archive, entry] of [
    ["pgstencil-0.1.0.tgz", "pgstencil"],
    ["pgstencil-auth-0.1.0.tgz", "@pgstencil/auth/better-auth"],
  ]) {
    const file = fileURLToPath(import.meta.resolve(entry));
    const archivePath = `package/dist/${file.split("/").at(-1)}`;
    const packed = execFileSync("tar", [
      "-xOf",
      "../vendor/" + archive,
      archivePath,
    ]);
    expect(readFileSync(file)).toEqual(packed);
  }
});

// pnpm resolves the workspace override ahead of hosted/package.json, so a bump
// that edits only one of them installs a build the snapshot above never saw.
test("both pinned specifiers name the recorded archives", () => {
  const { dependencies } = JSON.parse(
    readFileSync("package.json", "utf8"),
  ) as { dependencies: Record<string, string> };
  const workspace = readFileSync("../pnpm-workspace.yaml", "utf8");
  for (const [name, filename] of [
    ["pgstencil", "pgstencil-0.1.0.tgz"],
    ["@pgstencil/auth", "pgstencil-auth-0.1.0.tgz"],
  ]) {
    expect(dependencies[name]).toBe(`file:../vendor/${filename}`);
    const override = workspace.match(
      new RegExp(`^ {2}'?${name}'?: (\\S+)$`, "m"),
    )?.[1];
    expect(override).toBe(`file:vendor/${filename}`);
  }
});

// strictPeerDependencies only rejects an out-of-range peer. pnpm resolves an
// undeclared one itself, where Renovate never sees it and Hosted's own imports
// can get a second copy.
test("Hosted declares every peer of the pinned archives", () => {
  const { dependencies } = JSON.parse(
    readFileSync("package.json", "utf8"),
  ) as { dependencies: Record<string, string> };
  for (const archive of ["pgstencil-0.1.0.tgz", "pgstencil-auth-0.1.0.tgz"]) {
    const manifest = execFileSync(
      "tar",
      ["-xOf", "../vendor/" + archive, "package/package.json"],
      { encoding: "utf8" },
    );
    const { peerDependencies = {} } = JSON.parse(manifest) as {
      peerDependencies?: Record<string, string>;
    };
    for (const peer of Object.keys(peerDependencies))
      expect(Object.keys(dependencies), `${archive} peers on ${peer}`).toContain(
        peer,
      );
  }
});
