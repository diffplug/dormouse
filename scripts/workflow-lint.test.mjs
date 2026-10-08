import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, loadInputs } from './workflow-lint.mjs';

// Each case plants one violation in an in-memory copy of the real workflow
// files and requires `scripts/workflow-lint.mjs` to report it; a rule whose
// case stays green is a claim, not a check (AGENTS.md).
const real = loadInputs();

test('the real workflows pass', () => {
  assert.deepEqual(check(real), []);
});

const edit = (file, from, to) => (inputs) => {
  const text = inputs.workflows[file];
  assert.ok(text.includes(from), `${file} no longer contains ${JSON.stringify(from)}; re-point this case`);
  inputs.workflows[file] = text.replace(from, to);
};
const add = (file, text) => (inputs) => { inputs.workflows[file] = text; };
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';

const cases = [
  ['an action referenced by tag', edit('ci.yml', `uses: ${CHECKOUT}`, 'uses: actions/checkout@v7'), 'by something other than a commit hash'],
  ['an action referenced by a short hash', edit('argos.yml', `uses: ${CHECKOUT}`, 'uses: actions/checkout@3d3c42e'), 'by something other than a commit hash'],
  ['a docker action by tag', add('extra.yml', 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker://alpine:3\n'), 'not pinned by digest'],
  ['a reusable workflow by branch', add('extra.yml', 'on: push\njobs:\n  a:\n    uses: octo/repo/.github/workflows/x.yml@main\n'), 'by something other than a commit hash'],
  ['tend referenced outside tend-*.yaml', edit('ci.yml', `uses: ${CHECKOUT}`, 'uses: max-sixty/tend/claude@0.3.10'), 'which only `tend-*.yaml` may reference by tag'],
  ['tend unpinned', edit('tend-review.yaml', 'max-sixty/tend/claude@0.3.10', 'max-sixty/tend/claude@main'), 'not a released version'],
  ['tend below 0.1.19', edit('tend-review.yaml', 'max-sixty/tend/claude@0.3.10', 'max-sixty/tend/claude@0.1.18'), 'below 0.1.19'],
  ['tend in yolo mode', edit('tend-review.yaml', 'merge: restricted', 'merge: yolo'), 'passes `merge: yolo`'],
  ['.config/tend.yaml in yolo mode', (inputs) => { inputs.tendConfig = inputs.tendConfig.replace('merge: restricted', 'merge: yolo'); }, '.config/tend.yaml sets `merge: yolo`'],
  ['pull_request_target outside tend', edit('argos.yml', '\non:\n', '\non:\n  pull_request_target:\n'), 'triggers on `pull_request_target`'],
  ['a non-agent workflow with contents: write', edit('ci.yml', 'permissions:\n  contents: read', 'permissions:\n  contents: write'), 'ci.yml job `build-and-test` holds write on contents'],
  ['a non-agent workflow with write-all', edit('ci.yml', 'permissions:\n  contents: read', 'permissions: write-all'), 'holds write on *'],
  ['release.yml build job writes packages', edit('release.yml', '      id-token: write\n      attestations: write\n    strategy:', '      id-token: write\n      attestations: write\n      packages: write\n    strategy:'), 'build-standalone` holds write on packages'],
  ['actions: write beyond the audit dispatch', edit('release.yml', '      id-token: write\n      attestations: write\n    steps:', '      id-token: write\n      attestations: write\n      actions: write\n    steps:'), 'build-vscode` holds write on actions'],
  ['an agent-managed job with actions: write', edit('tend-review.yaml', '      actions: read\n', '      actions: write\n'), 'tend-review.yaml job `review` holds write on actions'],
  ['an agent-managed job with checks: write', edit('security-audit.yaml', '      actions: read\n      issues: write', '      actions: read\n      checks: write\n      issues: write'), 'security-audit.yaml job `audit` holds write on checks'],
  ['an agent-managed job with id-token: write', edit('security-audit.yaml', '      actions: read\n      issues: write', '      actions: read\n      issues: write\n      id-token: write'), 'security-audit.yaml job `audit` holds write on id-token'],
  ['the audit agent on the Claude App token', edit('security-audit.yaml', '          github_token: ${{ github.token }}\n', ''), 'job `audit` runs `anthropics/claude-code-action` without `github_token`'],
  ['the canary agent on the Claude App token', edit('security-audit.yaml', '    # read-only workflow token passed below instead.\n    permissions:\n      contents: read\n', '    # read-only workflow token passed below instead.\n    permissions:\n      contents: read\n      id-token: write\n'), 'job `canary` holds write on id-token'],
  ['a tend job-level env', edit('tend-review.yaml', '    runs-on: ubuntu-24.04\n', '    runs-on: ubuntu-24.04\n    env:\n      X: y\n'), 'job-level `env:`'],
  ['a tend workflow-level env', edit('tend-review.yaml', '\njobs:\n', '\nenv:\n  X: y\njobs:\n'), 'workflow-level `env:`'],
  ['release.yml on a branch push', edit('release.yml', "    tags:\n      - 'v*'", "    branches: [main]\n    tags:\n      - 'v*'"), 'not only a pushed `v*` tag'],
  ['release.yml on any tag', edit('release.yml', "      - 'v*'", "      - '*'"), 'not only a pushed `v*` tag'],
  ['release.yml also on dispatch', edit('release.yml', "      - 'v*'\n", "      - 'v*'\n  workflow_dispatch:\n"), 'not only a pushed `v*` tag'],
  ['the audit job uses its token for more', edit('release.yml', '          echo "Watching security-audit run', '          gh workflow disable ci.yml -R "$repo"\n          echo "Watching security-audit run'), '`gh workflow disable`'],
  ['the audit job dispatches another workflow', edit('release.yml', 'workflow="security-audit.yaml"', 'workflow="release.yml"'), 'does not dispatch `security-audit.yaml`'],
  ['publish-vscode unbound from its environment', edit('release.yml', '    environment:\n      name: vscode-extension-publish', '    environment:\n      name: release-attest'), '`publish-vscode` is not bound'],
  ['VSCE_PAT read outside the publish environment', edit('ci.yml', '      - name: Build\n        run: pnpm build', '      - name: Build\n        run: pnpm build\n        env:\n          VSCE_PAT: ${{ secrets.VSCE_PAT }}'), 'reads `VSCE_PAT` outside'],
  ['OVSX_PAT read by bracket outside the publish environment', edit('argos.yml', '\njobs:\n', "\nenv:\n  T: ${{ secrets['OVSX_PAT'] }}\njobs:\n"), 'reads `OVSX_PAT` outside'],
  ['a production signing secret in release.yml', edit('release.yml', '          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}', '          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}'), 'reads `TAURI_SIGNING_PRIVATE_KEY`'],
  ['no ephemeral updater key', edit('release.yml', 'tauri signer generate', 'tauri signer sign'), 'ephemeral Tauri updater key'],
  ['hosted-release-tag bound to another job', edit('hosted-production.yml', '  verify:\n', '  verify:\n    environment: hosted-release-tag\n'), 'job `verify` uses `hosted-release-tag`'],
  ['HOSTED_TAG_TOKEN read', edit('hosted-production.yml', '          BUILD_SHA: ${{ github.sha }}', '          BUILD_SHA: ${{ secrets.HOSTED_TAG_TOKEN }}'), 'reads `HOSTED_TAG_TOKEN`'],
  ['the App token minted for every repository', edit('hosted-production.yml', '          repositories: dormouse\n', ''), 'only `permission-contents: write`'],
  ['the App token minted with another permission', edit('hosted-production.yml', '          permission-contents: write', '          permission-contents: write\n          permission-workflows: write'), 'only `permission-contents: write`'],
  ['the tag step handed another credential', edit('hosted-production.yml', '          BUILD_SHA: ${{ github.sha }}', '          BUILD_SHA: ${{ github.sha }}\n          EXTRA: ${{ github.token }}'), 'holds a credential besides the minted token'],
  ['Renovate re-enabled for tend files', (inputs) => {
    const renovate = JSON.parse(inputs.renovate);
    renovate.packageRules.push({ matchManagers: ['github-actions'], enabled: true });
    inputs.renovate = JSON.stringify(renovate);
  }, "Renovate's `github-actions` manager can update"],
  ['Renovate tend exclusion removed', (inputs) => {
    const renovate = JSON.parse(inputs.renovate);
    renovate.packageRules = renovate.packageRules.filter((r) => !(r.matchFileNames ?? []).includes('.github/workflows/tend-*.yaml'));
    inputs.renovate = JSON.stringify(renovate);
  }, "Renovate's `github-actions` manager can update"],
  ['the workflow-audit window drops `.github/audit/`', edit('workflow-audit.yaml', 'WINDOW=(.github/workflows/ .config/tend.yaml .github/audit/ ', 'WINDOW=(.github/workflows/ .config/tend.yaml '), "workflow-audit.yaml's `WINDOW`"],
];

for (const [name, mutate, expected] of cases) {
  test(`reports: ${name}`, () => {
    const inputs = structuredClone(real);
    mutate(inputs);
    const failures = check(inputs);
    assert.ok(failures.some((f) => f.includes(expected)), `expected "${expected}"; got:\n${failures.join('\n')}`);
  });
}

test('reports: a tend step writing a secret to $GITHUB_ENV', () => {
  const inputs = structuredClone(real);
  edit('tend-review.yaml', '            || echo "::warning::could not add the eyes reaction"\n', '            || echo "::warning::could not add the eyes reaction"\n          echo "T=$GITHUB_TOKEN" >> "$GITHUB_ENV"\n')(inputs);
  assert.ok(check(inputs).some((f) => f.includes('writes to `$GITHUB_ENV`')));
});
