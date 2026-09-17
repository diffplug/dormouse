import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = process.argv[2];
if (!source)
  throw new Error("Usage: pnpm pgstencil:sync /path/to/pgstencil [--packed]");
const repository = resolve(source);
const run = (command, args, cwd = repository) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });
if (!process.argv.includes("--packed")) run("pnpm", ["packages:pack"]);
const manifest = JSON.parse(
  readFileSync(resolve(root, "hosted/package.json"), "utf8"),
);
// pnpm resolves `overrides:` ahead of hosted/package.json, so a bump that edits
// only the manifest would still install the previous tarball while build.json
// below records the new one. Read the block by line rather than adding a YAML
// dependency to a root that has no devDependencies at all.
const workspace = readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8");
const overrides = new Map(
  (/^overrides:\n((?:[ \t].*\n?|\n)*)/m.exec(workspace)?.[1] ?? "")
    .split("\n")
    .flatMap((line) => {
      const entry = /^ {2}['"]?([^'":]+)['"]?: *(\S+)$/.exec(line);
      return entry ? [[entry[1], entry[2]]] : [];
    }),
);
mkdirSync(resolve(root, "vendor"), { recursive: true });
const files = [];
for (const [directory, name] of [
  ["pgstencil", "pgstencil"],
  ["auth", "@pgstencil/auth"],
]) {
  const pkg = JSON.parse(
    readFileSync(
      resolve(repository, `packages/${directory}/package.json`),
      "utf8",
    ),
  );
  const filename = `${name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`;
  if (manifest.dependencies[name] !== `file:../vendor/${filename}`)
    throw new Error(`Update hosted/package.json for ${filename}`);
  if (overrides.get(name) !== `file:vendor/${filename}`)
    throw new Error(
      `Update the pnpm-workspace.yaml override for ${name} to file:vendor/${filename}`,
    );
  const target = resolve(root, "vendor", filename);
  copyFileSync(resolve(repository, "dist/packages", filename), target);
  files.push({
    filename,
    sha256: createHash("sha256").update(readFileSync(target)).digest("hex"),
  });
}
const git = (...args) =>
  execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
writeFileSync(
  resolve(root, "vendor/build.json"),
  JSON.stringify(
    {
      commit: git("rev-parse", "HEAD"),
      dirty: !!git("status", "--porcelain"),
      files,
    },
    null,
    2,
  ) + "\n",
);
// A changed tarball integrity is resolved by a normal install. --force also
// installs foreign-platform optional binaries and distorts dependency disclosure.
run(
  "pnpm",
  ["--filter", "dormouse-hosted", "update", "pgstencil", "@pgstencil/auth"],
  root,
);
