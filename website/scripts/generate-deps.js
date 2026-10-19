import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCargoGitRepository, getShippedCargoGraph } from "./cargo-dependencies.js";
import { compareVersions, mergeReleases } from "./dependency-rows.js";
import {
  assertWorkspaceCoverage,
  getDependencyNames,
  externalPlatformSiblings,
  linkedPeerPackageJsonPath,
  getWorkspacePackages,
  missingDependency,
  optionalSiblingsAtSameVersion,
} from "./dependency-workspaces.js";
import { excludedWorkspacePackages, productSections } from "./product-sections.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const npmOutPath = resolve(__dirname, "../src/data/dependencies-npm.json");
const cargoOutPath = resolve(__dirname, "../src/data/dependencies-cargo.json");
const runtimeOutPath = resolve(__dirname, "../src/data/dependencies-runtime.json");
const cargoManifestPath = resolve(repoRoot, "standalone/src-tauri/Cargo.toml");
const rootPackageJsonPath = resolve(repoRoot, "package.json");
const themeExtensionsPath = resolve(repoRoot, "lib/src/lib/themes/bundled-extensions.json");
const productDependencyFilters = productSections.flatMap((section) => section.roots);
const sectionOfRoot = new Map(
  productSections.flatMap((section) => section.roots.map((root) => [root, section.id])),
);
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
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

