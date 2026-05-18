import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

function getInstalledStoreDir() {
  if (process.env.PNPM_STORE_DIR) return process.env.PNPM_STORE_DIR;
  try {
    const modulesYaml = readFileSync(resolve(repoRoot, "node_modules/.modules.yaml"), "utf-8");
    return modulesYaml.match(/"storeDir":\s*"([^"]+)"/)?.[1] ?? null;
  } catch {
    // Codex worktrees often do not have node_modules, but the shared pnpm
    // store is still present under PNPM_HOME.
    const pnpmHomeStore = process.env.PNPM_HOME ? resolve(process.env.PNPM_HOME, "store/v10") : null;
    return pnpmHomeStore && existsSync(pnpmHomeStore) ? pnpmHomeStore : null;
  }
}

const storeDir = getInstalledStoreDir();
const licenseArgs = [
  ...(storeDir ? [`--config.store-dir=${storeDir}`] : []),
  ...productDependencyFilters.flatMap((filter) => ["--filter", filter]),
  "licenses",
  "list",
  "--prod",
  "--json",
];
const raw = JSON.parse(
  execFileSync("pnpm", licenseArgs, { cwd: repoRoot, encoding: "utf-8" })
);

const licenseAliases = {
  "Apache-2.0 OR MIT": "MIT OR Apache-2.0",
};

const deps = [];
for (const [license, packages] of Object.entries(raw)) {
  for (const pkg of packages) {
    deps.push({
      name: pkg.name,
      version: pkg.versions.join(", "),
      license: licenseAliases[license] ?? license,
      author: pkg.author || null,
      homepage: pkg.homepage || null,
    });
  }
}

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
