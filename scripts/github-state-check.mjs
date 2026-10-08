#!/usr/bin/env node
/**
 * The deterministic half of the security audit: every `FAIL IF` whose answer
 * is GitHub state `AUDIT_PAT` can read — rulesets, the bot's role,
 * environments and their deployment policies and reviewers, the exhaustive
 * secret inventory, workflow permissions, repository security settings, the
 * Hosted tagger App's ruleset bypass, workflow liveness, the embargo
 * repository's visibility —
 * read live and judged against `.github/audit/expected-github-state.json`.
 *
 * It writes a report fragment in the form `.github/audit/_preamble.md` fixes
 * (verdict line, one `- PASS:` / `- FAIL:` / `- UNVERIFIABLE:` line per
 * clause, completion sentinel), so the workflow's reporting step reads it like
 * any domain's, and prints a SHA-256 of the normalized observed state that the
 * workflow's skip-unchanged decision compares between runs.
 *
 * Every inventory is enumerated from the API, never from the expected file: an
 * environment, ruleset, or secret the file does not name is judged by the rule
 * it falls under. Calls use `gh api`; `--local` reads a 403 as unverifiable
 * rather than as PAT scope drift, for an operator's own `gh` login.
 *
 * Result lines name these sections (scripts/spec-lint.mjs check 13 keeps them
 * honest): docs/specs/security-ci.md -> "Automated Maintainer (tend)",
 * "Hosted Deployments", and "VS Code Extension Releases";
 * docs/specs/security-supply-chain.md -> "Cooldown and alerts";
 * docs/specs/security.md -> "Reporting a vulnerability";
 * docs/specs/security-audit.md -> "Schedule and gate" and "Embargo".
 *
 * Usage: node scripts/github-state-check.mjs [--out <fragment>] [--local]
 *   [--repo <owner/name>]
 * In CI, `GH_TOKEN` is `AUDIT_PAT` and `WORKFLOW_TOKEN`, when set, is used for
 * the public endpoints (workflow runs, the App, the tend tag). With
 * `GITHUB_OUTPUT` set it also writes `hash=` and `verdict=` there.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { readRepoFile, repoRoot } from './lint-kit.mjs';

export const FRAGMENT = 'audit-github-state.md';
const EXPECTED = '.github/audit/expected-github-state.json';
const SENTINEL = '<!-- END OF REPORT -->';

const TEND = ['docs/specs/security-ci.md', 'Automated Maintainer (tend)'];
const HOSTED = ['docs/specs/security-ci.md', 'Hosted Deployments'];
const VSCODE = ['docs/specs/security-ci.md', 'VS Code Extension Releases'];
const COOLDOWN = ['docs/specs/security-supply-chain.md', 'Cooldown and alerts'];
const REPORTING = ['docs/specs/security.md', 'Reporting a vulnerability'];
const GATE = ['docs/specs/security-audit.md', 'Schedule and gate'];
const EMBARGO = ['docs/specs/security-audit.md', 'Embargo'];
export const SECTIONS = [TEND, HOSTED, VSCODE, COOLDOWN, REPORTING, GATE, EMBARGO];

// --- Fetching -------------------------------------------------------------

/** Pages from `gh api --paginate --slurp`, merged: arrays concatenate, list envelopes concatenate their array fields. */
function mergePages(pages) {
  if (!Array.isArray(pages)) return pages;
  if (pages.every(Array.isArray)) return pages.flat();
  const merged = {};
  for (const page of pages) {
    for (const [key, value] of Object.entries(page ?? {})) {
      if (Array.isArray(value)) merged[key] = [...(merged[key] ?? []), ...value];
      else if (!(key in merged)) merged[key] = value;
    }
  }
  return merged;
}

/**
 * `(path, { paginate, auth }) => { status, body }` over `gh api`. `auth:
 * 'public'` swaps in `WORKFLOW_TOKEN` when set; everything else runs on the
 * inherited `GH_TOKEN` (the PAT in CI) or the operator's login.
 */
