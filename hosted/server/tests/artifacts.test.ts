import { test, expect } from "vitest";
import { readFileSync } from "node:fs";

const packages = [
  ["pgstencil", "pgstencil"],
  ["@pgstencil/auth", "@pgstencil/auth/better-auth"],
] as const;

test("Hosted declares every peer of the installed pgstencil packages", () => {
  const { dependencies } = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies: Record<string, string>;
  };
  for (const [name, entry] of packages) {
    const manifest = new URL("../package.json", import.meta.resolve(entry));
    const { peerDependencies = {} } = JSON.parse(readFileSync(manifest, "utf8")) as {
      peerDependencies?: Record<string, string>;
    };
    for (const peer of Object.keys(peerDependencies))
      expect(Object.keys(dependencies), `${name} peers on ${peer}`).toContain(peer);
  }
});

test("the lockfile resolves both pgstencil packages from npm", () => {
  const lockfile = readFileSync("../pnpm-lock.yaml", "utf8");
  const { dependencies } = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies: Record<string, string>;
  };
  for (const [name, entry] of packages) {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.resolve(entry)), "utf8"),
    ) as { version: string };
    expect(dependencies[name]).toBe(`^${manifest.version}`);
    const specifier = `${name}@${manifest.version}`;
    const key = name.startsWith("@") ? `'${specifier}'` : specifier;
    expect(lockfile).toContain(
      `  ${key}:\n    resolution: {integrity: sha512-`,
    );
  }
  expect(lockfile).not.toMatch(/file:[^\s]*pgstencil/);
});
