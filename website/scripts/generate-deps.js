import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const outPath = resolve(__dirname, "../src/data/dependencies.json");
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

const licenseAliases = {
  "Apache-2.0 OR MIT": "MIT OR Apache-2.0",
};

const deps = [...externalPackages.values()].map((pkg) => ({
  name: pkg.name,
  version: [...pkg.versions].sort().join(", "),
  license: pkg.license ? (licenseAliases[pkg.license] ?? pkg.license) : null,
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

writeFileSync(outPath, JSON.stringify(deps, null, 2) + "\n");
console.log(`Wrote ${deps.length} dependencies to src/data/dependencies.json`);