function ghFetcher(env = process.env) {
  return (path, { paginate = false, auth = 'admin' } = {}) => {
    const args = ['api', '-H', 'Accept: application/vnd.github+json'];
    if (paginate) args.push('--paginate', '--slurp');
    args.push(path);
    const childEnv = { ...env };
    if (auth === 'public' && env.WORKFLOW_TOKEN) childEnv.GH_TOKEN = env.WORKFLOW_TOKEN;
    const run = spawnSync('gh', args, { env: childEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.error || run.status !== 0) {
      const status = /HTTP (\d{3})/.exec(run.stderr ?? '')?.[1];
      return { status: status ? Number(status) : 0, body: null };
    }
    const text = run.stdout.trim();
    if (!text) return { status: 204, body: null };
    const body = JSON.parse(text);
    return { status: 200, body: paginate ? mergePages(body) : body };
  };
}

/** The unauthenticated status code of a URL, as the `Embargo` rule's `curl` reads it. */
function curlStatus(url) {
  const run = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', url], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : '000';
}

// --- Observation ------------------------------------------------------------

const sorted = (values) => [...values].sort();
const byKey = (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b));
const enc = encodeURIComponent;

/** Every `max-sixty/tend/claude@<ref>` the generated workflows pin. */
function tendRefs() {
  const refs = new Set();
  for (const file of readdirSync(join(repoRoot, '.github/workflows')).filter((f) => /^tend-.*\.ya?ml$/.test(f))) {
    for (const [, ref] of readRepoFile(`.github/workflows/${file}`).matchAll(/max-sixty\/tend\/claude@([^\s#]+)/g)) refs.add(ref);
  }
  return sorted(refs);
}

/**
 * The repository's GitHub state, normalized so equal state hashes equally.
 * `errors` maps a state key to the HTTP status that kept it from being read;
 * `volatile` holds what changes without anything changing (run history) and is
 * left out of the hash.
 */
function observe(api, { repo, expected, tend = [], curl = curlStatus }) {
  const R = `repos/${repo}`;
  const state = { errors: {}, volatile: {} };
  const read = (key, path, opts = {}) => {
    const { status, body } = api(path, opts);
    if (status >= 200 && status < 300) return body ?? {};
    state.errors[key] = status;
    return undefined;
  };

  const list = read('rulesets', `${R}/rulesets?includes_parents=true`, { paginate: true });
  if (list) {
    state.rulesets = [];
    for (const { id } of list) {
      const r = read(`ruleset ${id}`, `${R}/rulesets/${id}`);
      if (!r) continue;
      state.rulesets.push({
        name: r.name, target: r.target, enforcement: r.enforcement, source: r.source_type ?? 'Repository',
        include: sorted(r.conditions?.ref_name?.include ?? []), exclude: sorted(r.conditions?.ref_name?.exclude ?? []),
        rules: sorted((r.rules ?? []).map((rule) => rule.type)),
        bypass: (r.bypass_actors ?? []).map(({ actor_type, actor_id, bypass_mode }) => ({ actor_type, actor_id, bypass_mode })).sort(byKey),
      });
    }
    state.rulesets.sort(byKey);
  }

  const bot = expected.botCollaborator.login;
  const perm = api(`${R}/collaborators/${enc(bot)}/permission`);
  if (perm.status === 200) state.bot = { permission: perm.body.permission, role_name: perm.body.role_name };
  else if (perm.status === 404) state.bot = { collaborator: false };
  else state.errors.bot = perm.status;

  const envs = read('environments', `${R}/environments`, { paginate: true });
  if (envs) {
    state.environments = [];
    for (const e of envs.environments ?? []) {
      const name = e.name;
      const base = `${R}/environments/${enc(name)}`;
      const reviewersRule = (e.protection_rules ?? []).find((rule) => rule.type === 'required_reviewers');
      const env = {
        name,
        branchPolicy: e.deployment_branch_policy
          ? { protected_branches: !!e.deployment_branch_policy.protected_branches, custom_branch_policies: !!e.deployment_branch_policy.custom_branch_policies }
          : null,
        reviewers: reviewersRule ? sorted((reviewersRule.reviewers ?? []).map(({ type, reviewer }) => `${type}:${reviewer?.login ?? reviewer?.slug ?? reviewer?.id}`)) : [],
        preventSelfReview: !!reviewersRule?.prevent_self_review,
        canAdminsBypass: e.can_admins_bypass,
      };
      if (env.branchPolicy?.custom_branch_policies) {
        const p = read(`environment ${name} policies`, `${base}/deployment-branch-policies`, { paginate: true });
        if (p) env.policies = (p.branch_policies ?? []).map(({ type, name: pattern }) => ({ type: type ?? 'branch', name: pattern })).sort(byKey);
      }
      const s = read(`environment ${name} secrets`, `${base}/secrets`, { paginate: true });
      if (s) env.secrets = sorted((s.secrets ?? []).map((x) => x.name));
      const v = read(`environment ${name} variables`, `${base}/variables`, { paginate: true });
      if (v) env.variables = sorted((v.variables ?? []).map((x) => x.name));
      state.environments.push(env);
    }
    state.environments.sort((a, b) => a.name.localeCompare(b.name));
  }

  const repoSecrets = read('repoSecrets', `${R}/actions/secrets`, { paginate: true });
  if (repoSecrets) state.repoSecrets = sorted((repoSecrets.secrets ?? []).map((x) => x.name));
  const orgSecrets = read('orgSecrets', `${R}/actions/organization-secrets`, { paginate: true });
  if (orgSecrets) state.orgSecrets = sorted((orgSecrets.secrets ?? []).map((x) => x.name));
  // Hashed, not judged: no rule constrains them.
  const repoVariables = read('repoVariables', `${R}/actions/variables`, { paginate: true });
  if (repoVariables) state.repoVariables = sorted((repoVariables.variables ?? []).map((x) => x.name));

  const wp = read('workflowPermissions', `${R}/actions/permissions/workflow`);
  if (wp) state.workflowPermissions = { default_workflow_permissions: wp.default_workflow_permissions, can_approve_pull_request_reviews: wp.can_approve_pull_request_reviews };
  const pvr = read('privateVulnerabilityReporting', `${R}/private-vulnerability-reporting`);
  if (pvr) state.privateVulnerabilityReporting = pvr.enabled === true;
  const meta = read('repository', R);
  if (meta) {
    state.securityAndAnalysis = meta.security_and_analysis
      ? Object.fromEntries(Object.entries(meta.security_and_analysis).map(([k, v]) => [k, v?.status ?? null]).sort())
      : null;
  }
  const alerts = api(`${R}/vulnerability-alerts`);
  if (alerts.status === 204 || alerts.status === 200) state.vulnerabilityAlerts = true;
  else if (alerts.status === 404) state.vulnerabilityAlerts = false;
  else state.errors.vulnerabilityAlerts = alerts.status;

  state.workflows = {};
  for (const file of sorted(new Set([...expected.activeWorkflows, expected.liveness.workflow]))) {
    const wf = api(`${R}/actions/workflows/${enc(file)}`, { auth: 'public' });
    if (wf.status === 200) state.workflows[file] = wf.body.state;
    else if (wf.status === 404) state.workflows[file] = 'missing';
    else state.errors[`workflow ${file}`] = wf.status;
  }
  const { workflow, event, branch } = expected.liveness;
  // Unfiltered by status, which `judge` filters itself: a `status=success`
  // listing was seen to omit the two newest runs (2026-10-07).
  const runs = read('liveness', `${R}/actions/workflows/${enc(workflow)}/runs?event=${event}&branch=${branch}&per_page=20`, { auth: 'public' });
  if (runs) state.volatile.runs = (runs.workflow_runs ?? []).map((r) => ({ id: r.id, created_at: r.created_at, event: r.event, head_branch: r.head_branch, conclusion: r.conclusion }));

  // The tagger App is private: `apps/<slug>` answers 404 or 403 to every token
  // an audit run holds, and only an org admin can list its installation. So its
  // permissions are no `FAIL IF` (docs/specs/security-ci.md -> "Hosted
  // Deployments"); an operator's admin login still gets a warning on drift.
  const [org] = repo.split('/');
  const installations = api(`orgs/${enc(org)}/installations`, { paginate: true });
  const app = installations.status === 200 ? (installations.body.installations ?? []).find((i) => i.app_id === expected.app.id) : undefined;
  if (app) state.app = { id: app.app_id, permissions: Object.fromEntries(Object.entries(app.permissions ?? {}).sort()), events: sorted(app.events ?? []) };

  // Not judged — the tag is mutable by design (docs/specs/security.md -> "What is not defended") — but
  // hashed, so a moved tag makes the next scheduled run audit in full.
  state.tend = {};
  for (const ref of tend) {
    const tag = api(`repos/max-sixty/tend/git/ref/tags/${enc(ref)}`, { auth: 'public' });
    state.tend[ref] = tag.status === 200 ? `${tag.body.object?.type}:${tag.body.object?.sha}` : `HTTP ${tag.status}`;
  }

  state.embargoStatus = curl(`https://github.com/${expected.embargoRepository}`);
  return state;
}

/** Stable JSON: object keys sorted at every depth. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function stateHash(state) {
  const { volatile, ...stable } = state;
  return createHash('sha256').update(canonical(stable)).digest('hex');
}

// --- Judgement --------------------------------------------------------------

const same = (a, b) => canonical(a) === canonical(b);
const show = (values) => (values.length ? values.map((v) => `\`${v}\``).join(', ') : 'none');
const showRef = ({ type, name }) => `${type} \`${name}\``;
const showBypass = (actors) => actors.map((b) => `${b.actor_type} ${b.actor_id} (${b.bypass_mode})`).join(', ');

/**
 * One result per clause. `local` reads a 403 as the operator's own login
 * falling short — unverifiable — rather than as drift in the CI PAT's scope.
 */
function judge(state, { expected, tendAllowed, now = new Date(), local = false }) {
  const results = [];
  const info = [];
  const warnings = [];
  const add = (verdict, [spec, heading], clause, evidence) => results.push({ verdict, spec, heading, clause, evidence });
  const unreadable = (keys) => keys.map((k) => [k, state.errors[k]]).filter(([, status]) => status !== undefined);
  /** Judge `fn` unless a state key it needs could not be read. */
  const check = (cite, clause, needs, fn) => {
    const missing = unreadable(needs);
    if (missing.length) {
      const drifted = !local && missing.some(([, status]) => status === 403 || status === 404);
      const detail = missing.map(([k, status]) => `${k}: HTTP ${status || 'error'}`).join('; ');
      if (drifted) add('FAIL', cite, clause, `could not read ${detail} — PAT scope drifted from docs/specs/security-audit.md`);
      else add('UNVERIFIABLE', cite, clause, `could not read ${detail}${local ? ' with the local `gh` login' : ''}`);
      return;
    }
    const [ok, evidence] = fn();
    add(ok ? 'PASS' : 'FAIL', cite, clause, evidence);
  };
  const rulesetErrors = Object.keys(state.errors).filter((k) => k.startsWith('ruleset'));

  // Rulesets: missing, inactive, or departing from the expected targets, rules, or bypass actors.
  for (const [name, want] of Object.entries(expected.rulesets)) {
    const cite = name.startsWith('Hosted') ? HOSTED : TEND;
    check(cite, `ruleset \`${name}\` exists and is active`, rulesetErrors, () => {
      const got = state.rulesets.filter((r) => r.name === name);
      if (got.length !== 1) return [false, `${got.length} rulesets named \`${name}\``];
      return [got[0].enforcement === 'active', `enforcement \`${got[0].enforcement}\``];
    });
    /** A clause on this ruleset; a missing one fails it. */
    const checkRuleset = (clause, fn) => check(cite, `ruleset \`${name}\` ${clause}`, rulesetErrors, () => {
      const r = state.rulesets.find((x) => x.name === name);
      return r ? fn(r) : [false, 'ruleset missing'];
    });
    checkRuleset(`targets ${want.target} refs ${show(want.include)}${want.exclude.length ? ` except ${show(want.exclude)}` : ''}`, (r) =>
      [r.target === want.target && same(r.include, want.include) && same(r.exclude, want.exclude), `target ${r.target}, include ${show(r.include)}, exclude ${show(r.exclude)}`]);
    checkRuleset(`blocks exactly ${show(want.rules)}`, (r) => [same(r.rules, want.rules), `rules ${show(r.rules)}`]);
    checkRuleset(`bypass actors are exactly ${showBypass(want.bypass)}`, (r) => [same(r.bypass, [...want.bypass].sort(byKey)), `bypass ${showBypass(r.bypass) || 'none'}`]);
  }
  check(HOSTED, `the Hosted tagger App (\`Integration\` ${expected.app.id}) bypasses no ruleset but \`Hosted tag creation\``, rulesetErrors, () => {
    const bypassed = state.rulesets.filter((r) => r.bypass.some((b) => b.actor_type === 'Integration' && b.actor_id === expected.app.id)).map((r) => r.name);
    return [same(bypassed, ['Hosted tag creation']), `bypassed rulesets: ${show(bypassed)}`];
  });
  if (!rulesetErrors.length) {
    for (const r of state.rulesets.filter((x) => !(x.name in expected.rulesets))) {
      info.push(`ruleset \`${r.name}\` (${r.target}, ${r.enforcement}) is not in \`${EXPECTED}\`; rulesets only restrict, so it fails nothing, but name it there.`);
    }
  }

  // The bot's role.
  check(TEND, `\`${expected.botCollaborator.login}\` holds neither ${expected.botCollaborator.forbiddenRoles.map((r) => `\`${r}\``).join(' nor ')}`, ['bot'], () => {
    if (state.bot.collaborator === false) return [true, 'not a collaborator'];
    const held = [state.bot.permission, state.bot.role_name];
    return [!held.some((role) => expected.botCollaborator.forbiddenRoles.includes(role)), `permission \`${state.bot.permission}\`, role_name \`${state.bot.role_name}\``];
  });

  // Environments: enumerated, each judged by the rule it falls under.
  const envErrors = Object.keys(state.errors).filter((k) => k === 'environments' || k.startsWith('environment '));
  const gated = expected.adminGatedRefs;
  check(TEND, 'every environment is one the expected state names', ['environments'], () => {
    const extra = state.environments.map((e) => e.name).filter((n) => !(n in expected.environments));
    return [extra.length === 0, `environments: ${show(state.environments.map((e) => e.name))}${extra.length ? `; not named: ${show(extra)}` : ''}`];
  });
  const envNames = envErrors.includes('environments') ? Object.keys(expected.environments)
    : sorted(new Set([...Object.keys(expected.environments), ...state.environments.map((e) => e.name)]));
  for (const name of envNames) {
    const want = expected.environments[name];
    const needs = ['environments', ...envErrors.filter((k) => k.startsWith(`environment ${name} `))];
    const e = state.environments?.find((x) => x.name === name);
    const hosted = expected.hostedEnvironments.includes(name);
    const reviewCite = name === 'vscode-extension-publish' ? VSCODE : HOSTED;
    /** A clause on this environment; a missing one fails it. */
    const checkEnv = (cite, clause, fn) => check(cite, `\`${name}\` ${clause}`, needs, () => (e ? fn(e) : [false, 'environment missing']));
    const wantPolicies = want && [...want.policies].sort(byKey);
    if (hosted) {
      checkEnv(HOSTED, `admits exactly ${want.policies.map(showRef).join(' and ')}`, (x) => (x.branchPolicy?.custom_branch_policies
        ? [same(x.policies, wantPolicies), `admits ${x.policies.map(showRef).join(', ') || 'nothing'}`]
        : [false, `deployment_branch_policy ${JSON.stringify(x.branchPolicy)}`]));
    }
    if (name !== 'hosted-preview') {
      checkEnv(TEND, 'admits only refs the `Merge access` or `Tag operations` ruleset reserves to admins', (x) => {
        if (!x.branchPolicy) return [false, 'no deployment branch policy: every branch and tag is admitted'];
        if (x.branchPolicy.protected_branches) return [false, '`protected_branches: true` admits any protected branch'];
        const loose = x.policies.filter((p) => !gated.some((g) => g.type === p.type && g.name === p.name));
        return [loose.length === 0, `admits ${x.policies.map(showRef).join(', ') || 'nothing'}${loose.length ? `; not admin-gated: ${loose.map(showRef).join(', ')}` : ''}`];
      });
      if (want && !hosted && e?.policies && !same(e.policies, wantPolicies)) {
        info.push(`\`${name}\` admits ${e.policies.map(showRef).join(', ') || 'nothing'}, not the ${want.policies.map(showRef).join(', ')} \`${EXPECTED}\` records; update the file or the spec's \`Today:\` list.`);
      }
    }
    if (want?.requiredReviewers) checkEnv(reviewCite, 'requires nonempty reviewers', (x) => [x.reviewers.length > 0, `reviewers ${show(x.reviewers)}`]);
    if (want?.preventSelfReview) checkEnv(VSCODE, 'sets `prevent_self_review: true`', (x) => [x.preventSelfReview === true, `prevent_self_review ${x.preventSelfReview}`]);
    if (want && 'canAdminsBypass' in want) {
      checkEnv(reviewCite, `sets \`can_admins_bypass: ${want.canAdminsBypass}\``, (x) => [x.canAdminsBypass === want.canAdminsBypass, `can_admins_bypass ${x.canAdminsBypass}`]);
    }
    checkEnv(TEND, 'holds exactly the secrets the inventory places there', (x) =>
      [same(x.secrets, sorted(want?.secrets ?? [])), `holds ${show(x.secrets)}; placed: ${show(want?.secrets ?? [])}`]);
    if (want?.variables) checkEnv(TEND, 'declares no environment variables', (x) => [same(x.variables, want.variables), `variables ${show(x.variables)}`]);
  }

  // Repo- and org-level secrets.
  check(TEND, `repo-level secrets are ${show(expected.repoSecrets)} and nothing else`, ['repoSecrets'], () => {
    const extra = state.repoSecrets.filter((s) => !expected.repoSecrets.includes(s));
    const absent = expected.repoSecrets.filter((s) => !state.repoSecrets.includes(s) && !expected.repoSecretsMayBeAbsent.includes(s));
    return [extra.length === 0 && absent.length === 0, `repo level holds ${show(state.repoSecrets)}`];
  });
  check(TEND, 'no org-level secret is visible to this repository', ['orgSecrets'], () => [same(state.orgSecrets, expected.orgSecrets), `organization-secrets lists ${show(state.orgSecrets)}`]);
  check(TEND, '`ANTHROPIC_API_KEY` is absent at repo and org level', ['repoSecrets', 'orgSecrets'], () => {
    const at = [state.repoSecrets.includes('ANTHROPIC_API_KEY') && 'repo', state.orgSecrets.includes('ANTHROPIC_API_KEY') && 'org'].filter(Boolean);
    return [at.length === 0, at.length ? `present at ${at.join(' and ')} level` : 'absent at both'];
  });
  check(TEND, 'every repo-level secret is in `.config/tend.yaml` `secrets.allowed`', ['repoSecrets'], () => {
    const missing = state.repoSecrets.filter((s) => !tendAllowed.includes(s));
    return [missing.length === 0, `allowed ${show(tendAllowed)}${missing.length ? `; missing ${show(missing)}` : ''}`];
  });
  const hostedSecrets = sorted(new Set(expected.hostedEnvironments.flatMap((n) => expected.environments[n].secrets)));
  check(HOSTED, 'no Hosted credential appears at repo or org scope', ['repoSecrets', 'orgSecrets'], () => {
    const leaked = [...state.repoSecrets, ...state.orgSecrets].filter((s) => hostedSecrets.includes(s));
    return [leaked.length === 0, leaked.length ? `found ${show(leaked)}` : `none of ${show(hostedSecrets)} at either`];
  });
  check(HOSTED, 'no production-only credential is in `hosted-preview`', ['environments', ...envErrors.filter((k) => k.startsWith('environment hosted-preview '))], () => {
    const preview = state.environments.find((e) => e.name === 'hosted-preview')?.secrets ?? [];
    const leaked = preview.filter((s) => expected.productionOnlySecrets.includes(s));
    return [leaked.length === 0, `hosted-preview holds ${show(preview)}`];
  });

  // Workflow token defaults, the backstop for every permission rule.
  for (const [key, value] of Object.entries(expected.workflowPermissions)) {
    check(TEND, `\`${key}\` is \`${value}\``, ['workflowPermissions'], () => [state.workflowPermissions[key] === value, `\`${state.workflowPermissions[key]}\``]);
  }

  // Workflow liveness.
  const { workflow, event, branch, hours, infoAfterHours } = expected.liveness;
  check(TEND, `\`${workflow}\` exists and is enabled`, [`workflow ${workflow}`], () => [state.workflows[workflow] === 'active', `state \`${state.workflows[workflow]}\``]);
  check(TEND, `\`${workflow}\` has a successful \`${event}\` run on \`${branch}\` in the last ${hours} hours`, ['liveness'], () => {
    const ok = state.volatile.runs.filter((r) => r.event === event && r.head_branch === branch && r.conclusion === 'success');
    const latest = ok.map((r) => Date.parse(r.created_at)).sort((a, b) => b - a)[0];
    if (latest === undefined) return [false, 'no successful scheduled run listed'];
    const age = (now.getTime() - latest) / 3_600_000;
    if (age <= hours && age > infoAfterHours) info.push(`\`${workflow}\`'s latest successful scheduled run is ${age.toFixed(1)} hours old: one scheduled run was skipped or failed.`);
    return [age <= hours, `latest at ${new Date(latest).toISOString()} (${age.toFixed(1)} hours ago)`];
  });
  for (const file of expected.activeWorkflows.filter((f) => f !== workflow)) {
    check(GATE, `\`${file}\` exists and is enabled`, [`workflow ${file}`], () => [state.workflows[file] === 'active', `state \`${state.workflows[file]}\``]);
  }

  // The Hosted tagger App, when this login can read it at all.
  if (state.app && !(same(state.app.permissions, expected.app.permissions) && same(state.app.events, expected.app.events))) {
    warnings.push(`the Hosted tagger App's installation holds ${JSON.stringify(state.app.permissions)} and events ${show(state.app.events)}, not ${JSON.stringify(expected.app.permissions)} and none; read by an org-admin login, beyond what an audit run can read.`);
  }

  // Repository security settings.
  for (const [key, clause] of [['secret_scanning', 'secret scanning is enabled'], ['secret_scanning_push_protection', 'secret scanning push protection is enabled']]) {
    check(COOLDOWN, clause, ['repository'], () => (state.securityAndAnalysis
      ? [state.securityAndAnalysis[key] === 'enabled', `\`${state.securityAndAnalysis[key] ?? null}\``]
      : [false, '`security_and_analysis` absent (a non-admin token)']));
  }
  check(COOLDOWN, 'Dependabot alerts are on (`vulnerability-alerts` answers 204)', ['vulnerabilityAlerts'], () => [state.vulnerabilityAlerts, state.vulnerabilityAlerts ? '204' : '404']);
  check(REPORTING, 'private vulnerability reporting is enabled', ['privateVulnerabilityReporting'], () => [state.privateVulnerabilityReporting, `enabled: ${state.privateVulnerabilityReporting}`]);

  // The embargo tracker is private.
  const clause = `\`${expected.embargoRepository}\` answers 404 unauthenticated`;
  if (state.embargoStatus === '000') add('UNVERIFIABLE', EMBARGO, clause, 'curl reached no server');
  else add(state.embargoStatus === '404' ? 'PASS' : 'FAIL', EMBARGO, clause, `HTTP ${state.embargoStatus}`);

  return { results, info, warnings };
}

