import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertWorkspaceCoverage, getDependencyNames } from "./dependency-workspaces.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const npmOutPath = resolve(__dirname, "../src/data/dependencies-npm.json");
const cargoOutPath = resolve(__dirname, "../src/data/dependencies-cargo.json");
const runtimeOutPath = resolve(__dirname, "../src/data/dependencies-runtime.json");
const cargoManifestPath = resolve(repoRoot, "standalone/src-tauri/Cargo.toml");
const rootPackageJsonPath = resolve(repoRoot, "package.json");
const themeExtensionsPath = resolve(repoRoot, "lib/src/lib/themes/bundled-extensions.json");
// The workspace packages whose runtime dependency graphs a user actually runs.
// A package belongs here if its dependencies reach a user's disk, however they
// get there: `dormouse-sidecar` ships as a Tauri bundle resource
// (`standalone/src-tauri/tauri.conf.json` -> `bundle.resources`), node_modules
// and all, and `relay` is installed and run by a selfhoster (SELF_HOST.md) —
// `web-push` in particular signs with a private key and makes outbound
// requests. See docs/specs/security-supply-chain.md -> "Disclosure".
const productDependencyFilters = [
  "dor",
  "dormouse",
  "dormouse-standalone",
  "dormouse-lib",
  "dormouse-sidecar",
  "relay",
];
// These packages do not install an artifact on a user's disk. Any new workspace
// requires classification here or a runtime edge from a product root.
const excludedWorkspacePackages = ["canopy", "dormouse-website", "dormouse-hosted"];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function parseWorkspacePackageDirs() {
  const workspaceYaml = readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf-8");
  const dirs = [];
  let inPackages = false;
  for (const line of workspaceYaml.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;

    const match = inPackages ? line.match(/^\s*-\s+["']?(.+?)["']?\s*$/) : null;
    if (match) dirs.push(match[1]);
  }
  return dirs;
}

function getWorkspacePackages() {
  return parseWorkspacePackageDirs().map((dir) => {
    const absoluteDir = resolve(repoRoot, dir);
    return {
      dir: absoluteDir,
      pkg: readJson(resolve(absoluteDir, "package.json")),
    };
  });
}

function getPackageJsonPath(fromDir, packageName) {
  let dir = fromDir;
  while (true) {
    const candidate = resolve(dir, "node_modules", packageName, "package.json");
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function formatAuthor(author) {
  if (!author) return null;
  if (typeof author === "string") return author;
  return author.name || author.email || author.url || null;
}

function normalizeRepositoryUrl(repository) {
  const repositoryUrl = typeof repository === "string" ? repository : repository?.url;
  if (!repositoryUrl) return null;
  if (/^[\w.-]+\/[\w.-]+/.test(repositoryUrl)) {
    return `https://github.com/${repositoryUrl}`;
  }

  return repositoryUrl
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/\.git$/, "");
}

function getHomepage(pkg) {
  if (pkg.homepage) return pkg.homepage;
  return normalizeRepositoryUrl(pkg.repository);
}

const workspacePackages = getWorkspacePackages();
assertWorkspaceCoverage(workspacePackages, productDependencyFilters, excludedWorkspacePackages);
const workspacePackagesByName = new Map(workspacePackages.map((workspacePackage) => [
  workspacePackage.pkg.name,
  workspacePackage,
]));
const productRoots = new Set(productDependencyFilters);
const externalPackages = new Map();
const visitedExternalPackagePaths = new Set();
const visitedWorkspacePackageNames = new Set();
/**
 * Optional dependencies of a product root this machine cannot install, mapped to
 * the siblings they may be described from. See
 * docs/specs/security-supply-chain.md -> "Disclosure".
 */
const undescribedPackages = new Map();

/**
 * Identity of a disclosed package. Two installs of one name that agree on all
 * four fields are one row with two versions; a disagreement is two rows.
 */
function externalPackageKey({ name, license, author, homepage }) {
  return [name, license ?? "", author ?? "", homepage ?? ""].join("\0");
}

function addExternalPackage(pkg) {
  const identity = {
    name: pkg.name,
    license: pkg.license ?? null,
    author: formatAuthor(pkg.author),
    homepage: getHomepage(pkg),
  };
  const key = externalPackageKey(identity);
  const existing = externalPackages.get(key);
  if (existing) {
    existing.versions.add(pkg.version);
    return;
  }

  externalPackages.set(key, { ...identity, versions: new Set([pkg.version]) });
}

/**
 * The names declared beside `packageName` in the same `optionalDependencies`
 * block at the same exact version string. A prebuilt family is published in
 * lockstep from one repository under one pinned version, so any of these
 * describes the absent one exactly — which is also what keeps this disclosure
 * identical on every machine that generates it.
 */
function optionalSiblingsAtSameVersion(pkg, packageName) {
  const optionalDependencies = pkg.optionalDependencies ?? {};
  const version = optionalDependencies[packageName];
  return Object.keys(optionalDependencies).filter(
    (name) => name !== packageName && optionalDependencies[name] === version,
  );
}

function scanWorkspacePackage(name) {
  if (visitedWorkspacePackageNames.has(name)) return;
  const workspacePackage = workspacePackagesByName.get(name);
  if (!workspacePackage) {
    throw new Error(`Workspace package "${name}" was not found`);
  }

  visitedWorkspacePackageNames.add(name);
  scanDependencies(workspacePackage.pkg, workspacePackage.dir);
}

function scanDependency(fromDir, packageName, declaredBy) {
  if (workspacePackagesByName.has(packageName)) {
    scanWorkspacePackage(packageName);
    return;
  }

  const packageJsonPath = getPackageJsonPath(fromDir, packageName);
  if (!packageJsonPath) {
    // Absent by design rather than under-reported, in one of two ways. An
    // optional dependency of an external package ships to nobody: the Tauri
    // bundle copies `standalone/sidecar/node_modules`, and pnpm puts a package
    // there only if that manifest declares it — the addon's own list also names
    // builds this project never releases (android, musl). An optional
    // dependency a product root declares itself does ship, on the platform that
    // can hold it, so it is described from a sibling below. Anything else
    // missing is still a hard error.
    if (declaredBy.optional) {
      if (declaredBy.isProductRoot) {
        undescribedPackages.set(
          packageName,
          optionalSiblingsAtSameVersion(declaredBy.pkg, packageName),
        );
      }
      return;
    }
    throw new Error(`Could not resolve package.json for "${packageName}" from ${fromDir}`);
  }

  const realPackageJsonPath = realpathSync(packageJsonPath);
  if (visitedExternalPackagePaths.has(realPackageJsonPath)) return;
  visitedExternalPackagePaths.add(realPackageJsonPath);

  const pkg = readJson(realPackageJsonPath);
  addExternalPackage(pkg);
  scanDependencies(pkg, dirname(realPackageJsonPath));
}

function scanDependencies(pkg, fromDir) {
  const isProductRoot = productRoots.has(pkg.name);
  for (const { name, optional } of getDependencyNames(pkg)) {
    scanDependency(fromDir, name, { pkg, optional, isProductRoot });
  }
}

for (const packageName of productDependencyFilters) {
  scanWorkspacePackage(packageName);
}

// Snapshotted before the loop writes to `externalPackages`, so nothing is ever
// described from something that was itself described rather than read.
const describedPackagesByName = new Map();
for (const pkg of externalPackages.values()) {
  if (!describedPackagesByName.has(pkg.name)) describedPackagesByName.set(pkg.name, pkg);
}
for (const [packageName, siblings] of undescribedPackages) {
  const sibling = siblings.map((name) => describedPackagesByName.get(name)).find(Boolean);
  if (!sibling) {
    throw new Error(
      `"${packageName}" is not installed and neither is any sibling declared beside it at the same version, so it cannot be described`,
    );
  }
  const described = { ...sibling, name: packageName, versions: new Set(sibling.versions) };
  externalPackages.set(externalPackageKey(described), described);
}

// Within a single "A OR B OR ..." choice, move MIT to the front so the
// listing reads consistently (MIT is the license we expect most often).
function moveMitFirstInOrGroup(orExpression) {
  const choices = orExpression.split(/\s+OR\s+/);
  const mitIndex = choices.indexOf("MIT");
  if (mitIndex <= 0) return orExpression;
  choices.unshift(choices.splice(mitIndex, 1)[0]);
  return choices.join(" OR ");
}

function normalizeLicense(license) {
  if (!license) return null;
  // Legacy dual-license syntax uses "/" to mean "OR" (e.g. "Apache-2.0/MIT").
  const normalized = license.replace(/\s*\/\s*/g, " OR ");
  // Reorder OR choices, both standalone and inside parenthesized groups
  // (e.g. "(Apache-2.0 OR MIT) AND BSD-3-Clause"). AND expressions are
  // conjunctive, so their operand order is left untouched.
  if (normalized.includes("(")) {
    return normalized.replace(/\(([^()]+)\)/g, (_, inner) => `(${moveMitFirstInOrGroup(inner)})`);
  }
  if (normalized.includes(" AND ")) return normalized;
  return moveMitFirstInOrGroup(normalized);
}

const deps = [...externalPackages.values()].map((pkg) => ({
  name: pkg.name,
  version: [...pkg.versions].sort().join(", "),
  license: normalizeLicense(pkg.license),
  author: pkg.author,
  homepage: pkg.homepage,
}));

// Merge in bundled theme extensions from OpenVSX
const themeExtensions = JSON.parse(readFileSync(themeExtensionsPath, "utf-8"));

// OpenVSX exposes VS Code's bundled default themes as several built-in
// theme extension records. Show them as one dependency on the website.
const isVscodeBuiltInTheme = (dep) =>
  dep.author === "open-vsx" &&
  dep.homepage === "https://github.com/eclipse-theia/vscode-builtin-extensions#readme" &&
  (dep.name === "Default Themes (built-in)" || dep.name.endsWith(" Theme (built-in)"));

const vscodeBuiltInThemes = themeExtensions.filter(isVscodeBuiltInTheme);
if (vscodeBuiltInThemes.length > 0) {
  const versions = [...new Set(vscodeBuiltInThemes.map((dep) => dep.version).filter(Boolean))].sort();
  deps.push({
    name: "VS Code built-in themes",
    version: versions.join(", "),
    license: "MIT",
    author: "Microsoft Corporation",
    homepage: "https://github.com/microsoft/vscode/tree/main/extensions",
  });
}
// `extensionId` is the join key that pins these records to the themes actually
// compiled in (lib/src/lib/themes/bundled-extensions.test.ts); the disclosure
// table shows the same five columns as every other row, so project it away.
deps.push(
  ...themeExtensions
    .filter((dep) => !isVscodeBuiltInTheme(dep))
    .map(({ name, version, license, author, homepage }) => ({
      name,
      version,
      license,
      author,
      homepage,
    })),
);

// Manual overrides for dependencies missing license or author in their metadata
const missingLicense = {
  "Solarized & Selenized": "MIT",
};
const missingAuthor = {
  "@hono/node-ws": "Hono middleware contributors",
  // The addon ships a `contributors` array rather than npm's singular `author`
  // field, and its prebuilt platform packages carry neither.
  "@node-datachannel/darwin-arm64": "Murat Doğan, Paul-Louis Ageneau",
  "@node-datachannel/darwin-x64": "Murat Doğan, Paul-Louis Ageneau",
  "@node-datachannel/linux-arm64-gnu": "Murat Doğan, Paul-Louis Ageneau",
  "@node-datachannel/linux-x64-gnu": "Murat Doğan, Paul-Louis Ageneau",
  "@node-datachannel/win32-arm64-msvc": "Murat Doğan, Paul-Louis Ageneau",
  "@node-datachannel/win32-x64-msvc": "Murat Doğan, Paul-Louis Ageneau",
  "node-datachannel": "Murat Doğan, Paul-Louis Ageneau",
  "@tauri-apps/api": "Tauri Apps Contributors",
  "@tauri-apps/plugin-shell": "Tauri Apps Contributors",
  "@tauri-apps/plugin-updater": "Tauri Apps Contributors",
  "@xterm/xterm": "Christopher Jeffrey, SourceLair Private Company, xterm.js authors",
  // Both ship an `authors` array rather than npm's singular `author` field.
  "@zxing/browser": "David Werth, Luiz Barni",
  "@zxing/library": "Adrian Toșcă, David Werth, Luiz Barni",
  "atomically": "Fabio Spampinato",
  "inherits": "Isaac Z. Schlueter",
  "minimalistic-assert": "Calvin Metcalf",
  "ms": "Vercel, Inc.",
  "node-addon-api": "Node.js API collaborators",
  "pngjs": "pngjs contributors",
  "react": "Meta Platforms, Inc. and affiliates",
  "react-dom": "Meta Platforms, Inc. and affiliates",
  "scheduler": "Meta Platforms, Inc. and affiliates",
  "stubborn-fs": "Fabio Spampinato",
  "stubborn-utils": "Fabio Spampinato",
  "tailwindcss": "Tailwind Labs, Inc.",
  "when-exit": "Fabio Spampinato",
};
for (const dep of deps) {
  if (!dep.license) {
    const override = missingLicense[dep.name];
    if (!override) {
      console.error(`ERROR: "${dep.name}" has no license. Add it to missingLicense in generate-deps.js`);
      process.exit(1);
    }
    dep.license = override;
  }
  if (!dep.author) {
    const override = missingAuthor[dep.name];
    if (!override) {
      console.error(`ERROR: "${dep.name}" has no author. Add it to missingAuthor in generate-deps.js`);
      process.exit(1);
    }
    dep.author = override;
  }
}

deps.sort((a, b) => a.name.localeCompare(b.name));

// Manual overrides for Cargo crates whose published Cargo.toml omits author or
// homepage metadata. Keyed by crate name. libappindicator{,-sys} ship empty
// `authors`/`homepage`/`repository`, so cargo metadata yields null for both.
const cargoMissingAuthor = {
  "libappindicator": "Tauri Apps Contributors",
  "libappindicator-sys": "Tauri Apps Contributors",
};
const cargoMissingHomepage = {
  "libappindicator": "https://github.com/tauri-apps/libappindicator-rs",
  "libappindicator-sys": "https://github.com/tauri-apps/libappindicator-rs",
};

function getCargoHomepage(pkg) {
  return pkg.homepage || pkg.repository || pkg.documentation || null;
}

function formatCargoAuthor(authors) {
  if (!authors || authors.length === 0) return null;
  return authors.join(", ");
}

function cargoPackageEntry(pkg) {
  return {
    name: pkg.name,
    version: pkg.version,
    license: normalizeLicense(pkg.license),
    author: formatCargoAuthor(pkg.authors) ?? cargoMissingAuthor[pkg.name] ?? null,
    homepage: getCargoHomepage(pkg) ?? cargoMissingHomepage[pkg.name] ?? null,
  };
}

function compareDependencyEntries(a, b) {
  return a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
}

function getCargoMetadata() {
  return JSON.parse(
    execFileSync("cargo", [
      "metadata",
      "--format-version",
      "1",
      "--locked",
      "--manifest-path",
      cargoManifestPath,
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024 * 64,
    }),
  );
}

function getManifestDependencyByName(manifestDependencies, name) {
  return manifestDependencies.find((dep) => (dep.rename || dep.name).replaceAll("-", "_") === name);
}

function getCargoDependencies() {
  const metadata = getCargoMetadata();
  const rootPackage = metadata.packages.find((pkg) => pkg.id === metadata.resolve.root);
  const rootNode = metadata.resolve.nodes.find((node) => node.id === metadata.resolve.root);
  if (!rootPackage || !rootNode) {
    throw new Error("Could not find root package in Cargo metadata");
  }

  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const directIds = new Set(rootNode.deps.map((dep) => dep.pkg));

  const direct = rootNode.deps.map((dep) => {
    const pkg = packagesById.get(dep.pkg);
    if (!pkg) throw new Error(`Could not find Cargo package ${dep.pkg}`);

    const manifestDep = getManifestDependencyByName(rootPackage.dependencies, dep.name);
    return {
      ...cargoPackageEntry(pkg),
      declaredName: manifestDep?.rename || manifestDep?.name || dep.name.replaceAll("_", "-"),
    };
  }).sort(compareDependencyEntries);

  const transitive = metadata.packages
    .filter((pkg) => pkg.id !== metadata.resolve.root && !directIds.has(pkg.id))
    .map(cargoPackageEntry)
    .sort(compareDependencyEntries);

  return { direct, transitive };
}

const cargoDeps = getCargoDependencies();

// Bundled runtime: the standalone app ships a Node.js binary as a Tauri
// sidecar (see standalone/src-tauri/build.rs). Its version is pinned exactly in
// the root package.json's devEngines.runtime.version, and build.rs fails the
// build unless the bundled binary matches that pin — so the version disclosed
// here provably equals what ships.
function getBundledRuntimeDependencies() {
  const pkg = readJson(rootPackageJsonPath);
  const nodeVersion = String(pkg?.devEngines?.runtime?.version ?? "").trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) {
    console.error(
      `ERROR: package.json devEngines.runtime.version must pin an exact Node.js version (e.g. 24.18.0), found "${nodeVersion}"`,
    );
    process.exit(1);
  }
  return [
    {
      name: "Node.js",
      version: nodeVersion,
      license: "MIT and bundled component licenses",
      author: "OpenJS Foundation and Node.js contributors",
      homepage: "https://github.com/nodejs/node",
    },
  ];
}

const runtimeDeps = getBundledRuntimeDependencies();

writeFileSync(npmOutPath, JSON.stringify(deps, null, 2) + "\n");
writeFileSync(cargoOutPath, JSON.stringify(cargoDeps, null, 2) + "\n");
writeFileSync(runtimeOutPath, JSON.stringify(runtimeDeps, null, 2) + "\n");
console.log(`Wrote ${deps.length} dependencies to src/data/dependencies-npm.json`);
console.log(
  `Wrote ${cargoDeps.direct.length} direct and ${cargoDeps.transitive.length} transitive Cargo dependencies to src/data/dependencies-cargo.json`,
);
console.log(`Wrote ${runtimeDeps.length} bundled runtime to src/data/dependencies-runtime.json`);
