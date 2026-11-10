import assert from 'node:assert/strict';
import { test } from 'node:test';
import YAML from 'yaml';
import { readRepoFile } from './lint-kit.mjs';

// The mechanical bullets of docs/specs/security-supply-chain.md ->
// "Bundled runtime" and "Cooldown and alerts", read off the files that carry
// them, and the Stripe SDK's update gate (hosted/README.md -> "Move the
// Stripe API version"). Each case below plants one violation in an in-memory copy and requires
// `check` to report it, so a rule here that stops judging goes red.

const real = () => ({
  workspace: readRepoFile('pnpm-workspace.yaml'),
  renovate: readRepoFile('.github/renovate.json'),
  pkg: readRepoFile('package.json'),
  release: readRepoFile('.github/workflows/release.yml'),
  ci: readRepoFile('.github/workflows/ci.yml'),
  zizmor: readRepoFile('.github/zizmor-requirements.txt'),
});

const PGSTENCIL = ['pgstencil', '@pgstencil/*'];
const PGSTENCIL_RULE = ['pgstencil', '@pgstencil/**'];
const MANAGERS = ['npm', 'cargo', 'github-actions'];
/** Hosted's packages whose update moves the Stripe API version the webhook accepts. */
const STRIPE_PINNED = ['stripe', '@pgstencil/stripe'];
const UPDATE_TYPES = ['patch', 'minor', 'major'];

/** Whether Renovate's `packageRules`, applied in order, leave an npm update of
 * `name` in hosted/package.json of type `update` needing dashboard approval.
 * Reads the matchers this config uses; one it does not model counts as a match. */
function needsApproval(renovate, name, update) {
  let approval = renovate.dependencyDashboardApproval === true;
  for (const rule of renovate.packageRules ?? []) {
    if (!('dependencyDashboardApproval' in rule)) continue;
    const names = rule.matchPackageNames;
    if (names && !names.some((n) => n === name || (n.endsWith('/**') && name.startsWith(n.slice(0, -2))))) continue;
    if (rule.matchManagers && !rule.matchManagers.includes('npm')) continue;
    if (rule.matchFileNames && !rule.matchFileNames.includes('hosted/package.json')) continue;
    if (rule.matchUpdateTypes && !rule.matchUpdateTypes.includes(update)) continue;
    approval = rule.dependencyDashboardApproval === true;
  }
  return approval;
}

// Keep repository policy durations in positive whole days. Reject unknown forms
// instead of approximating Renovate's duration parser or accepting any string.
const hasCooldown = (value) => typeof value === 'string' && /^[1-9]\d* days?$/.test(value);

function* configScopes(value, path = 'renovate') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const [i, child] of value.entries()) yield* configScopes(child, `${path}[${i}]`);
  } else {
    yield [path, value];
    for (const [key, child] of Object.entries(value)) yield* configScopes(child, `${path}.${key}`);
  }
}

