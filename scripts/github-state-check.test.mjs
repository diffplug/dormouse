import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FRAGMENT, run, SECTIONS, stateHash } from './github-state-check.mjs';
import { repoRoot, tempDir } from './lint-kit.mjs';
import { tallyFragment } from './security-audit-public-body.mjs';

// Responses recorded from the live API with the maintainer's `gh` login (URLs,
// node ids, and variable values stripped), replayed with no network. Every
// case below plants one violation in them and requires the clause it breaks
// to read FAIL, so a check that stops judging its clause goes red here.
const fixture = JSON.parse(readFileSync(new URL('./github-state-check.fixture.json', import.meta.url), 'utf8'));
const NOW = new Date(Date.parse(fixture.recordedAt) + 3_600_000);
const R = 'repos/diffplug/dormouse';
const ADMIN = { actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'exempt' };
const APP = { actor_type: 'Integration', actor_id: 5228264, bypass_mode: 'always' };

function replay(mutate = () => {}, { local = false, now = NOW } = {}) {
  const ctx = { responses: structuredClone(fixture.responses), embargo: fixture.embargoStatus, tendAllowed: ['ARGOS_TOKEN', 'CHROMATIC_PROJECT_TOKEN'] };
  mutate(ctx);
  const api = (path) => structuredClone(ctx.responses[path] ?? { status: 404, body: null });
  return run({ api, curl: () => ctx.embargo, now, local, tendAllowed: ctx.tendAllowed });
}

const body = (ctx, path) => ctx.responses[`${R}/${path}`].body;
const ruleset = (ctx, name) => Object.entries(ctx.responses)
  .find(([path, r]) => /\/rulesets\/\d+$/.test(path) && r.body?.name === name)[1].body;
const env = (ctx, name) => body(ctx, 'environments').environments.find((e) => e.name === name);
const names = (list) => list.map((name) => ({ name }));
const LISTINGS = ['&status=success&per_page=10', '&per_page=20'].map((q) => `actions/workflows/workflow-audit.yaml/runs?event=schedule&branch=main${q}`);
/** Every run either liveness listing returns. */
const liveRuns = (ctx) => LISTINGS.flatMap((path) => body(ctx, path).workflow_runs);
function addEnvironment(ctx, name, { policy = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }, policies = [{ name: 'main', type: 'branch' }], secrets = [] } = {}) {
  body(ctx, 'environments').environments.push({ name, protection_rules: [], can_admins_bypass: true, ...policy });
  ctx.responses[`${R}/environments/${name}/deployment-branch-policies`] = { status: 200, body: { total_count: policies.length, branch_policies: policies } };
  ctx.responses[`${R}/environments/${name}/secrets`] = { status: 200, body: { total_count: secrets.length, secrets: names(secrets) } };
  ctx.responses[`${R}/environments/${name}/variables`] = { status: 200, body: { total_count: 0, variables: [] } };
}

const lines = (result, verdict) => result.results.filter((r) => r.verdict === verdict).map((r) => r.clause);

test('the recorded live state passes every clause', () => {
  const result = replay();
  assert.equal(result.verdict, 'PASS', lines(result, 'FAIL').join('\n'));
  assert.deepEqual(result.info, []);
  assert.ok(result.results.length >= 55, `${result.results.length} results`);
});

