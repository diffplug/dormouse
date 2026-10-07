import assert from 'node:assert/strict';
import { test } from 'node:test';
import YAML from 'yaml';
import { readRepoFile } from './lint-kit.mjs';

// The mechanical bullets of docs/specs/security-supply-chain.md ->
// "Bundled runtime" and "Cooldown and alerts", read off the files that carry
// them. Each case below plants one violation in an in-memory copy and requires
// `check` to report it, so a rule here that stops judging goes red.

const real = () => ({
  workspace: readRepoFile('pnpm-workspace.yaml'),
  renovate: readRepoFile('.github/renovate.json'),
  pkg: readRepoFile('package.json'),
  release: readRepoFile('.github/workflows/release.yml'),
  skills: readRepoFile('install_skills.sh'),
  ci: readRepoFile('.github/workflows/ci.yml'),
  zizmor: readRepoFile('.github/zizmor-requirements.txt'),
});

const PGSTENCIL = ['pgstencil', '@pgstencil/*'];
const PGSTENCIL_RULE = ['pgstencil', '@pgstencil/**'];
const MANAGERS = ['npm', 'cargo'];
const UPDATE_TYPES = ['patch', 'minor', 'major'];

function check(files) {
  const failures = [];
  const fail = (message) => failures.push(message);

  const workspace = YAML.parse(files.workspace);
  if (workspace.minimumReleaseAge !== 1440) fail(`pnpm-workspace.yaml minimumReleaseAge is ${workspace.minimumReleaseAge}`);
  const excluded = (workspace.minimumReleaseAgeExclude ?? []).filter((name) => !PGSTENCIL.includes(name));
  if (excluded.length) fail(`pnpm-workspace.yaml minimumReleaseAgeExclude also exempts ${excluded.join(', ')}`);

  const renovate = JSON.parse(files.renovate);
  const rules = renovate.packageRules ?? [];
  for (const rule of rules.filter((r) => 'minimumReleaseAge' in r && r.minimumReleaseAge === null)) {
    const names = rule.matchPackageNames;
    const scoped = Array.isArray(names) && names.length > 0 && names.every((n) => PGSTENCIL_RULE.includes(n));
    if (!scoped) fail(`a Renovate rule drops the cooldown for ${JSON.stringify(names ?? 'every package')}`);
  }
  for (const manager of MANAGERS) {
    if (!(renovate.enabledManagers ?? []).includes(manager)) fail(`Renovate does not enable ${manager}`);
    for (const scope of [renovate, renovate[manager] ?? {}]) {
      for (const key of ['includePaths', 'ignorePaths']) if (scope[key] !== undefined) fail(`Renovate limits ${manager} with ${key}`);
    }
    for (const type of UPDATE_TYPES) {
      // A covering rule narrows by manager and update type alone.
      const covers = rules.some((r) => typeof r.minimumReleaseAge === 'string'
        && (!r.matchManagers || r.matchManagers.includes(manager))
        && (!r.matchUpdateTypes || r.matchUpdateTypes.includes(type))
        && Object.keys(r).every((k) => !k.startsWith('match') || k === 'matchManagers' || k === 'matchUpdateTypes'));
      if (!covers) fail(`no Renovate minimumReleaseAge rule covers ${manager} ${type} updates`);
    }
  }
  const alerts = renovate.vulnerabilityAlerts;
  if (!alerts || typeof alerts.minimumReleaseAge !== 'string') fail('Renovate vulnerabilityAlerts does not set minimumReleaseAge explicitly');

  const pkg = JSON.parse(files.pkg);
  if (!/^\d+\.\d+\.\d+$/.test(pkg.devEngines?.runtime?.version ?? '') || pkg.devEngines?.runtime?.name !== 'node') {
    fail(`package.json devEngines.runtime is ${JSON.stringify(pkg.devEngines?.runtime)}, not an exact node version`);
  }
  if (pkg.volta?.node !== undefined) fail('package.json declares volta.node');
  if (pkg.engines?.node !== undefined) fail('package.json declares engines.node');

  const release = YAML.parse(files.release);
  const setup = (release.jobs?.['build-standalone']?.steps ?? []).filter((s) => s.uses?.startsWith('actions/setup-node@'));
  if (setup.length === 0 || setup.some((s) => s.with?.['node-version-file'] !== 'package.json' || s.with?.['node-version'] !== undefined)) {
    fail('release.yml build-standalone does not install Node from node-version-file: package.json');
  }

  for (const line of files.skills.split('\n').filter((l) => /(^|\s)npx\s/.test(l) && !/^\s*#/.test(l))) {
    const pkgArg = line.trim().split(/\s+/).slice(1).find((arg) => !arg.startsWith('-'));
    if (!/^(@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+$/.test(pkgArg ?? '')) fail(`install_skills.sh runs \`${line.trim()}\` without an exact version`);
  }

  // The CI linters outside the lockfile: an exact version, verified by hash.
  const zizmor = files.zizmor.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join(' ').replace(/\\\s+/g, ' ');
  if (!/^zizmor==\d+\.\d+\.\d+(\s+--hash=sha256:[0-9a-f]{64})+\s*$/.test(zizmor.trim())) fail('.github/zizmor-requirements.txt does not pin zizmor exactly with hashes');
  const lint = YAML.parse(files.ci).jobs?.['workflow-lint'];
  const lintRun = (lint?.steps ?? []).map((s) => s.run ?? '').join('\n');
  if (!/pip"? install --require-hashes --only-binary :all: --no-deps -r \.github\/zizmor-requirements\.txt/.test(lintRun)) fail('ci.yml does not install zizmor from its hash-pinned requirements');
  const pin = (lint?.steps ?? []).find((s) => s.env?.ACTIONLINT_VERSION)?.env ?? {};
  const version = /^\d+\.\d+\.\d+$/.test(pin.ACTIONLINT_VERSION ?? '') ? pin.ACTIONLINT_VERSION : null;
  const sha = pin.ACTIONLINT_SHA256;
  if (!version || !/^[0-9a-f]{64}$/.test(sha ?? '') || !/sha256sum -c/.test(lintRun)) fail('ci.yml does not install actionlint at an exact version verified by sha256');
  return failures;
}

test('the supply-chain configuration holds', () => {
  assert.deepEqual(check(real()), []);
});

const json = (key, edit) => (files) => { const value = JSON.parse(files[key]); edit(value); files[key] = JSON.stringify(value); };
const text = (key, from, to) => (files) => {
  assert.ok(files[key].includes(from), `${key} no longer contains ${JSON.stringify(from)}; re-point this case`);
  files[key] = files[key].replace(from, to);
};

for (const [name, mutate, expected] of [
  ['the pnpm cooldown shortened', text('workspace', 'minimumReleaseAge: 1440', 'minimumReleaseAge: 60'), 'minimumReleaseAge is 60'],
  ['the pnpm cooldown removed', text('workspace', 'minimumReleaseAge: 1440\n', ''), 'minimumReleaseAge is undefined'],
  ['another package exempted from the pnpm cooldown', text('workspace', '  - pgstencil\n', '  - pgstencil\n  - lodash\n'), 'also exempts lodash'],
  ['a Renovate rule drops the cooldown for everything', json('renovate', (r) => r.packageRules.push({ matchManagers: ['npm'], minimumReleaseAge: null })), 'drops the cooldown for "every package"'],
  ['a Renovate rule drops the cooldown for another package', json('renovate', (r) => r.packageRules.push({ matchPackageNames: ['pgstencil', 'left-pad'], minimumReleaseAge: null })), 'drops the cooldown for'],
  ['cargo disabled in Renovate', json('renovate', (r) => { r.enabledManagers = r.enabledManagers.filter((m) => m !== 'cargo'); }), 'does not enable cargo'],
  ['Renovate ignoring paths', json('renovate', (r) => { r.ignorePaths = ['standalone/**']; }), 'with ignorePaths'],
  ['Renovate npm limited to paths', json('renovate', (r) => { r.npm = { includePaths: ['lib/**'] }; }), 'limits npm with includePaths'],
  ['no cooldown on npm majors', json('renovate', (r) => { r.packageRules = r.packageRules.filter((x) => !(x.matchUpdateTypes?.includes('major') && x.minimumReleaseAge)); }), 'covers npm major'],
  ['the patch cooldown narrowed to one package', json('renovate', (r) => { r.packageRules.find((x) => x.matchUpdateTypes?.includes('patch') && x.minimumReleaseAge).matchPackageNames = ['react']; }), 'covers npm patch'],
  ['vulnerabilityAlerts inherits the cooldown', json('renovate', (r) => { delete r.vulnerabilityAlerts.minimumReleaseAge; }), 'vulnerabilityAlerts does not set minimumReleaseAge'],
  ['vulnerabilityAlerts removed', json('renovate', (r) => { delete r.vulnerabilityAlerts; }), 'vulnerabilityAlerts does not set minimumReleaseAge'],
  ['the runtime pin loosened to a major', json('pkg', (p) => { p.devEngines.runtime.version = '24'; }), 'not an exact node version'],
  ['a volta pin added', json('pkg', (p) => { p.volta = { node: '24.0.0' }; }), 'declares volta.node'],
  ['an engines pin added', json('pkg', (p) => { p.engines = { node: '>=24' }; }), 'declares engines.node'],
  ['the release build pins Node inline', text('release', '        with:\n          node-version-file: package.json', '        with:\n          node-version: 24'), 'node-version-file: package.json'],
  ['install_skills.sh runs npx unpinned', text('skills', 'skills@1.7.0', 'skills@latest'), 'without an exact version'],
  ['install_skills.sh runs npx with no version', text('skills', 'skills@1.7.0', 'skills'), 'without an exact version'],
  ['zizmor unhashed', (files) => { files.zizmor = 'zizmor==1.30.1\n'; }, 'does not pin zizmor exactly'],
  ['zizmor by range', (files) => { files.zizmor = files.zizmor.replace(/zizmor==[\d.]+/, 'zizmor>=1.30'); }, 'does not pin zizmor exactly'],
  ['zizmor installed without hashes', text('ci', '--require-hashes ', ''), 'does not install zizmor'],
  ['actionlint unverified', text('ci', 'sha256sum -c', 'true'), 'actionlint at an exact version'],
]) {
  test(`reports: ${name}`, () => {
    const files = real();
    mutate(files);
    const failures = check(files);
    assert.ok(failures.some((f) => f.includes(expected)), `expected "${expected}"; got:\n${failures.join('\n')}`);
  });
}
