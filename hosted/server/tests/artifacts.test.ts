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