function check(files) {
  const failures = [];
  const fail = (message) => failures.push(message);

  const workspace = YAML.parse(files.workspace);
  if (workspace.minimumReleaseAge !== 1440) fail(`pnpm-workspace.yaml minimumReleaseAge is ${workspace.minimumReleaseAge}`);
  const excluded = (workspace.minimumReleaseAgeExclude ?? []).filter((name) => !PGSTENCIL.includes(name));
  if (excluded.length) fail(`pnpm-workspace.yaml minimumReleaseAgeExclude also exempts ${excluded.join(', ')}`);

  const renovate = JSON.parse(files.renovate);
  // A global floor covers new managers and digest updates too. No later scope
  // may weaken it, regardless of package-rule ordering or matcher specificity.
  if (!hasCooldown(renovate.minimumReleaseAge)) fail('Renovate lacks a global cooldown of at least one whole day');
  for (const [key, expected] of Object.entries({ minimumReleaseAgeBehaviour: 'timestamp-required', internalChecksFilter: 'strict' })) {
    if (renovate[key] !== expected) fail(`Renovate must explicitly set ${key}: ${expected}`);
  }
  for (const [path, scope] of configScopes(renovate)) {
    if ('minimumReleaseAge' in scope && !hasCooldown(scope.minimumReleaseAge)) {
      const names = scope.matchPackageNames;
      const pgstencilException = /^renovate\.packageRules\[\d+\]$/.test(path)
        && scope.minimumReleaseAge === null
        && scope.matchManagers?.length === 1 && scope.matchManagers[0] === 'npm'
        && Array.isArray(names) && names.length > 0 && names.every((n) => PGSTENCIL_RULE.includes(n));
      if (!pgstencilException) fail(`${path} drops the cooldown: minimumReleaseAge must be positive whole days`);
    }
    if ('minimumReleaseAgeBehaviour' in scope && scope.minimumReleaseAgeBehaviour !== 'timestamp-required') fail(`${path} permits missing release timestamps`);
    if ('internalChecksFilter' in scope && scope.internalChecksFilter !== 'strict') fail(`${path} permits pending release checks`);
  }
  for (const key of ['includePaths', 'ignorePaths']) if (renovate[key] !== undefined) fail(`Renovate limits every manager with ${key}`);
  for (const manager of MANAGERS) {
    if (!(renovate.enabledManagers ?? []).includes(manager)) fail(`Renovate does not enable ${manager}`);
  }
  for (const manager of renovate.enabledManagers ?? []) {
    for (const key of ['includePaths', 'ignorePaths']) if (renovate[manager]?.[key] !== undefined) fail(`Renovate limits ${manager} with ${key}`);
  }
  for (const name of STRIPE_PINNED) {
    const ungated = UPDATE_TYPES.filter((update) => !needsApproval(renovate, name, update));
    if (ungated.length) fail(`Renovate updates ${name} in hosted without dashboard approval (${ungated.join(', ')})`);
  }
  const alerts = renovate.vulnerabilityAlerts;
  if (!alerts || !hasCooldown(alerts.minimumReleaseAge)) fail('Renovate vulnerabilityAlerts does not set a whole-day cooldown explicitly');
  if (alerts?.enabled !== true || !Array.isArray(alerts.schedule) || alerts.schedule.length !== 0) fail('Renovate vulnerabilityAlerts must be enabled without a schedule');

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
  if ((release.jobs?.['build-standalone']?.steps ?? []).some((s) => /--no-runtime\b/.test(s.run ?? ''))) {
    fail('release.yml build-standalone installs pnpm without its runtime (--no-runtime)');
  }

  // The CI linters outside the lockfile: an exact version, verified by hash.
  const zizmor = files.zizmor.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join(' ').replace(/\\\s+/g, ' ');
  if (!/^zizmor==\d+\.\d+\.\d+(\s+--hash=sha256:[0-9a-f]{64})+\s*$/.test(zizmor.trim())) fail('.github/zizmor-requirements.txt does not pin zizmor exactly with hashes');
  const lint = YAML.parse(files.ci).jobs?.['workflow-lint'];
  const lintRun = (lint?.steps ?? []).map((s) => s.run ?? '').join('\n');
  if (!/pip"? install --require-hashes --only-binary :all: --no-deps -r \.github\/zizmor-requirements\.txt/.test(lintRun)) fail('ci.yml does not install zizmor from its hash-pinned requirements');
  const pin = (lint?.steps ?? []).find((s) => s.env?.ACTIONLINT_VERSION)?.env ?? {};
  if (!/^\d+\.\d+\.\d+$/.test(pin.ACTIONLINT_VERSION ?? '') || !/^[0-9a-f]{64}$/.test(pin.ACTIONLINT_SHA256 ?? '') || !/sha256sum -c/.test(lintRun)) fail('ci.yml does not install actionlint at an exact version verified by sha256');
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
  ['a Renovate rule drops the cooldown for everything', json('renovate', (r) => r.packageRules.push({ matchManagers: ['npm'], minimumReleaseAge: null })), 'drops the cooldown'],
  ['a Renovate rule drops the cooldown for another package', json('renovate', (r) => r.packageRules.push({ matchManagers: ['npm'], matchPackageNames: ['pgstencil', 'left-pad'], minimumReleaseAge: null })), 'drops the cooldown'],
  ['cargo disabled in Renovate', json('renovate', (r) => { r.enabledManagers = r.enabledManagers.filter((m) => m !== 'cargo'); }), 'does not enable cargo'],
  ['Renovate ignoring paths', json('renovate', (r) => { r.ignorePaths = ['standalone/**']; }), 'limits every manager with ignorePaths'],
  ['Renovate npm limited to paths', json('renovate', (r) => { r.npm = { includePaths: ['lib/**'] }; }), 'limits npm with includePaths'],
  ['Actions disabled in Renovate', json('renovate', (r) => { r.enabledManagers = r.enabledManagers.filter((m) => m !== 'github-actions'); }), 'does not enable github-actions'],
  ['Actions limited to paths', json('renovate', (r) => { r['github-actions'] = { includePaths: ['.github/workflows/ci.yml'] }; }), 'limits github-actions with includePaths'],
  ['the global floor removed', json('renovate', (r) => { delete r.minimumReleaseAge; }), 'lacks a global cooldown'],
  ['only version bumps covered', json('renovate', (r) => { delete r.minimumReleaseAge; r.packageRules.push({ matchUpdateTypes: ['patch', 'minor', 'major'], minimumReleaseAge: '1 day' }); }), 'lacks a global cooldown'],
  ['the global floor zeroed', json('renovate', (r) => { r.minimumReleaseAge = '0 days'; }), 'lacks a global cooldown'],
  ['a late package rule shortens the cooldown', json('renovate', (r) => { r.packageRules.push({ matchPackageNames: ['react'], minimumReleaseAge: '1 hour' }); }), 'drops the cooldown'],
  ['a digest scope drops the cooldown', json('renovate', (r) => { r.digest = { minimumReleaseAge: null }; }), 'renovate.digest drops the cooldown'],
  ['a manager scope drops the cooldown', json('renovate', (r) => { r['github-actions'] = { minimumReleaseAge: '0 days' }; }), 'renovate.github-actions drops the cooldown'],
  ['a nested update scope drops the cooldown', json('renovate', (r) => { r.packageRules.push({ matchManagers: ['npm'], major: { minimumReleaseAge: '0 days' } }); }), 'major drops the cooldown'],
  ['the pgstencil exception widened to Actions', json('renovate', (r) => { r.packageRules.find((x) => x.minimumReleaseAge === null).matchManagers.push('github-actions'); }), 'drops the cooldown'],
  ['the timestamp policy removed', json('renovate', (r) => { delete r.minimumReleaseAgeBehaviour; }), 'must explicitly set minimumReleaseAgeBehaviour'],
  ['a rule allows missing timestamps', json('renovate', (r) => { r.packageRules.push({ matchManagers: ['github-actions'], minimumReleaseAgeBehaviour: 'timestamp-optional' }); }), 'permits missing release timestamps'],
  ['strict filtering removed', json('renovate', (r) => { delete r.internalChecksFilter; }), 'must explicitly set internalChecksFilter'],
  ['a rule allows pending checks', json('renovate', (r) => { r.packageRules.push({ matchPackageNames: ['react'], internalChecksFilter: 'flexible' }); }), 'permits pending release checks'],
  ['vulnerabilityAlerts inherits the cooldown', json('renovate', (r) => { delete r.vulnerabilityAlerts.minimumReleaseAge; }), 'does not set a whole-day cooldown explicitly'],
  ['vulnerabilityAlerts removed', json('renovate', (r) => { delete r.vulnerabilityAlerts; }), 'does not set a whole-day cooldown explicitly'],
  ['vulnerabilityAlerts shortens the cooldown', json('renovate', (r) => { r.vulnerabilityAlerts.minimumReleaseAge = '0 days'; }), 'does not set a whole-day cooldown explicitly'],
  ['vulnerabilityAlerts disabled', json('renovate', (r) => { r.vulnerabilityAlerts.enabled = false; }), 'must be enabled without a schedule'],
  ['vulnerabilityAlerts waits for Monday', json('renovate', (r) => { r.vulnerabilityAlerts.schedule = ['* * * * 1']; }), 'must be enabled without a schedule'],
  ['the runtime pin loosened to a major', json('pkg', (p) => { p.devEngines.runtime.version = '24'; }), 'not an exact node version'],
  ['a volta pin added', json('pkg', (p) => { p.volta = { node: '24.0.0' }; }), 'declares volta.node'],
  ['an engines pin added', json('pkg', (p) => { p.engines = { node: '>=24' }; }), 'declares engines.node'],
  ['the release build pins Node inline', text('release', '        with:\n          node-version-file: package.json', '        with:\n          node-version: 24'), 'node-version-file: package.json'],
  ['the release build skips the pnpm runtime', text('release', 'run: pnpm install --frozen-lockfile\n', 'run: pnpm install --frozen-lockfile --no-runtime\n'), '--no-runtime'],
  ['zizmor unhashed', (files) => { files.zizmor = 'zizmor==1.30.1\n'; }, 'does not pin zizmor exactly'],
  ['zizmor by range', (files) => { files.zizmor = files.zizmor.replace(/zizmor==[\d.]+/, 'zizmor>=1.30'); }, 'does not pin zizmor exactly'],
  ['zizmor installed without hashes', text('ci', '--require-hashes ', ''), 'does not install zizmor'],
  ['actionlint unverified', text('ci', 'sha256sum -c', 'true'), 'actionlint at an exact version'],
  ['the Stripe gate removed', json('renovate', (r) => { r.packageRules = r.packageRules.filter((x) => !x.matchPackageNames?.includes('stripe')); }), 'updates stripe in hosted without dashboard approval (patch, minor)'],
  ['the Stripe gate limited to majors', json('renovate', (r) => { r.packageRules.find((x) => x.matchPackageNames?.includes('stripe')).matchUpdateTypes = ['major']; }), 'updates @pgstencil/stripe in hosted without dashboard approval (patch, minor)'],
  ['a later rule lifts the Stripe gate', json('renovate', (r) => { r.packageRules.push({ matchManagers: ['npm'], matchPackageNames: ['@pgstencil/**'], dependencyDashboardApproval: false }); }), 'updates @pgstencil/stripe in hosted without dashboard approval (patch, minor, major)'],
]) {
  test(`reports: ${name}`, () => {
    const files = real();
    mutate(files);
    const failures = check(files);
    assert.ok(failures.some((f) => f.includes(expected)), `expected "${expected}"; got:\n${failures.join('\n')}`);
  });
}

// A standing allowance for a package the lockfile no longer holds waves the
// next one through unreviewed, so each entry must still name an installed one.
test('every peer and build allowance names an installed package', () => {
  const lock = readRepoFile('pnpm-lock.yaml');
  const installed = new Set([...lock.matchAll(/^ {2}'?(@?[^@'\s]+)@/gm)].map((m) => m[1]));
  const workspace = YAML.parse(readRepoFile('pnpm-workspace.yaml'));
  const stale = [
    ...Object.keys(workspace.peerDependencyRules?.allowedVersions ?? {}).map((key) => [key, key.split('>')[0]]),
    ...Object.keys(workspace.allowBuilds ?? {}).map((key) => [`allowBuilds ${key}`, key]),
  ].filter(([, name]) => !installed.has(name)).map(([entry]) => entry);
  assert.deepEqual(stale, []);
});
