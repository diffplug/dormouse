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
const usage =
  "Usage: pnpm pgstencil:sync /path/to/pgstencil [<revision> | --working-tree]";
const [source, ...options] = process.argv.slice(2);
const revisions = options.filter((option) => !option.startsWith("--"));
const workingTree = options.includes("--working-tree");
// A mistyped flag must not fall back to a clean sync of HEAD, which would
// overwrite the archives with something other than what was asked for.
if (
  !source ||
  options.some(
    (option) => option.startsWith("--") && option !== "--working-tree",
  ) ||
  revisions.length > (workingTree ? 0 : 1)
)
  throw new Error(usage);
const repository = resolve(source);
const revision = revisions[0] ?? "HEAD";
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
// Pack a committed revision in a temporary worktree after a frozen install, so
// nothing uncommitted, untracked or ignored in the pgstencil checkout (a stray
// migration, editor settings, stale build output, a local node_modules) can
// reach an archive, and build.json truthfully records `dirty: false`.
// --working-tree packs the checkout as it stands, for trying unfinished
// pgstencil changes. That result depends on local state even when git status is
// clean, so it is always recorded dirty and production preflight refuses it.
const commit = git(
  "rev-parse",
  "--verify",
  `${workingTree ? "HEAD" : revision}^{commit}`,
);
const dirty = workingTree;
// Check the pins before the slow install and before any archive is replaced.
const read = (path) =>
  workingTree
    ? readFileSync(resolve(repository, path), "utf8")
    : git("show", `${commit}:${path}`);
const archives = [
  ["pgstencil", "pgstencil"],
  ["auth", "@pgstencil/auth"],
].map(([directory, name]) => {
  const { version } = JSON.parse(read(`packages/${directory}/package.json`));
  const filename = `${name.replace("@", "").replace("/", "-")}-${version}.tgz`;
  if (manifest.dependencies[name] !== `file:../vendor/${filename}`)
    throw new Error(`Update hosted/package.json for ${filename}`);
  if (overrides.get(name) !== `file:vendor/${filename}`)
    throw new Error(
      `Update the pnpm-workspace.yaml override for ${name} to file:vendor/${filename}`,
    );
  return filename;
});
const checkout = workingTree
  ? repository
  : mkdtempSync(join(tmpdir(), "pgstencil-sync-"));
// pgstencil's scripts locate their project from this variable before the cwd.
const pgstencil = { ...process.env, PGSTENCIL_PROJECT_ROOT: checkout };
if (!workingTree) git("worktree", "add", "--detach", checkout, commit);
try {
  if (!workingTree)
    run("pnpm", ["install", "--frozen-lockfile"], checkout, pgstencil);
  run("pnpm", ["packages:pack"], checkout, pgstencil);
  mkdirSync(resolve(root, "vendor"), { recursive: true });
  for (const filename of archives)
    copyFileSync(
      resolve(checkout, "dist/packages", filename),
      resolve(root, "vendor", filename),
    );
} finally {
  if (!workingTree) git("worktree", "remove", "--force", checkout);
}
const files = archives.map((filename) => ({
  filename,
  sha256: createHash("sha256")
    .update(readFileSync(resolve(root, "vendor", filename)))
    .digest("hex"),
}));
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
