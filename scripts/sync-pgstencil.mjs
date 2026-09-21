import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [source, ...options] = process.argv.slice(2);
if (!source)
  throw new Error(
    "Usage: pnpm pgstencil:sync /path/to/pgstencil [<revision> | --working-tree]",
  );
const repository = resolve(source);
const workingTree = options.includes("--working-tree");
const revision = options.find((option) => !option.startsWith("--")) ?? "HEAD";
const run = (command, args, cwd, env = process.env) =>
  execFileSync(command, args, { cwd, stdio: "inherit", env });
const git = (...args) =>
  execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
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
// Pack a committed revision in a temporary worktree, so nothing uncommitted or
// untracked in the pgstencil checkout (a stray migration, editor settings) can
// reach an archive, and build.json truthfully records `dirty: false`.
// --working-tree packs the checkout as it stands, for trying unfinished
// pgstencil changes; production preflight refuses that dirty result.
const commit = git(
  "rev-parse",
  "--verify",
  `${workingTree ? "HEAD" : revision}^{commit}`,
);
const dirty = workingTree && !!git("status", "--porcelain");
const checkout = workingTree
  ? repository
  : mkdtempSync(join(tmpdir(), "pgstencil-sync-"));
// pgstencil's scripts locate their project from this variable before the cwd.
const pgstencil = { ...process.env, PGSTENCIL_PROJECT_ROOT: checkout };
if (!workingTree) git("worktree", "add", "--detach", checkout, commit);
const files = [];
try {
  if (!workingTree)
    run("pnpm", ["install", "--frozen-lockfile"], checkout, pgstencil);
  run("pnpm", ["packages:pack"], checkout, pgstencil);
  mkdirSync(resolve(root, "vendor"), { recursive: true });
  for (const [directory, name] of [
    ["pgstencil", "pgstencil"],
    ["auth", "@pgstencil/auth"],
  ]) {
    const pkg = JSON.parse(
      readFileSync(
        resolve(checkout, `packages/${directory}/package.json`),
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
    copyFileSync(resolve(checkout, "dist/packages", filename), target);
    files.push({
      filename,
      sha256: createHash("sha256").update(readFileSync(target)).digest("hex"),
    });
  }
} finally {
  if (!workingTree) git("worktree", "remove", "--force", checkout);
}
writeFileSync(
  resolve(root, "vendor/build.json"),
  JSON.stringify({ commit, dirty, files }, null, 2) + "\n",
);
// A changed tarball integrity is resolved by a normal install. --force also
// installs foreign-platform optional binaries and distorts dependency disclosure.
run(
  "pnpm",
  ["--filter", "dormouse-hosted", "update", "pgstencil", "@pgstencil/auth"],
  root,
);
