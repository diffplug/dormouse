// Builds each supported desktop release's own Burrow service, for the gate in
// `server/tests/desktop-compat.gate.ts`: every `vX.Y.Z` tag from the floor in
// `desktop-compat.json` through the newest. Each tag's source is read out of
// git, never this checkout's, and bundled with this checkout's third-party
// packages: the wire is ours, theirs is not.
//
//   node scripts/desktop-builds.mjs   → .wrangler/desktop-compat/<tag>.mjs + releases.json

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { WORKSPACE_SOURCES } from "../../scripts/workspace-sources.mjs";

const hosted = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(hosted, "..");
export const OUT = path.join(hosted, ".wrangler", "desktop-compat");

const RELEASE = /^v(\d+)\.(\d+)\.(\d+)$/;
const parts = (tag) => RELEASE.exec(tag).slice(1).map(Number);
const compare = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** Every release tag at or past `floor`, oldest first. */
export function supportedReleases(tags, floor) {
  if (!RELEASE.test(floor)) throw new Error(`desktop-compat.json floor ${floor} is not a vX.Y.Z tag`);
  return tags.filter((tag) => RELEASE.test(tag) && compare(tag, floor) >= 0).sort(compare);
}

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });

/** Write `dirs` as of `tag` under `tree`, every blob in one `cat-file --batch`. */
function extract(tag, dirs, tree) {
  const blobs = git("ls-tree", "-r", "-z", tag, "--", ...dirs)
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split("\t");
      const [, type, sha] = meta.split(" ");
      return { type, sha, file };
    })
    // Tests and stories reach no bundle.
    .filter((entry) => entry.type === "blob" && !/\.(test|stories)\.[cm]?[jt]sx?$/.test(entry.file));
  const out = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: blobs.map((b) => b.sha).join("\n") + "\n",
    maxBuffer: 1 << 30,
  });
  let at = 0;
  for (const { sha, file } of blobs) {
    const header = out.indexOf(0x0a, at);
    const [got, , size] = out.subarray(at, header).toString().split(" ");
    if (got !== sha) throw new Error(`git cat-file answered ${got} for ${file}`);
    const start = header + 1;
    const target = path.join(tree, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, out.subarray(start, start + Number(size)));
    at = start + Number(size) + 1;
  }
}

/** Each workspace package's own `node_modules`, and the root's, where a bundle finds third-party packages. */
const NODE_PATHS = [...new Set(Object.values(WORKSPACE_SOURCES).map((dir) => dir.split("/")[0])), "."].map((dir) =>
  path.join(root, dir, "node_modules"),
);

/** Extract `tag`'s workspace sources, then bundle its service. */
function buildRelease(tag) {
  const tree = path.join(OUT, "src", tag);
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  extract(tag, Object.values(WORKSPACE_SOURCES), tree);
  const entry = path.join(tree, "desktop-compat-entry.ts");
  writeFileSync(
    entry,
    [
      'export { BurrowService } from "./lib/src/host/remote/service";',
      'export { FileBurrowStateStore } from "./lib/src/host/remote/burrow-state-store";',
      "",
    ].join("\n"),
  );
  return build({
    entryPoints: [entry],
    outfile: path.join(OUT, `${tag}.mjs`),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
    // The tag's own workspace packages; third-party ones from this checkout.
    alias: Object.fromEntries(Object.entries(WORKSPACE_SOURCES).map(([name, dir]) => [name, path.join(tree, dir)])),
    nodePaths: NODE_PATHS,
    // As the sidecar bundles them: `ws` falls back to its JS paths.
    external: ["bufferutil", "utf-8-validate", "node-datachannel"],
    // `ws` is CommonJS: an ESM bundle needs a `require` for its builtins.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
}

async function buildSupportedReleases() {
  const { floor } = JSON.parse(readFileSync(path.join(hosted, "desktop-compat.json"), "utf8"));
  const releases = supportedReleases(git("tag", "--list", "v*").split("\n").filter(Boolean), floor);
  if (!releases.length || releases[0] !== floor)
    throw new Error(`no ${floor} tag here: fetch tags (actions/checkout fetch-depth: 0) before the gate`);
  mkdirSync(OUT, { recursive: true });
  // Extraction is synchronous; the bundles build concurrently.
  await Promise.all(releases.map(buildRelease));
  writeFileSync(path.join(OUT, "releases.json"), JSON.stringify(releases));
  return releases;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const built = await buildSupportedReleases();
  console.log(`built ${built.join(", ")} into ${path.relative(root, OUT)}`);
}