/** The fragment: verdict line, result lines, findings, sentinel. */
function fragment({ results, info, warnings = [] }, hash) {
  const verdict = results.some((r) => r.verdict === 'FAIL') ? 'FAIL'
    : results.some((r) => r.verdict === 'UNVERIFIABLE') ? 'INCONCLUSIVE' : 'PASS';
  const lines = [`VERDICT: ${verdict}`, '',
    `Deterministic: \`scripts/github-state-check.mjs\` against \`${EXPECTED}\`. Observed-state hash \`${hash}\`.`, '',
    '### FAIL IF results', ''];
  for (const r of results) lines.push(`- ${r.verdict}: \`${r.spec}\` -> "${r.heading}" — ${r.clause}: ${r.evidence}`);
  lines.push('', '### Qualitative findings', '');
  for (const text of warnings) lines.push(`- WARNING: ${text}`);
  for (const text of info) lines.push(`- INFO: ${text}`);
  if (!info.length && !warnings.length) lines.push('None: this fragment judges only the clauses above.');
  lines.push('', SENTINEL, '');
  return { verdict, text: lines.join('\n') };
}

/** `secrets.allowed` from `.config/tend.yaml`. */
function tendAllowedSecrets() {
  return YAML.parse(readRepoFile('.config/tend.yaml'))?.secrets?.allowed ?? [];
}

const loadExpected = () => JSON.parse(readRepoFile(EXPECTED));

/** Observe, judge, and render, over any fetcher. */
export function run({ api, curl, expected = loadExpected(), tend = tendRefs(), tendAllowed = tendAllowedSecrets(), now, local = false, repo = expected.repository }) {
  const state = observe(api, { repo, expected, tend, curl });
  const hash = stateHash(state);
  const judged = judge(state, { expected, tendAllowed, now, local });
  return { state, hash, ...judged, ...fragment(judged, hash) };
}

function main(argv) {
  const args = { out: null, local: false, repo: undefined };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--local') args.local = true;
    else if (argv[i] === '--repo') args.repo = argv[++i];
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  const result = run({ api: ghFetcher(), local: args.local, repo: args.repo });
  if (args.out) writeFileSync(args.out, result.text);
  process.stdout.write(result.text);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `hash=${result.hash}\nverdict=${result.verdict}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