// Each result names a heading that exists in its spec, in the line form the
// public issue builder recognizes — so a failed check is counted under its
// section there, never as an unnamed one.
test('every result line names a real spec heading the public builder accepts', () => {
  const failing = replay((ctx) => { ctx.embargo = '200'; body(ctx, 'actions/permissions/workflow').default_workflow_permissions = 'write'; });
  const tally = tallyFragment(failing.text, repoRoot);
  assert.equal(tally.failed, 2);
  assert.equal(tally.unnamed, 0);
  for (const [spec, heading] of SECTIONS) {
    const headings = readFileSync(join(repoRoot, spec), 'utf8').split('\n').map((l) => l.match(/^#{2,6}\s+(.+?)\s*$/)?.[1]);
    assert.ok(headings.includes(heading), `${spec} has no heading "${heading}"`);
  }
});

test('the fragment opens with its verdict and closes with the sentinel', () => {
  for (const [mutate, verdict] of [[undefined, 'PASS'], [(ctx) => { ctx.embargo = '200'; }, 'FAIL'], [(ctx) => { ctx.responses[`${R}/actions/secrets`] = { status: 502, body: null }; }, 'INCONCLUSIVE']]) {
    const { text } = replay(mutate);
    assert.equal(text.split('\n')[0], `VERDICT: ${verdict}`);
    assert.equal(text.trim().split('\n').at(-1), '<!-- END OF REPORT -->');
  }
});

const violations = [
  ['`Merge access` disabled', (ctx) => { ruleset(ctx, 'Merge access').enforcement = 'disabled'; }, 'ruleset `Merge access` exists and is active'],
  ['`Merge access` stops blocking deletion', (ctx) => { const r = ruleset(ctx, 'Merge access'); r.rules = r.rules.filter((x) => x.type !== 'deletion'); }, 'ruleset `Merge access` blocks exactly'],
  ['`Merge access` gains a bypass actor', (ctx) => { ruleset(ctx, 'Merge access').bypass_actors.push({ actor_id: 1, actor_type: 'Team', bypass_mode: 'always' }); }, 'ruleset `Merge access` bypass actors'],
  ['admin bypass loosened to pull requests only', (ctx) => { ruleset(ctx, 'Merge access').bypass_actors[0].bypass_mode = 'pull_request'; }, 'ruleset `Merge access` bypass actors'],
  ['`Merge access` retargeted', (ctx) => { ruleset(ctx, 'Merge access').conditions.ref_name.include = ['refs/heads/release']; }, 'ruleset `Merge access` targets'],
  ['`Tag operations` deleted', (ctx) => {
    const id = ruleset(ctx, 'Tag operations').id;
    delete ctx.responses[`${R}/rulesets/${id}`];
    ctx.responses[`${R}/rulesets?includes_parents=true`].body = ctx.responses[`${R}/rulesets?includes_parents=true`].body.filter((r) => r.id !== id);
  }, 'ruleset `Tag operations` exists and is active'],
  ['`Tag operations` excludes release tags', (ctx) => { ruleset(ctx, 'Tag operations').conditions.ref_name.exclude.push('refs/tags/v*'); }, 'ruleset `Tag operations` targets'],
  ['`Hosted tag creation` blocks update too, so the App can move tags', (ctx) => { ruleset(ctx, 'Hosted tag creation').rules.push({ type: 'update' }); }, 'ruleset `Hosted tag creation` blocks exactly'],
  ['the App bypasses `Hosted tag history`', (ctx) => { ruleset(ctx, 'Hosted tag history').bypass_actors.push(APP); }, 'bypasses no ruleset but `Hosted tag creation`'],
  ['the App bypasses `Merge access`', (ctx) => { ruleset(ctx, 'Merge access').bypass_actors.push(APP); }, 'bypasses no ruleset but `Hosted tag creation`'],
  ['`dormouse-bot` promoted to maintain', (ctx) => { Object.assign(body(ctx, 'collaborators/dormouse-bot/permission'), { permission: 'maintain', role_name: 'maintain' }); }, '`dormouse-bot` holds neither'],
  ['`dormouse-bot` role is admin', (ctx) => { body(ctx, 'collaborators/dormouse-bot/permission').role_name = 'admin'; }, '`dormouse-bot` holds neither'],
  ['an unnamed environment appears', (ctx) => addEnvironment(ctx, 'staging'), 'every environment is one the expected state names'],
  ['an unnamed environment admits every branch', (ctx) => addEnvironment(ctx, 'staging', { policy: { deployment_branch_policy: null } }), '`staging` admits only refs'],
  ['an unnamed environment holds a secret', (ctx) => addEnvironment(ctx, 'staging', { secrets: ['STAGING_TOKEN'] }), '`staging` holds exactly'],
  ['`tend` admits every branch', (ctx) => { env(ctx, 'tend').deployment_branch_policy = null; }, '`tend` admits only refs'],
  ['`security-audit` admits protected branches', (ctx) => { env(ctx, 'security-audit').deployment_branch_policy = { protected_branches: true, custom_branch_policies: false }; }, '`security-audit` admits only refs'],
  ['`release-attest` admits a bot-pushable branch', (ctx) => { body(ctx, 'environments/release-attest/deployment-branch-policies').branch_policies.push({ name: 'feature/*', type: 'branch' }); }, '`release-attest` admits only refs'],
  ['`hosted-preview` admits another branch', (ctx) => { body(ctx, 'environments/hosted-preview/deployment-branch-policies').branch_policies.push({ name: 'dev', type: 'branch' }); }, '`hosted-preview` admits exactly'],
  ['`hosted-production` drops its reviewers', (ctx) => { const e = env(ctx, 'hosted-production'); e.protection_rules = e.protection_rules.filter((r) => r.type !== 'required_reviewers'); }, '`hosted-production` requires nonempty reviewers'],
  ['`hosted-production` lets admins bypass', (ctx) => { env(ctx, 'hosted-production').can_admins_bypass = true; }, '`hosted-production` sets `can_admins_bypass: false`'],
  ['`vscode-extension-publish` allows self-review', (ctx) => { env(ctx, 'vscode-extension-publish').protection_rules.find((r) => r.type === 'required_reviewers').prevent_self_review = false; }, '`vscode-extension-publish` sets `prevent_self_review: true`'],
  ['`vscode-extension-publish` lets admins bypass', (ctx) => { env(ctx, 'vscode-extension-publish').can_admins_bypass = true; }, '`vscode-extension-publish` sets `can_admins_bypass: false`'],
  ['`vscode-extension-publish` has an empty reviewer list', (ctx) => { env(ctx, 'vscode-extension-publish').protection_rules.find((r) => r.type === 'required_reviewers').reviewers = []; }, '`vscode-extension-publish` requires nonempty reviewers'],
  ['a publish token moves into `tend`', (ctx) => { body(ctx, 'environments/tend/secrets').secrets.push({ name: 'VSCE_PAT' }); }, '`tend` holds exactly'],
  ['`security-audit` loses `EMBARGO_TOKEN`', (ctx) => { const s = body(ctx, 'environments/security-audit/secrets'); s.secrets = s.secrets.filter((x) => x.name !== 'EMBARGO_TOKEN'); }, '`security-audit` holds exactly'],
  ['`release-attest` gains a variable', (ctx) => { body(ctx, 'environments/release-attest/variables').variables.push({ name: 'TOKEN_URL' }); }, '`release-attest` declares no environment variables'],
  ['`release-attest` gains a secret', (ctx) => { body(ctx, 'environments/release-attest/secrets').secrets.push({ name: 'SIGNING_KEY' }); }, '`release-attest` holds exactly'],
  ['a new repo-level secret', (ctx) => { body(ctx, 'actions/secrets').secrets.push({ name: 'NEW_TOKEN' }); }, 'repo-level secrets are'],
  ['a new repo-level secret outside `secrets.allowed`', (ctx) => { body(ctx, 'actions/secrets').secrets.push({ name: 'NEW_TOKEN' }); }, 'every repo-level secret is in `.config/tend.yaml`'],
  ['`ARGOS_TOKEN` gone from repo level', (ctx) => { const s = body(ctx, 'actions/secrets'); s.secrets = s.secrets.filter((x) => x.name !== 'ARGOS_TOKEN'); }, 'repo-level secrets are'],
  ['`ANTHROPIC_API_KEY` at repo level', (ctx) => { body(ctx, 'actions/secrets').secrets.push({ name: 'ANTHROPIC_API_KEY' }); }, '`ANTHROPIC_API_KEY` is absent at repo and org level'],
  ['`ANTHROPIC_API_KEY` at org level', (ctx) => { body(ctx, 'actions/organization-secrets').secrets.push({ name: 'ANTHROPIC_API_KEY' }); }, '`ANTHROPIC_API_KEY` is absent at repo and org level'],
  ['an org-level secret becomes visible', (ctx) => { body(ctx, 'actions/organization-secrets').secrets.push({ name: 'ORG_TOKEN' }); }, 'no org-level secret is visible'],
  ['a Hosted credential at repo level', (ctx) => { body(ctx, 'actions/secrets').secrets.push({ name: 'DATABASE_URL' }); }, 'no Hosted credential appears at repo or org scope'],
  ['a production credential in preview', (ctx) => { body(ctx, 'environments/hosted-preview/secrets').secrets.push({ name: 'DATABASE_URL' }); }, 'no production-only credential is in `hosted-preview`'],
  ['a repo-level secret missing from `secrets.allowed`', (ctx) => { ctx.tendAllowed = ['ARGOS_TOKEN']; }, 'every repo-level secret is in `.config/tend.yaml`'],
  ['workflow tokens default to write', (ctx) => { body(ctx, 'actions/permissions/workflow').default_workflow_permissions = 'write'; }, '`default_workflow_permissions` is `read`'],
  ['workflows may approve pull requests', (ctx) => { body(ctx, 'actions/permissions/workflow').can_approve_pull_request_reviews = true; }, '`can_approve_pull_request_reviews` is `false`'],
  ['`workflow-audit.yaml` disabled', (ctx) => { body(ctx, 'actions/workflows/workflow-audit.yaml').state = 'disabled_manually'; }, '`workflow-audit.yaml` exists and is enabled'],
  ['`workflow-audit.yaml` deleted', (ctx) => { delete ctx.responses[`${R}/actions/workflows/workflow-audit.yaml`]; }, '`workflow-audit.yaml` exists and is enabled'],
  ['`workflow-audit.yaml` silent for 48 hours', (ctx) => {
    for (const r of liveRuns(ctx)) r.created_at = new Date(NOW.getTime() - 49 * 3_600_000).toISOString();
  }, '`workflow-audit.yaml` has a successful `schedule` run'],
  ['`workflow-audit.yaml` only succeeded on a dispatch', (ctx) => {
    for (const r of liveRuns(ctx)) r.event = 'workflow_dispatch';
  }, '`workflow-audit.yaml` has a successful `schedule` run'],
  ['`security-audit.yaml` disabled', (ctx) => { body(ctx, 'actions/workflows/security-audit.yaml').state = 'disabled_manually'; }, '`security-audit.yaml` exists and is enabled'],
  ['secret scanning off', (ctx) => { ctx.responses[R].body.security_and_analysis.secret_scanning.status = 'disabled'; }, 'secret scanning is enabled'],
  ['push protection off', (ctx) => { ctx.responses[R].body.security_and_analysis.secret_scanning_push_protection.status = 'disabled'; }, 'secret scanning push protection is enabled'],
  ['`security_and_analysis` withheld from a non-admin token', (ctx) => { delete ctx.responses[R].body.security_and_analysis; }, 'secret scanning is enabled'],
  ['Dependabot alerts off', (ctx) => { ctx.responses[`${R}/vulnerability-alerts`] = { status: 404, body: null }; }, 'Dependabot alerts are on'],
  ['private vulnerability reporting off', (ctx) => { body(ctx, 'private-vulnerability-reporting').enabled = false; }, 'private vulnerability reporting is enabled'],
  ['the embargo repository goes public', (ctx) => { ctx.embargo = '200'; }, 'answers 404 unauthenticated'],
];
for (const [name, mutate, clause] of violations) {
  test(`fails: ${name}`, () => {
    const result = replay(mutate);
    assert.equal(result.verdict, 'FAIL');
    const failed = lines(result, 'FAIL');
    assert.ok(failed.some((c) => c.includes(clause)), `no FAIL on "${clause}"; failed: ${failed.join(' | ')}`);
  });
}

// The tagger App is private: no token an audit run holds can read it, so the
// fixture records the 403 CI gets, and nothing about it is a FAIL IF. An org
// admin's login can read its installation; drift there is a WARNING.
test('the tagger App\'s permissions are read only where readable, and never fail', () => {
  const installation = (permissions, events = []) => (ctx) => {
    ctx.responses['orgs/diffplug/installations'] = { status: 200, body: { total_count: 1, installations: [{ app_id: 5228264, app_slug: 'dormouse-hosted-tagger', permissions, events }] } };
  };
  const unreadable = replay();
  assert.ok(!unreadable.text.includes('tagger App\'s installation'));
  const clean = replay(installation({ contents: 'write', metadata: 'read' }));
  assert.equal(clean.verdict, 'PASS');
  assert.deepEqual(clean.warnings, []);
  for (const drift of [installation({ contents: 'write', metadata: 'read', workflows: 'write' }), installation({ contents: 'write', metadata: 'read' }, ['push'])]) {
    const result = replay(drift);
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.warnings.length, 1);
    assert.match(result.text, /^- WARNING: the Hosted tagger App's installation holds/m);
  }
});

test('`CHROMATIC_PROJECT_TOKEN` may be absent from repo level', () => {
  const result = replay((ctx) => { const s = body(ctx, 'actions/secrets'); s.secrets = s.secrets.filter((x) => x.name !== 'CHROMATIC_PROJECT_TOKEN'); });
  assert.equal(result.verdict, 'PASS', lines(result, 'FAIL').join('\n'));
});

test('an extra ruleset or drift from a Today: list is INFO, not a failure', () => {
  const result = replay((ctx) => {
    ctx.responses[`${R}/rulesets?includes_parents=true`].body.push({ id: 1 });
    ctx.responses[`${R}/rulesets/1`] = { status: 200, body: { id: 1, name: 'Signed commits', target: 'branch', enforcement: 'active', conditions: { ref_name: { include: ['~ALL'], exclude: [] } }, rules: [{ type: 'required_signatures' }], bypass_actors: [ADMIN] } };
    const p = body(ctx, 'environments/security-audit/deployment-branch-policies');
    p.branch_policies = p.branch_policies.filter((x) => x.type !== 'tag');
  });
  assert.equal(result.verdict, 'PASS', lines(result, 'FAIL').join('\n'));
  assert.equal(result.info.length, 2, result.info.join('\n'));
});

// A listing that lags behind (seen live, 2026-10-07: the `status=success`
// listing once omitted the two newest runs) must not read as a dead workflow
// while the other listing has them; both lagging, or both failing, still fails.
test('liveness reads the union of its two listings', () => {
  const stale = (path) => (ctx) => {
    const listing = body(ctx, path);
    listing.workflow_runs = listing.workflow_runs.filter((r) => NOW.getTime() - Date.parse(r.created_at) > 48 * 3_600_000);
  };
  for (const path of LISTINGS) assert.equal(replay(stale(path)).verdict, 'PASS', path);
  assert.equal(replay((ctx) => LISTINGS.forEach((p) => stale(p)(ctx))).verdict, 'FAIL');
  const oneDown = replay((ctx) => { ctx.responses[`${R}/${LISTINGS[0]}`] = { status: 502, body: null }; });
  assert.equal(oneDown.verdict, 'PASS');
  const bothDown = replay((ctx) => LISTINGS.forEach((p) => { ctx.responses[`${R}/${p}`] = { status: 502, body: null }; }));
  assert.equal(bothDown.verdict, 'INCONCLUSIVE');
});

test('one skipped workflow-audit run is INFO inside the 48 hours', () => {
  const result = replay((ctx) => {
    for (const r of liveRuns(ctx)) r.created_at = new Date(NOW.getTime() - 30 * 3_600_000).toISOString();
  });
  assert.equal(result.verdict, 'PASS');
  assert.match(result.info.join('\n'), /one scheduled run was skipped or failed/);
});

// A 403 under the CI PAT is scope drift and fails; the same 403 under an
// operator's own login says nothing about the PAT. Any other failed call is
// unverifiable, never a pass.
test('an unreadable endpoint is FAIL in CI, UNVERIFIABLE locally, and never PASS', () => {
  const forbid = (ctx) => { ctx.responses[`${R}/environments`] = { status: 403, body: null }; };
  const ci = replay(forbid);
  assert.equal(ci.verdict, 'FAIL');
  assert.match(ci.results.find((r) => r.clause.includes('every environment')).evidence, /PAT scope drifted/);
  const local = replay(forbid, { local: true });
  assert.equal(local.verdict, 'INCONCLUSIVE');
  assert.equal(lines(local, 'FAIL').length, 0);
  const outage = replay((ctx) => { ctx.responses[`${R}/actions/organization-secrets`] = { status: 502, body: null }; });
  assert.equal(outage.verdict, 'INCONCLUSIVE');
  assert.ok(lines(outage, 'UNVERIFIABLE').includes('no org-level secret is visible to this repository'));
});

test('the state hash ignores listing order and run history, and tracks every judged value', () => {
  const base = replay().hash;
  const reordered = replay((ctx) => {
    body(ctx, 'environments').environments.reverse();
    body(ctx, 'actions/secrets').secrets.reverse();
    ctx.responses[`${R}/rulesets?includes_parents=true`].body.reverse();
    for (const r of liveRuns(ctx)) r.created_at = NOW.toISOString();
  });
  assert.equal(reordered.hash, base);
  for (const [name, mutate, clause] of violations) {
    // Run history and `.config/tend.yaml` are not GitHub state: the first is
    // volatile by design, the second changes with the audited commit.
    if (clause.includes('has a successful `schedule` run') || name.includes('`secrets.allowed`') && !name.includes('new repo-level')) continue;
    assert.notEqual(replay(mutate).hash, base, `hash blind to: ${name}`);
  }
  assert.notEqual(replay((ctx) => { ctx.responses['repos/max-sixty/tend/git/ref/tags/0.3.10'].body.object.sha = '0'.repeat(40); }).hash, base, 'hash blind to a moved tend tag');
  assert.equal(stateHash({ a: 1, volatile: { x: 1 } }), stateHash({ volatile: { x: 2 }, a: 1 }));
});

// The CLI over `gh` itself: pagination merged across pages, a 204 read as
// enabled, an error's status taken from gh's stderr, and the fragment and
// `GITHUB_OUTPUT` written. The stub serves the fixture, splitting every list
// across two pages.
test('the CLI reads gh, writes the fragment, and hands the hash on', (t) => {
  const dir = tempDir(t, 'github-state-');
  mkdirSync(join(dir, 'bin'));
  const fixturePath = join(dir, 'fixture.json');
  writeFileSync(fixturePath, JSON.stringify(fixture));
  writeFileSync(join(dir, 'bin', 'gh'), `#!${process.execPath}
const fixture = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(fixturePath)}, 'utf8'));
const args = process.argv.slice(2);
const path = args.at(-1);
const r = fixture.responses[path];
if (!r || r.status >= 400) { process.stderr.write('gh: Not Found (HTTP ' + (r?.status ?? 404) + ')\\n'); process.exit(1); }
if (r.status === 204) process.exit(0);
let body = r.body;
if (path.includes('/runs?')) body = { ...body, workflow_runs: body.workflow_runs.map((run) => ({ ...run, created_at: new Date(Date.now() - 3600e3).toISOString() })) };
if (!args.includes('--slurp')) { process.stdout.write(JSON.stringify(body)); process.exit(0); }
const split = (list) => [list.slice(0, 1), list.slice(1)];
if (Array.isArray(body)) process.stdout.write(JSON.stringify(split(body)));
else {
  const key = Object.keys(body).find((k) => Array.isArray(body[k]));
  const [a, b] = key ? split(body[key]) : [[], []];
  process.stdout.write(JSON.stringify(key ? [{ ...body, [key]: a }, { ...body, [key]: b }] : [body]));
}
`, { mode: 0o755 });
  writeFileSync(join(dir, 'bin', 'curl'), `#!/bin/sh\nprintf '${fixture.embargoStatus}'\n`, { mode: 0o755 });
  const output = join(dir, 'github-output');
  writeFileSync(output, '');
  const cli = spawnSync(process.execPath, [join(repoRoot, 'scripts/github-state-check.mjs'), '--out', join(dir, FRAGMENT)], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GITHUB_OUTPUT: output },
  });
  assert.equal(cli.status, 0, cli.stderr);
  const written = readFileSync(join(dir, FRAGMENT), 'utf8');
  assert.equal(written.split('\n')[0], 'VERDICT: PASS', written);
  const { hash } = replay();
  assert.equal(readFileSync(output, 'utf8'), `hash=${hash}\nverdict=PASS\n`);
});
