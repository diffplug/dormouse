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
const args = process.argv.slice(2);
// There are no flags, so a stray one (such as the removed --working-tree) must
// not be read as a path or a revision.
if (
  args.length < 1 ||
  args.length > 2 ||
  args.some((arg) => arg.startsWith("-"))
)
  throw new Error("Usage: pnpm pgstencil:sync /path/to/pgstencil [revision]");
const [source, revision = "HEAD"] = args;
const repository = resolve(source);
const run = (command, args, cwd, env = process.env) =>
  execFileSync(command, args, { cwd, stdio: "inherit", env });
const git = (...args) =>
  execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
const succeeds = (attempt) => {
  try {
    attempt();
    return true;
  } catch {
    return false;
  }
};
// Every pgstencil pack writes package/dist/provenance.json: the archive's own
// claim of the commit it came from, plus `dirty` when it was packed
// --allow-dirty. Dormouse verifies that claim instead of auditing the packed
// code, which pgstencil audits in its own repository —
// docs/specs/security-hosted.md -> "Deployment boundary".
const provenanceOf = (archive) => {
  let raw;
  try {
    raw = execFileSync(
      "tar",
      ["-xOf", archive, "package/dist/provenance.json"],
      { encoding: "utf8" },
    );
  } catch {
    throw new Error(`${archive} carries no package/dist/provenance.json`);
  }
  let claim;
  try {
    claim = JSON.parse(raw);
  } catch {
    throw new Error(`${archive}: package/dist/provenance.json is not JSON`);
  }
  if (typeof claim?.commit !== "string" || !/^[0-9a-f]{40}$/.test(claim.commit))
    throw new Error(`${archive}: provenance.json names no commit`);
  return claim;
};
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
// reach an archive, and build.json truthfully records `dirty: false`. To try an
// unfinished pgstencil change, commit it to a local branch and sync that. Each
// archive's own provenance must name `commit`; a pack that reports itself
// dirty (pgstencil's --allow-dirty) is refused below rather than vendored.
const commit = git("rev-parse", "--verify", `${revision}^{commit}`);
// Check the pins before the slow install and before any archive is replaced.
const read = (path) => git("show", `${commit}:${path}`);
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
const checkout = mkdtempSync(join(tmpdir(), "pgstencil-sync-"));
// pgstencil's scripts locate their project from this variable before the cwd.
const pgstencil = { ...process.env, PGSTENCIL_PROJECT_ROOT: checkout };
git("worktree", "add", "--detach", checkout, commit);
try {
  run("pnpm", ["install", "--frozen-lockfile"], checkout, pgstencil);
  run("pnpm", ["packages:pack"], checkout, pgstencil);
  mkdirSync(resolve(root, "vendor"), { recursive: true });
  for (const filename of archives) {
    const target = resolve(root, "vendor", filename);
    copyFileSync(resolve(checkout, "dist/packages", filename), target);
    // Both archives are held to the commit packed here, so a stale pack —
    // or two archives disagreeing with each other — stops the sync before
    // build.json can record a commit the bytes do not carry.
    const claim = provenanceOf(target);
    if (claim.dirty === true)
      throw new Error(
        `${filename} was packed --allow-dirty; a dirty pack cannot be vendored`,
      );
    if (claim.commit !== commit)
      throw new Error(
        `${filename} was packed from ${claim.commit}, not the ${commit} packed here`,
      );
  }
} finally {
  git("worktree", "remove", "--force", checkout);
}
const files = archives.map((filename) => ({
  filename,
  sha256: createHash("sha256")
    .update(readFileSync(resolve(root, "vendor", filename)))
    .digest("hex"),
}));
writeFileSync(
  resolve(root, "vendor/build.json"),
  JSON.stringify({ commit, dirty: false, files }, null, 2) + "\n",
);
// A changed tarball integrity is resolved by a normal install. --force also
// installs foreign-platform optional binaries and distorts dependency disclosure.
run(
  "pnpm",
  ["--filter", "dormouse-hosted", "update", "pgstencil", "@pgstencil/auth"],
  root,
);
// Dormouse `main` must vendor a pgstencil `main` commit, because the nightly
// audit reads that commit's pgstencil `security-audit` check run — but a
// Dormouse branch may vendor a pgstencil branch while a cross-repo change is
// in flight, so this warns and does not fail.
const fetched = succeeds(() => git("fetch", "origin", "main"));
const onMain =
  fetched &&
  succeeds(() => git("merge-base", "--is-ancestor", commit, "origin/main"));
if (!onMain)
  console.warn(
    fetched
      ? `warning: pgstencil ${commit} is not on origin/main — Dormouse main must vendor a pgstencil main commit, and the nightly audit fails until it does`
      : `warning: could not fetch pgstencil origin/main to check ${commit} — Dormouse main must vendor a pgstencil main commit`,
  );
