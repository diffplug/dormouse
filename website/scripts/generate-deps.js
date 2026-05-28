import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const npmOutPath = resolve(__dirname, "../src/data/dependencies-npm.json");
const cargoOutPath = resolve(__dirname, "../src/data/dependencies-cargo.json");
const runtimeOutPath = resolve(__dirname, "../src/data/dependencies-runtime.json");
const cargoManifestPath = resolve(repoRoot, "standalone/src-tauri/Cargo.toml");
const rootPackageJsonPath = resolve(repoRoot, "package.json");
const themeExtensionsPath = resolve(repoRoot, "lib/src/lib/themes/bundled-extensions.json");
const productDependencyFilters = [
  "dormouse",
  "dormouse-standalone",
  "dormouse-lib",
];

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

function getDependencyNames(pkg) {
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ];
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
const workspacePackagesByName = new Map(workspacePackages.map((workspacePackage) => [
  workspacePackage.pkg.name,
  workspacePackage,
]));
const externalPackages = new Map();
const visitedExternalPackagePaths = new Set();
const visitedWorkspacePackageNames = new Set();

function addExternalPackage(pkg) {
  const key = [
    pkg.name,
    pkg.license ?? "",
    formatAuthor(pkg.author) ?? "",
    getHomepage(pkg) ?? "",
  ].join("\0");
  const existing = externalPackages.get(key);
  if (existing) {
    existing.versions.add(pkg.version);
    return;
  }

  externalPackages.set(key, {
    name: pkg.name,
    versions: new Set([pkg.version]),
    license: pkg.license ?? null,
    author: formatAuthor(pkg.author),
    homepage: getHomepage(pkg),
  });
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

function scanDependency(fromDir, packageName) {
  if (workspacePackagesByName.has(packageName)) {
    scanWorkspacePackage(packageName);
    return;
  }

  const packageJsonPath = getPackageJsonPath(fromDir, packageName);
  if (!packageJsonPath) {
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
  for (const packageName of getDependencyNames(pkg)) {
    scanDependency(fromDir, packageName);
  }
}

for (const packageName of productDependencyFilters) {
  scanWorkspacePackage(packageName);
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
deps.push(...themeExtensions.filter((dep) => !isVscodeBuiltInTheme(dep)));

// Manual overrides for dependencies missing license or author in their metadata
const missingLicense = {
  "Solarized & Selenized": "MIT",
};
const missingAuthor = {
  "@tauri-apps/api": "Tauri Apps Contributors",
  "@tauri-apps/plugin-shell": "Tauri Apps Contributors",
  "@tauri-apps/plugin-updater": "Tauri Apps Contributors",
  "@xterm/xterm": "Christopher Jeffrey, SourceLair Private Company, xterm.js authors",
  "atomically": "Fabio Spampinato",
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
      `ERROR: package.json devEngines.runtime.version must pin an exact Node.js version (e.g. 22.17.1), found "${nodeVersion}"`,
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
