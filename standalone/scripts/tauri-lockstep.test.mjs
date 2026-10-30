import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import YAML from 'yaml';

// Tauri's CLI refuses `tauri build` and `tauri dev` ("Found version mismatched
// Tauri packages") unless each JS binding shares a major.minor with its crate.
// CI runs neither, so without this test a split bump merges green and fails
// the next release build. Renovate's `tauri` group is what keeps the two
// halves in one PR; this pins both the group and the installed pairs.

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const PACKAGE_JSON = 'standalone/package.json';
const CARGO_TOML = 'standalone/src-tauri/Cargo.toml';

const real = () => ({
  pkg: read(PACKAGE_JSON),
  lock: read('pnpm-lock.yaml'),
  cargoLock: read('standalone/src-tauri/Cargo.lock'),
  renovate: read('.github/renovate.json'),
});

// The crate each binding is checked against, as the CLI pairs them.
const crateFor = (name) => (name === '@tauri-apps/api' ? 'tauri' : name.replace(/^@tauri-apps\/plugin-/, 'tauri-plugin-'));
const isBinding = (name) => name === '@tauri-apps/api' || name.startsWith('@tauri-apps/plugin-');
const majorMinor = (version) => version.split('.').slice(0, 2).join('.');

// Renovate's matchPackageNames / matchFileNames: exact names and minimatch-style
// globs, the only forms this config uses. Anything else throws rather than misjudge.
function matches(patterns, value) {
  return patterns.some((pattern) => {
    if (pattern.startsWith('!') || pattern.startsWith('/')) throw new Error(`unsupported Renovate pattern ${pattern}`);
    const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*');
    return new RegExp(`^${source}$`).test(value);
  });
}

// What the later-wins packageRules make of one dependency: its group, and whether it is updated at all.
function renovateFor(rules, manager, file, name) {
  let groupName = null;
  let enabled = true;
  for (const rule of rules) {
    if (rule.matchManagers && !rule.matchManagers.includes(manager)) continue;
    if (rule.matchFileNames && !matches(rule.matchFileNames, file)) continue;
    if (rule.matchPackageNames && !matches(rule.matchPackageNames, name)) continue;
    if (rule.matchUpdateTypes || rule.matchDepTypes) continue; // narrows to some updates only
    if ('groupName' in rule) groupName = rule.groupName;
    if ('enabled' in rule) enabled = rule.enabled;
  }
  return { groupName, enabled };
}

function check(files) {
  const failures = [];
  const pkg = JSON.parse(files.pkg);
  // pnpm writes its own environment as a leading lock document; the workspace's follows it.
  const importer = YAML.parseAllDocuments(files.lock).map((doc) => doc.toJS()?.importers?.standalone).find(Boolean);
  if (!importer) return ['pnpm-lock.yaml has no standalone importer'];
  const installed = { ...importer.devDependencies, ...importer.dependencies };
  const crates = new Map([...files.cargoLock.matchAll(/^\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/gm)].map((m) => [m[1], m[2]]));
  const rules = JSON.parse(files.renovate).packageRules ?? [];

  const bindings = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(isBinding);
  if (!bindings.includes('@tauri-apps/api')) failures.push(`${PACKAGE_JSON} declares no @tauri-apps/api`);
  for (const name of bindings) {
    const crate = crateFor(name);
    const npmVersion = installed[name]?.version;
    const crateVersion = crates.get(crate);
    if (!npmVersion) failures.push(`${name} is not installed for standalone in pnpm-lock.yaml`);
    else if (!crateVersion) failures.push(`${crate}, the crate ${name} binds, is not in Cargo.lock`);
    else if (majorMinor(npmVersion) !== majorMinor(crateVersion)) {
      failures.push(`${name}@${npmVersion} and ${crate}@${crateVersion} differ in major.minor`);
    }
    const js = renovateFor(rules, 'npm', PACKAGE_JSON, name);
    const rust = renovateFor(rules, 'cargo', CARGO_TOML, crate);
    if (!js.enabled || !rust.enabled) failures.push(`Renovate does not update both ${name} and ${crate}`);
    else if (!js.groupName || js.groupName !== rust.groupName) {
      failures.push(`Renovate groups ${name} as ${js.groupName} and ${crate} as ${rust.groupName}`);
    }
  }
  return failures;
}

test('each Tauri JS binding is installed on its crate major.minor, and Renovate bumps both in one PR', () => {
  assert.deepEqual(check(real()), []);
});

const edit = (key, mutate) => (files) => ({ ...files, [key]: mutate(files[key]) });
const renovate = (mutate) => edit('renovate', (text) => { const r = JSON.parse(text); mutate(r); return JSON.stringify(r); });
const planted = [
  ['a binding a minor ahead of its crate', edit('cargoLock', (t) => t.replace(/(name = "tauri-plugin-shell"\nversion = ")(\d+)\.(\d+)/, (_, p, ma, mi) => `${p}${ma}.${Number(mi) + 1}`)), 'differ in major.minor'],
  ['the tauri group removed', renovate((r) => { r.packageRules = r.packageRules.filter((x) => x.groupName !== 'tauri'); }), 'groups @tauri-apps/api as null and tauri as cargo'],
  ['the tauri group overridden by a later cargo group', renovate((r) => { r.packageRules.push({ matchManagers: ['cargo'], groupName: 'cargo' }); }), 'and tauri as cargo'],
  ['a plugin crate disabled', renovate((r) => { r.packageRules.push({ matchManagers: ['cargo'], matchPackageNames: ['tauri-plugin-updater'], enabled: false }); }), 'does not update both @tauri-apps/plugin-updater'],
];
for (const [name, plant, expected] of planted) {
  test(`rejects ${name}`, () => {
    const failures = check(plant(real()));
    assert.ok(failures.some((f) => f.includes(expected)), `expected a failure containing "${expected}", got ${JSON.stringify(failures)}`);
  });
}
