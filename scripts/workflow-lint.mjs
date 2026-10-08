#!/usr/bin/env node
/**
 * The repository-specific workflow rules zizmor and actionlint do not know,
 * read from the parsed workflow files. Each rule is a `FAIL IF` in
 * docs/specs/security-ci.md -> "GitHub Actions Policies",
 * "Automated Maintainer (tend)", "Hosted Deployments", and
 * "VS Code Extension Releases", which own the values; this file only reads
 * them off the workflows.
 *
 * Effective permissions follow the spec's definition: job permissions over
 * workflow permissions over the repository default, which
 * `scripts/github-state-check.mjs` pins to `read` — so a job declaring
 * nothing holds no write scope. An explicit block leaves every omitted scope
 * at `none`.
 *
 * `scripts/workflow-lint.test.mjs` plants each violation in an in-memory copy
 * of the real files and requires this lint to report it.
 */

import { readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { readRepoFile, repoRoot } from './lint-kit.mjs';

const POLICIES = 'docs/specs/security-ci.md -> "GitHub Actions Policies"';
const TEND = 'docs/specs/security-ci.md -> "Automated Maintainer (tend)"';
const HOSTED = 'docs/specs/security-ci.md -> "Hosted Deployments"';
const VSCODE = 'docs/specs/security-ci.md -> "VS Code Extension Releases"';

/** The one action a workflow may reference by tag, and only from the generated files. */
const TEND_ACTION = 'max-sixty/tend/claude';
const TEND_MINIMUM = [0, 1, 19];
const AGENT_MANAGED = (file) => /^tend-.*\.ya?ml$/.test(file) || file === 'workflow-audit.yaml' || file === 'security-audit.yaml';
const AGENT_WRITES = ['contents', 'pull-requests', 'issues', 'id-token'];
const RELEASE_WRITES = ['id-token', 'attestations'];
const WINDOW = ['.github/workflows/', '.config/tend.yaml', '.github/audit/', '.vscode/', '.gitattributes', 'scripts/setup-git.mjs', 'scripts/md-merge.mjs', 'scripts/md-unwrap.mjs'];

export function loadInputs() {
  const workflows = {};
  for (const file of readdirSync(join(repoRoot, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    workflows[file] = readRepoFile(`.github/workflows/${file}`);
  }
  return { workflows, tendConfig: readRepoFile('.config/tend.yaml'), renovate: readRepoFile('.github/renovate.json') };
}

/** `{ scope: 'read'|'write'|'none' }` for a `permissions:` value, or `*` for `write-all`. */
function scopes(permissions) {
  if (permissions === 'write-all') return { '*': 'write' };
  if (permissions === 'read-all' || permissions === null) return {};
  if (typeof permissions === 'string') return { '*': permissions };
  return { ...permissions };
}
const writes = (permissions) => Object.entries(scopes(permissions)).filter(([, level]) => level === 'write').map(([scope]) => scope);

/** Every `uses:` in a workflow, job-level and step-level, with where it sits. */
function usesOf(doc) {
  const out = [];
  for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
    if (job?.uses) out.push({ jobId, uses: job.uses });
    for (const step of job?.steps ?? []) if (step?.uses) out.push({ jobId, uses: step.uses, step });
  }
  return out;
}

const triggers = (doc) => {
  const on = doc.on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on;
  return Object.keys(on ?? {});
};

const environmentOf = (job) => (typeof job?.environment === 'string' ? job.environment : job?.environment?.name);

/** What a job can see: its own text plus the workflow-level `env:`. */
const jobText = (doc, job) => JSON.stringify([doc.env ?? null, job]);

/** Secret names a job can read. */
function secretsOf(doc, job) {
  return new Set([...jobText(doc, job).matchAll(/secrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*'([^']+)'\s*\])/g)].map((m) => m[1] ?? m[2]));
}

const compareVersions = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

export function check(inputs) {
  const failures = [];
  const fail = (cite, message) => failures.push(`${cite}: ${message}`);
  const docs = {};
  for (const [file, text] of Object.entries(inputs.workflows)) {
    try {
      docs[file] = YAML.parse(text);
    } catch (error) {
      fail(POLICIES, `${file} does not parse: ${error.message}`);
    }
  }

  for (const [file, doc] of Object.entries(docs)) {
    const agent = AGENT_MANAGED(file);
    const tend = /^tend-/.test(file);

    for (const { jobId, uses } of usesOf(doc)) {
      if (uses.startsWith('./')) continue;
      const [action, ref = ''] = uses.split('@');
      if (uses.startsWith('docker://')) {
        if (!/@sha256:[0-9a-f]{64}$/.test(uses)) fail(POLICIES, `${file} job \`${jobId}\` runs \`${uses}\`, not pinned by digest`);
        continue;
      }
      if (action === TEND_ACTION) {
        if (!tend) fail(POLICIES, `${file} job \`${jobId}\` uses \`${TEND_ACTION}\`, which only \`tend-*.yaml\` may reference by tag`);
        const version = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(ref);
        if (!version) fail(TEND, `${file} job \`${jobId}\` references \`${uses}\`, not a released version`);
        else if (compareVersions(version.slice(1).map(Number), TEND_MINIMUM) < 0) fail(TEND, `${file} pins \`${uses}\`, below ${TEND_MINIMUM.join('.')}`);
        continue;
      }
      if (!/^[0-9a-f]{40}$/.test(ref)) fail(POLICIES, `${file} job \`${jobId}\` references \`${uses}\` by something other than a commit hash`);
    }

    if (triggers(doc).includes('pull_request_target') && !tend) fail(POLICIES, `${file} triggers on \`pull_request_target\``);

    for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
      const declared = job?.permissions !== undefined ? job.permissions : doc.permissions;
      const held = declared === undefined ? [] : writes(declared);
      if (agent) {
        const extra = held.filter((s) => !AGENT_WRITES.includes(s));
        if (extra.length) fail(TEND, `${file} job \`${jobId}\` holds write on ${extra.join(', ')}`);
      } else {
        const allowed = file === 'release.yml' && jobId === 'security-audit' ? [...RELEASE_WRITES, 'actions'] : RELEASE_WRITES;
        const extra = held.filter((s) => !allowed.includes(s));
        if (extra.length) fail(POLICIES, `${file} job \`${jobId}\` holds write on ${extra.join(', ')}`);
      }
      if (tend && job?.env !== undefined) fail(TEND, `${file} job \`${jobId}\` sets a job-level \`env:\`, which the harness forwards to the agent`);
      for (const step of job?.steps ?? []) {
        if (step?.uses?.startsWith(`${TEND_ACTION}@`) && step.with?.merge !== 'restricted') {
          fail(TEND, `${file} job \`${jobId}\` passes \`merge: ${step.with?.merge}\` to \`${TEND_ACTION}\``);
        }
        if (tend && typeof step?.run === 'string' && /GITHUB_ENV/.test(step.run) && /secrets\./.test(JSON.stringify(step.env ?? {}))) {
          fail(TEND, `${file} job \`${jobId}\` writes to \`$GITHUB_ENV\` from a step holding a secret`);
        }
      }

      // Credentials bound to a protected environment are read only from jobs bound to it, in any workflow.
      const secrets = secretsOf(doc, job);
      const environment = environmentOf(job);
      for (const name of ['VSCE_PAT', 'OVSX_PAT']) {
        if (secrets.has(name) && environment !== 'vscode-extension-publish') fail(VSCODE, `${file} job \`${jobId}\` reads \`${name}\` outside \`vscode-extension-publish\``);
      }
      if (environment === 'hosted-release-tag' && !(file === 'hosted-production.yml' && jobId === 'tag')) {
        fail(HOSTED, `${file} job \`${jobId}\` uses \`hosted-release-tag\`; only \`tag\` in hosted-production.yml may`);
      }
      if (jobText(doc, job).includes('HOSTED_TAG_TOKEN')) fail(HOSTED, `${file} job \`${jobId}\` reads \`HOSTED_TAG_TOKEN\``);
    }
    if (tend && doc.env !== undefined) fail(TEND, `${file} sets a workflow-level \`env:\`, which the harness forwards to the agent`);
  }

  // release.yml: tags only, the audit dispatch, the publish environment, no production signing secret.
  const release = docs['release.yml'];
  if (!release) fail(POLICIES, 'release.yml is missing');
  else {
    const on = release.on;
    const tagOnly = on && typeof on === 'object' && !Array.isArray(on) && Object.keys(on).length === 1 && on.push
      && Object.keys(on.push).length === 1 && JSON.stringify(on.push.tags) === '["v*"]';
    if (!tagOnly) fail(POLICIES, `release.yml runs on ${JSON.stringify(on)}, not only a pushed \`v*\` tag`);
    const audit = release.jobs?.['security-audit'];
    const run = (audit?.steps ?? []).map((s) => s.run ?? '').join('\n').replace(/^\s*#.*$/gm, '');
    const ghCalls = [...run.matchAll(/(?:^|[\s$(;|&])gh\s+([a-z-]+)(?:\s+([a-z-]+))?/gm)].map((m) => `${m[1]} ${m[2] ?? ''}`.trim());
    const allowedGh = ['workflow run', 'run list', 'run watch'];
    if (!audit) fail(POLICIES, 'release.yml has no `security-audit` job');
    else {
      const strays = ghCalls.filter((c) => !allowedGh.includes(c));
      if (strays.length) fail(POLICIES, `release.yml \`security-audit\` runs \`gh ${strays.join('`, `gh ')}\` with its \`actions: write\``);
      if (!/workflow="security-audit\.yaml"/.test(run) || !/gh workflow run "\$workflow"/.test(run)) fail(POLICIES, 'release.yml `security-audit` does not dispatch `security-audit.yaml`');
      if (audit.steps?.some((s) => s.uses)) fail(POLICIES, 'release.yml `security-audit` runs an action with its `actions: write`');
    }
    if (environmentOf(release.jobs?.['publish-vscode']) !== 'vscode-extension-publish') fail(VSCODE, 'release.yml `publish-vscode` is not bound to `vscode-extension-publish`');
    const releaseSecrets = new Set(Object.values(release.jobs ?? {}).flatMap((job) => [...secretsOf(release, job)]));
    const extra = [...releaseSecrets].filter((s) => !['GITHUB_TOKEN', 'VSCE_PAT', 'OVSX_PAT'].includes(s));
    if (extra.length) fail(VSCODE, `release.yml reads ${extra.map((s) => `\`${s}\``).join(', ')}; production signing stays local`);
    const ephemeral = (release.jobs?.['build-standalone']?.steps ?? []).some((s) => /tauri signer generate/.test(s.run ?? ''));
    if (!ephemeral) fail(VSCODE, 'release.yml `build-standalone` no longer generates an ephemeral Tauri updater key');
  }

  // hosted-production.yml `tag`: the minted token is the only credential, scoped to contents on this repository.
  const tag = docs['hosted-production.yml']?.jobs?.tag;
  const mint = tag?.steps?.find((s) => s.uses?.startsWith('actions/create-github-app-token@'));
  if (!mint) fail(HOSTED, 'hosted-production.yml `tag` mints no App token');
  else {
    const inputs = mint.with ?? {};
    const permissions = Object.entries(inputs).filter(([k]) => k.startsWith('permission-'));
    if (inputs.owner !== 'diffplug' || inputs.repositories !== 'dormouse' || JSON.stringify(permissions) !== '[["permission-contents","write"]]') {
      fail(HOSTED, `hosted-production.yml \`tag\` mints its token with ${JSON.stringify(inputs)}, not \`owner: diffplug\`, \`repositories: dormouse\`, and only \`permission-contents: write\``);
    }
    for (const step of tag.steps.filter((s) => s !== mint)) {
      const text = JSON.stringify(step);
      if (/secrets\.|github\.token|GITHUB_TOKEN/.test(text)) fail(HOSTED, `hosted-production.yml \`tag\` step \`${step.name ?? step.uses}\` holds a credential besides the minted token`);
    }
  }

  // .config/tend.yaml and the Renovate boundary.
  const tendConfig = YAML.parse(inputs.tendConfig);
  if (tendConfig?.merge !== 'restricted') fail(TEND, `.config/tend.yaml sets \`merge: ${tendConfig?.merge}\`, not \`restricted\``);
  const rules = JSON.parse(inputs.renovate).packageRules ?? [];
  const covers = (rule) => (rule.matchManagers ?? []).includes('github-actions')
    && (rule.matchFileNames ?? []).some((pattern) => pattern === '.github/workflows/tend-*.yaml' || pattern === '.github/workflows/**');
  const offAt = rules.findLastIndex((rule) => covers(rule) && rule.enabled === false);
  const reEnabled = rules.slice(offAt + 1).some((rule) => (rule.matchManagers ?? []).includes('github-actions') && rule.enabled === true);
  if (offAt < 0 || reEnabled) fail(TEND, 'Renovate\'s `github-actions` manager can update `.github/workflows/tend-*.yaml`');

  // workflow-audit's diff window.
  const window = /^\s*WINDOW=\(([^)]*)\)/m.exec(inputs.workflows['workflow-audit.yaml'] ?? '')?.[1].trim().split(/\s+/);
  if (JSON.stringify(window) !== JSON.stringify(WINDOW)) fail(TEND, `workflow-audit.yaml's \`WINDOW\` is ${JSON.stringify(window)}, not ${JSON.stringify(WINDOW)}`);

  return failures;
}

function main() {
  const inputs = loadInputs();
  const failures = check(inputs);
  if (failures.length) {
    console.error(`workflow-lint: ${failures.length} violation(s)\n`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`workflow-lint: OK (${Object.keys(inputs.workflows).length} workflows)`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