/** Names from a `contributors` or `authors` array, for a package without `author`. */
function formatPeople(people) {
  if (!Array.isArray(people)) return null;
  const names = [...new Set(people.map(formatAuthor).filter(Boolean))];
  return names.length ? names.join(", ") : null;
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

const workspacePackages = getWorkspacePackages(repoRoot);
assertWorkspaceCoverage(workspacePackages, productDependencyFilters, excludedWorkspacePackages);
const workspacePackagesByName = new Map(workspacePackages.map((workspacePackage) => [
  workspacePackage.pkg.name,
  workspacePackage,
]));
/** The section being walked; every package first read during it belongs to it. */
let currentSection = null;
/** Every disclosed release, one entry per `name@version`, merged into rows on output. */
const externalReleases = [];
const visitedExternalPackagePaths = new Set();
const visitedWorkspacePackageNames = new Set();
/**
 * Platform builds read from no `package.json` here, keyed by name and release,
 * each with the siblings it may be described from: a product root's optional
 * dependency this machine cannot install, and the rest of an external
 * package's installed platform family. See
 * docs/specs/security-supply-chain.md -> "Disclosure".
 */
const undescribedPackages = new Map();
/** Every product root's optional dependencies, whose families that root names. */
const productRootOptionals = new Set(productDependencyFilters.flatMap((name) =>
  Object.keys(workspacePackagesByName.get(name).pkg.optionalDependencies ?? {})));

/**
 * Describes `packageName` from `siblings` after the walk, from their release at
 * `version` when given; the first section to reach it keeps it.
 */
function describeLater(packageName, siblings, version) {
  const key = `${packageName}@${version ?? ""}`;
  if (!undescribedPackages.has(key)) {
    undescribedPackages.set(key, { packageName, section: currentSection.id, siblings, version });
  }
}
/** Each package's `contributors` (or `authors`), the last resort for its author. */
const listedPeople = new Map();

function addExternalPackage(pkg) {
  const people = formatPeople(pkg.contributors) ?? formatPeople(pkg.authors);
  if (people) listedPeople.set(pkg.name, people);
  externalReleases.push({
    section: currentSection.id,
    name: pkg.name,
    version: pkg.version,
    license: normalizeLicense(pkg.license),
    author: formatAuthor(pkg.author),
    homepage: getHomepage(pkg),
  });
}

function scanWorkspacePackage(name) {
  if (visitedWorkspacePackageNames.has(name)) return;
  // Another section's root: that section walks it.
  if (sectionOfRoot.has(name) && sectionOfRoot.get(name) !== currentSection.id) return;
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

  const packageJsonPath = declaredBy.peer
    ? linkedPeerPackageJsonPath(fromDir, declaredBy.pkg.name, packageName, declaredBy.isWorkspace)
    : getPackageJsonPath(fromDir, packageName);
  if (!packageJsonPath) {
    const edge = missingDependency(declaredBy);
    if (edge === 'skip') return;
    if (edge === 'describe') {
      describeLater(packageName, optionalSiblingsAtSameVersion(declaredBy.pkg, packageName));
      return;
    }
    throw new Error(`Could not resolve package.json for "${packageName}" from ${fromDir}`);
  }

  const realPackageJsonPath = realpathSync(packageJsonPath);
  if (visitedExternalPackagePaths.has(realPackageJsonPath)) return;
  visitedExternalPackagePaths.add(realPackageJsonPath);

  const pkg = readJson(realPackageJsonPath);
  for (const sibling of externalPlatformSiblings(declaredBy, pkg, productRootOptionals)) {
    describeLater(sibling, [pkg.name], pkg.version);
  }
  addExternalPackage(pkg);
  scanDependencies(pkg, dirname(realPackageJsonPath));
}

function scanDependencies(pkg, fromDir) {
  const isProductRoot = sectionOfRoot.has(pkg.name);
  const isWorkspace = workspacePackagesByName.has(pkg.name);
  for (const { name, optional, peer } of getDependencyNames(pkg, currentSection)) {
    scanDependency(fromDir, name, { pkg, optional, peer, isWorkspace, isProductRoot });
  }
}

for (const section of productSections) {
  currentSection = section;
  for (const packageName of section.roots) scanWorkspacePackage(packageName);
}

// Grouped before the loop writes to `externalReleases`, so nothing is ever
// described from something that was itself described rather than read.
const readReleasesByName = Map.groupBy(externalReleases, (release) => release.name);
for (const { packageName, section, siblings, version } of undescribedPackages.values()) {
  const sibling = siblings
    .map((name) => readReleasesByName.get(name)?.filter((release) => !version || release.version === version))
    .find((releases) => releases?.length);
  if (!sibling) {
    throw new Error(
      `"${packageName}" is not installed and neither is any sibling declared beside it at the same version, so it cannot be described`,
    );
  }
  externalReleases.push(...sibling.map((release) => ({ ...release, section, name: packageName })));
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

/**
 * Each `name@version` once, in the first section that reached it. pnpm installs
 * one release at several paths when peer contexts differ, so the path walk
 * alone would repeat it under a later section. Described releases follow every
 * read one, so a family member that is both installed and described keeps the
 * row it was read into.
 */
function firstSectionReleases(releases) {
  const seen = new Set();
  return releases.filter(({ name, version }) => {
    const release = `${name}@${version}`;
    if (seen.has(release)) return false;
    seen.add(release);
    return true;
  });
}

const deps = firstSectionReleases(externalReleases);

// Merge in bundled theme extensions from OpenVSX, compiled into lib and so
// part of the terminal.
const themeExtensions = JSON.parse(readFileSync(themeExtensionsPath, "utf-8"));

// OpenVSX exposes VS Code's bundled default themes as several built-in
// theme extension records. Show them as one dependency on the website.
const isVscodeBuiltInTheme = (dep) =>
  dep.author === "open-vsx" &&
  dep.homepage === "https://github.com/eclipse-theia/vscode-builtin-extensions#readme" &&
  (dep.name === "Default Themes (built-in)" || dep.name.endsWith(" Theme (built-in)"));

const vscodeBuiltInThemes = themeExtensions.filter(isVscodeBuiltInTheme);
// One release per version, which `mergeReleases` folds into one row.
for (const version of new Set(vscodeBuiltInThemes.map((dep) => dep.version).filter(Boolean))) {
  deps.push({
    section: "terminal",
    name: "VS Code built-in themes",
    version,
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
      section: "terminal",
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
  // Declared in the legacy `licenses` array.
  "buildcheck": "MIT",
  "cpu-features": "MIT",
  "format": "MIT",
  "ssh2": "MIT",
  // Stated only in its LICENSE file.
  "khroma": "MIT",
};
const missingAuthor = {
  "@hono/node-ws": "Hono middleware contributors",
  "@mdxeditor/gurx": "Petyo Ivanov",
  "@preact/signals-core": "Preact Team",
  // node-datachannel's prebuilt platform packages carry no author or contributors.
  "@node-datachannel/darwin-arm64": "Murat Doğan, Paul-Louis Ageneau",
  "@node-datachannel/darwin-x64": "Murat Doğan, Paul-Louis Ageneau",
  "@node-datachannel/linux-arm64-gnu": "Murat Doğan, Paul-Louis Ageneau",
  "@node-datachannel/linux-x64-gnu": "Murat Doğan, Paul-Louis Ageneau",
  "@node-datachannel/win32-arm64-msvc": "Murat Doğan, Paul-Louis Ageneau",
  "@node-datachannel/win32-x64-msvc": "Murat Doğan, Paul-Louis Ageneau",
  "@tauri-apps/api": "Tauri Apps Contributors",
  "@tauri-apps/plugin-shell": "Tauri Apps Contributors",
  "@tauri-apps/plugin-updater": "Tauri Apps Contributors",
  "@xterm/xterm": "Christopher Jeffrey, SourceLair Private Company, xterm.js authors",
  // nodeca's port of Python's argparse, under the PSF license.
  "argparse": "nodeca, Python Software Foundation",
  "atomically": "Fabio Spampinato",
  "inherits": "Isaac Z. Schlueter",
  "lexical": "Meta Platforms, Inc. and affiliates",
  "minimalistic-assert": "Calvin Metcalf",
  "ms": "Vercel, Inc.",
  "node-addon-api": "Node.js API collaborators",
  "pngjs": "pngjs contributors",
  "prop-types": "Meta Platforms, Inc. and affiliates",
  "react": "Meta Platforms, Inc. and affiliates",
  "react-dom": "Meta Platforms, Inc. and affiliates",
  "react-is": "Meta Platforms, Inc. and affiliates",
  "scheduler": "Meta Platforms, Inc. and affiliates",
  "stubborn-fs": "Fabio Spampinato",
  "stubborn-utils": "Fabio Spampinato",
  "tailwindcss": "Tailwind Labs, Inc.",
  "when-exit": "Fabio Spampinato",
  // Holders named only in each package's LICENSE file.
  "@braintree/sanitize-url": "Braintree",
  "acorn": "Acorn contributors",
  "acorn-jsx": "Ingvar Stepanyan",
  "cose-base": "iVis@Bilkent",
  "cytoscape": "The Cytoscape Consortium",
  "cytoscape-cose-bilkent": "The Cytoscape Consortium",
  "diff": "Kevin Decker",
  "es-toolkit": "Viva Republica, Inc.",
  "katex": "Khan Academy and other contributors",
  "khroma": "Fabio Spampinato, Andrew Maney",
  "layout-base": "iVis@Bilkent",
  "uuid": "Robert Kieffer and other contributors",
  "uvu": "Luke Edwards",
  "@balena/dockerignore": "Balena Ltd., Zeit Inc.",
  "@better-fetch/fetch": "Bereket Engida",
  "balanced-match": "Julian Gruber",
  "bcrypt-pbkdf": "Niels Provos, Joyent",
  "better-auth": "Bereket Engida",
  "better-call": "Bereket Engida",
  "brace-expansion": "Julian Gruber",
  "defu": "Pooya Parsa",
  "graceful-fs": "Isaac Z. Schlueter, Ben Noordhuis, and contributors",
  "jiti": "Pooya Parsa",
  "mkdirp": "James Halliday, Isaac Z. Schlueter",
  "pg-cloudflare": "Brian Carlson",
  "pg-int8": "Charmander",
  "pg-protocol": "Brian Carlson",
  "pgstencil": "DiffPlug",
  "process-nextick-args": "Calvin Metcalf",
  "readable-stream": "Node.js contributors",
  "rou3": "Pooya Parsa",
  "string_decoder": "Node.js contributors",
  // No holder in the package's files: its project or maintainer.
  "@pkgjs/parseargs": "pkgjs contributors",
};
// Every package under these scopes names its holder only in its LICENSE.
const missingAuthorScopes = {
  "@better-auth/": "Bereket Engida",
  "@chevrotain/": "Shahar Soel",
  "@lexical/": "Meta Platforms, Inc. and affiliates",
  "@pgstencil/": "DiffPlug",
  "@radix-ui/": "WorkOS",
};
// Packages whose metadata names neither `homepage` nor `repository`, by scope.
const missingHomepageScopes = {
  "@radix-ui/": "https://www.radix-ui.com/",
};
/** The value of the first `prefix` key that `name` starts with. */
function byPrefix(table, name) {
  return Object.entries(table).find(([prefix]) => name.startsWith(prefix))?.[1];
}

/** Fills a missing `field` from `override`, or fails generation naming `table`. */
function requireField(dep, field, override, table) {
  if (dep[field]) return;
  if (!override) {
    console.error(`ERROR: "${dep.name}" has no ${field}. Add it to ${table} in generate-deps.js`);
    process.exit(1);
  }
  dep[field] = override;
}

for (const dep of deps) {
  requireField(dep, "license", missingLicense[dep.name], "missingLicense");
  requireField(
    dep,
    "author",
    missingAuthor[dep.name] ?? byPrefix(missingAuthorScopes, dep.name) ?? listedPeople.get(dep.name),
    "missingAuthor",
  );
  requireField(dep, "homepage", byPrefix(missingHomepageScopes, dep.name), "missingHomepageScopes");
}

// Merged after the overrides, so a release whose metadata needed one still
// joins its siblings' row.
const npmRowsBySection = Map.groupBy(
  mergeReleases(deps, ["section"]).sort(compareDependencyEntries),
  (row) => row.section,
);
const npmDepsBySection = Object.fromEntries(productSections.map(({ id }) => [
  id,
  (npmRowsBySection.get(id) ?? []).map(({ section: _section, ...row }) => row),
]));

// Manual overrides for Cargo crates whose published Cargo.toml omits author or
// homepage metadata. Keyed by crate name. Cargo deprecated `authors`, so newer
// crates ship none; a missing entry fails generation, as for npm above.
// libappindicator{,-sys} ship empty `authors`/`homepage`/`repository`, so cargo
// metadata yields null for both.
const cargoMissingAuthor = {
  "libappindicator": "Tauri Apps Contributors",
  "libappindicator-sys": "Tauri Apps Contributors",
  // Holders named in each crate's LICENSE, COPYRIGHT, or AUTHORS file.
  "chrono": "Kang Seonghoon and contributors",
  "crossbeam-channel": "The Crossbeam Project Developers",
  "crossbeam-utils": "The Crossbeam Project Developers",
  "find-msvc-tools": "Alex Crichton",
  "futures-channel": "Alex Crichton, The Tokio Authors",
  "futures-core": "Alex Crichton, The Tokio Authors",
  "futures-executor": "Alex Crichton, The Tokio Authors",
  "futures-io": "Alex Crichton, The Tokio Authors",
  "futures-macro": "Alex Crichton, The Tokio Authors",
  "futures-sink": "Alex Crichton, The Tokio Authors",
  "futures-task": "Alex Crichton, The Tokio Authors",
  "futures-util": "Alex Crichton, The Tokio Authors",
  "hyper-rustls": "Joseph Birr-Pixton",
  "javascriptcore-rs": "The Gtk-rs Project Developers, Tauri Programme within The Commons Conservancy",
  "libc": "The Rust Project Developers",
  "muda": "Tauri Programme within The Commons Conservancy",
  "nix": "Carl Lerche and nix-rust Authors",
  "quick-xml": "Johann Tuffe",
  "r-efi": "Red Hat, Inc., Microsoft Corporation, David Rheinsberg",
  "ring": "Brian Smith",
  "rustc_version": "The Rust Project Developers",
  "rustls": "Joseph Birr-Pixton",
  "rustls-native-certs": "Joseph Birr-Pixton",
  "rustls-pki-types": "Dirkjan Ochtman",
  "rustls-platform-verifier": "1Password",
  "rustls-platform-verifier-android": "1Password",
  "rustls-webpki": "Brian Smith",
  "serde_spanned": "toml-rs contributors",
  "softbuffer": "Kirill Chibisov",
  "soup3": "The Gtk-rs Project Developers",
  "tokio-rustls": "quininer kel",
  "toml_parser": "toml-rs contributors",
  "toml_writer": "toml-rs contributors",
  "tray-icon": "Tauri Programme within The Commons Conservancy",
  "web-time": "dAxpeDDa",
  "webkit2gtk": "Antoni Boucher, The Gtk-rs Project Developers",
  "webkit2gtk-sys": "Antoni Boucher",
  "windows": "Microsoft",
  "windows-collections": "Microsoft",
  "windows-core": "Microsoft",
  "windows-future": "Microsoft",
  "windows-implement": "Microsoft",
  "windows-interface": "Microsoft",
  "windows-link": "Microsoft",
  "windows-numerics": "Microsoft",
  "windows-registry": "Microsoft",
  "windows-result": "Microsoft",
  "windows-strings": "Microsoft",
  "windows-threading": "Microsoft",
  "windows-version": "Microsoft",
  // No holder in the crate's files: its project or maintainer. bs58's LICENSE
  // names "The roaring-rs developers", a copy-paste from another project.
  "bs58": "bs58-rs contributors",
  "cargo-platform": "The Rust Project Developers",
  "dpi": "The winit contributors",
  "equivalent": "The indexmap contributors",
  "indexmap": "The indexmap contributors",
  "jni-macros": "jni team",
  "pin-project-lite": "Taiki Endo",
  // 1.0.152 dropped `authors`; these are the ones 1.0.151 declared.
  "serde_json": "Erick Tryzelaar, David Tolnay",
  "wasip2": "The Bytecode Alliance",
  "webpki-root-certs": "The rustls contributors",
  "webview2-com": "Bill Avery",
  "webview2-com-macros": "Bill Avery",
  "webview2-com-sys": "Bill Avery",
  "winnow": "Ed Page and nom contributors",
};
// objc2's framework crates (objc2-app-kit, objc2-foundation, ...) name no
// author; the core `objc2` crate names Mads Marquart.
const cargoMissingAuthorPrefixes = {
  "objc2-": "Mads Marquart",
};
const cargoMissingHomepage = {
  "libappindicator": "https://github.com/tauri-apps/libappindicator-rs",
  "libappindicator-sys": "https://github.com/tauri-apps/libappindicator-rs",
};

function getCargoHomepage(pkg) {
  return getCargoGitRepository(pkg.source) || pkg.homepage || pkg.repository || pkg.documentation || null;
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
    author: formatCargoAuthor(pkg.authors)
      ?? cargoMissingAuthor[pkg.name]
      ?? byPrefix(cargoMissingAuthorPrefixes, pkg.name)
      ?? null,
    homepage: getCargoHomepage(pkg) ?? cargoMissingHomepage[pkg.name] ?? null,
  };
}

function compareDependencyEntries(a, b) {
  return a.name.localeCompare(b.name) || compareVersions(a.versions[0], b.versions[0]);
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
  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const rootPackage = packagesById.get(metadata.resolve.root);
  if (!rootPackage) {
    throw new Error("Could not find root package in Cargo metadata");
  }
  const { directDeps, shippedIds } = getShippedCargoGraph(metadata);
  const directIds = new Set(directDeps.map((dep) => dep.pkg));

  const direct = mergeReleases(directDeps.map((dep) => {
    const pkg = packagesById.get(dep.pkg);
    if (!pkg) throw new Error(`Could not find Cargo package ${dep.pkg}`);

    const manifestDep = getManifestDependencyByName(rootPackage.dependencies, dep.name);
    return {
      ...cargoPackageEntry(pkg),
      declaredName: manifestDep?.rename || manifestDep?.name || dep.name.replaceAll("_", "-"),
    };
  }), ["declaredName"]).sort(compareDependencyEntries);

  const transitive = mergeReleases(
    metadata.packages
      .filter((pkg) => shippedIds.has(pkg.id) && !directIds.has(pkg.id))
      .map(cargoPackageEntry),
  ).sort(compareDependencyEntries);

  return { direct, transitive };
}

const cargoDeps = getCargoDependencies();
for (const dep of [...cargoDeps.direct, ...cargoDeps.transitive]) {
  requireField(dep, "author", null, "cargoMissingAuthor");
}

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
      versions: [nodeVersion],
      license: "MIT and bundled component licenses",
      author: "OpenJS Foundation and Node.js contributors",
      homepage: "https://github.com/nodejs/node",
    },
  ];
}

const runtimeDeps = getBundledRuntimeDependencies();

writeFileSync(npmOutPath, JSON.stringify(npmDepsBySection, null, 2) + "\n");
writeFileSync(cargoOutPath, JSON.stringify(cargoDeps, null, 2) + "\n");
writeFileSync(runtimeOutPath, JSON.stringify(runtimeDeps, null, 2) + "\n");
console.log(
  `Wrote ${productSections.map(({ id }) => `${npmDepsBySection[id].length} ${id}`).join(", ")} npm dependencies to src/data/dependencies-npm.json`,
);
console.log(
  `Wrote ${cargoDeps.direct.length} direct and ${cargoDeps.transitive.length} transitive Cargo dependencies to src/data/dependencies-cargo.json`,
);
console.log(`Wrote ${runtimeDeps.length} bundled runtime to src/data/dependencies-runtime.json`);
