import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import { BODY_LIMIT } from './clamp-issue-body.mjs';
import { OPEN_FINDINGS, SENTINEL, domains, failKey, fragmentManifest, ledgerKey, manifestLines, ledgerMeta, owedIds as owedRuleIds, ruleIndex } from './security-audit-report.mjs';
import { disclosureReason, parseLedger, planDisclosures, statusBody } from './security-audit-public-body.mjs';
import { FRAGMENT } from './github-state-check.mjs';
import { decide } from './security-audit-plan.mjs';
import { repoRoot, tempDir, workflowRunBlock } from './lint-kit.mjs';

const repo = repoRoot;
const workflow = readFileSync(join(repo, '.github/workflows/security-audit.yaml'), 'utf8');
const allFragments = workflow.match(/^\s+AUDIT_FRAGMENTS: (.+)$/m)[1].split(/\s+/);
// The deterministic GitHub-state check's fragment rides the same list; the
// rest are the domains the orchestrator waits for and merges.
const STATE_FRAGMENT = FRAGMENT;
const fragments = allFragments.filter((f) => f !== STATE_FRAGMENT);

// Execute the shipped block, so changes to its parser or guards reach these tests.
const runBlock = (name) => workflowRunBlock(workflow, name);

/** One step's whole text, from its `- name:` line to the next step. */
function stepText(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `missing workflow step: ${name}`);
  // The next step, or the next job's first line.
  const end = workflow.slice(start + 1).search(/\n(?:      - |  \S)/);
  return workflow.slice(start, end < 0 ? undefined : start + 1 + end);
}

// Every sink the encrypted archive takes, as its loop names them. The
// redaction tests below write a secret into each, and the encryption test
// checks the archive holds them, so a sink added to one list and not the
// other fails one of the two.
const archivedSinks = runBlock('Encrypt the audit transcript')
  .match(/^for f in (.+); do$/m)[1]
  .replace('"$RUNNER_TEMP/claude-execution-output.json"', 'claude-execution-output.json')
  .replace('$AUDIT_FRAGMENTS', allFragments.join(' '))
  .split(/\s+/);

const EMBARGO_REPO = stepText('File embargoed findings').match(/^          EMBARGO_REPO: (.+)$/m)[1];
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

// `SENTINEL` is the reader's own literal; the producer copy in
// `.github/audit/_preamble.md` is pinned against it below.

/** Every rule a fragment's domain owes, as the result-line ID the preamble fixes, from the real specs. */
const owedIds = (fragment) => owedRuleIds(fragmentManifest(repo, fragment));
/** The IDs a fragment owes under one spec and heading, in source order. */
const sectionIds = (fragment, spec, heading) => fragmentManifest(repo, fragment).get(`${spec}\0${heading}`) ?? [];
/** Where a rule lives in the real specs. */
const ruleOf = (id) => ruleIndex(repo).get(id);

/**
 * A fragment written to the grammar. Every owed rule passes unless `results`
 * overrides it by ID; `drop` omits rules by ID; `lines` are appended
 * verbatim. `stated` is the domain's own verdict line.
 */
function fragmentText(fragment, { stated = 'PASS', results = {}, drop = [], lines = [], qualitative = fragment === STATE_FRAGMENT ? 0 : 1, sentinel = true, trailingBlank = false } = {}) {
  const out = [`VERDICT: ${stated}`, ''];
  for (const id of owedIds(fragment)) {
    if (drop.includes(id)) continue;
    out.push(results[id] ?? `- PASS: ${id} — the clause: evidence`);
  }
  out.push(...lines);
  for (let i = 0; i < qualitative; i++) out.push('- QUALITATIVE: done — the whole scope');
  if (sentinel) out.push('', SENTINEL, ...(trailingBlank ? [''] : []));
  return `${out.join('\n')}\n`;
}

/** The first rule a fragment owes, for overriding. */
const firstId = (fragment) => owedIds(fragment)[0];

/** A rule ID's ledger key, as the reporting step mints it for a failure on that rule. */
const failKeyOf = (id) => failKey(id);

/** A BLOCKER or WARNING with all three evidence fields. */
const finding = (severity, location, cause, summary) => [
  `- ${severity}: \`${location}\` \`${cause}\` — ${summary}`,
  '  - Code: `Invoke-Expression "& $name"`',
  '  - Path: a file name → `Invoke-Expression`',
  '  - Reproduction: a file named `x;calc` → calc runs',
];

function fixture(t) {
  const dir = tempDir(t, 'dormouse-audit-');
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'docs/specs'), { recursive: true });
  mkdirSync(join(dir, '.github/audit'), { recursive: true });
  for (const script of ['clamp-issue-body.mjs', 'security-audit-public-body.mjs', 'security-audit-report.mjs', 'spec-md.mjs']) {
    copyFileSync(join(repo, 'scripts', script), join(dir, 'scripts', script));
  }
  // The manifest is derived from these specs and the domain prompts' scopes,
  // and the public builder names a failed check only by a heading they carry.
  for (const spec of readdirSync(join(repo, 'docs/specs')).filter((f) => /^security[a-z-]*\.md$/.test(f))) {
    copyFileSync(join(repo, 'docs/specs', spec), join(dir, 'docs/specs', spec));
  }
  for (const f of readdirSync(join(repo, '.github/audit'), { withFileTypes: true }).filter((e) => e.isFile())) {
    copyFileSync(join(repo, '.github/audit', f.name), join(dir, '.github/audit', f.name));
  }
  // The deterministic check passed unless a case says otherwise.
  writeFileSync(join(dir, STATE_FRAGMENT), fragmentText(STATE_FRAGMENT));
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, RUNNER_TEMP: dir,
    AUDIT_FRAGMENTS: allFragments.join(' '), GITHUB_REPOSITORY: 'fixture/repo', GITHUB_RUN_ID: '123',
    GITHUB_SHA: COMMIT, GH_TOKEN: 'fixture-workflow-token',
    AUDIT_PAT: 'fixture-admin-token', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth-token' };
  return { dir, env };
}

function stub(dir, name, source) {
  writeFileSync(join(dir, 'bin', name), `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
}

/**
 * A `gh` over a fake GitHub kept in `gh-state.json`: the public repository's
 * issues, the embargo repository's, and the merged PRs `api` answers for. It
 * records each call with the token it was handed and the body it posted, and
 * runs every `--jq` filter through the system `jq`, so the shipped filters are
 * the ones tested. Unless a test seeds the state, the embargo repository holds
 * the open rows of `GH_LEDGER_OPEN` (`<number> <title>`) and the public one
 * nothing. Every embargo call fails when `GH_FAIL_EMBARGO` is set.
 */
function stubGh(dir, seed) {
  if (seed) writeFileSync(join(dir, 'gh-state.json'), JSON.stringify({ public: [], embargo: [], pulls: {}, ...seed }));
  stub(dir, 'gh', `
    const fs = require('node:fs');
    const { execFileSync } = require('node:child_process');
    const args = process.argv.slice(2);
    const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
    const body = opt('--body-file') !== null ? fs.readFileSync(opt('--body-file'), 'utf8') : opt('--body');
    const embargo = args.includes(${JSON.stringify(EMBARGO_REPO)}) || (args[2] ?? '').includes(${JSON.stringify(EMBARGO_REPO)});
    fs.appendFileSync('gh-calls.jsonl', JSON.stringify({ args, token: process.env.GH_TOKEN, body, embargo }) + '\\n');
    if (embargo && process.env.GH_FAIL_EMBARGO) process.exit(1);
    const now = new Date().toISOString().replace(/\\.\\d+Z$/, 'Z');
    const state = fs.existsSync('gh-state.json') ? JSON.parse(fs.readFileSync('gh-state.json', 'utf8')) : {
      public: [], pulls: {},
      embargo: (process.env.GH_LEDGER_OPEN ?? '').split('\\n').filter(Boolean).map((row) => ({
        number: Number(row.slice(0, row.indexOf(' '))), title: row.slice(row.indexOf(' ') + 1), body: '', labels: [],
        state: 'OPEN', stateReason: '', createdAt: ${JSON.stringify(SEEDED_AT)}, closedAt: null, comments: [] })),
    };
    const save = () => fs.writeFileSync('gh-state.json', JSON.stringify(state));
    const repo = embargo ? ${JSON.stringify(EMBARGO_REPO)} : 'fixture/repo';
    const issues = state[embargo ? 'embargo' : 'public'];
    const target = () => issues.find((i) => i.number === Number(String(args[2]).match(/(\\d+)$/)[1]));
    const comment = (issue, text) => issue.comments.push({ author: { login: 'fixture-token-owner' }, authorAssociation: 'MEMBER', body: text });
    const [command, sub] = args;
    if (command === 'issue' && sub === 'list') {
      const want = { open: 'OPEN', closed: 'CLOSED' }[opt('--state') ?? 'open'];
      const label = opt('--label');
      const fields = opt('--json').split(',');
      const listed = issues.filter((i) => (!want || i.state === want) && (!label || i.labels.includes(label)))
        .map((i) => Object.fromEntries(fields.map((f) => [f, i[f]])));
      const jq = opt('--jq');
      process.stdout.write(jq === null ? JSON.stringify(listed) : execFileSync('jq', ['-r', jq], { input: JSON.stringify(listed), encoding: 'utf8' }));
    } else if (command === 'issue' && sub === 'create') {
      const number = Math.max(embargo ? 0 : 1000, ...issues.map((i) => i.number)) + 1;
      issues.push({ number, title: opt('--title'), body, labels: opt('--label') ? [opt('--label')] : [], state: 'OPEN', stateReason: '', createdAt: now, closedAt: null, comments: [] });
      save();
      process.stdout.write('https://github.com/' + repo + '/issues/' + number + '\\n');
    } else if (command === 'issue' && sub === 'comment') {
      comment(target(), body);
      save();
    } else if (command === 'issue' && sub === 'edit') {
      const issue = target();
      if (opt('--title') !== null) issue.title = opt('--title');
      if (body !== null) issue.body = body;
      save();
    } else if (command === 'issue' && sub === 'close') {
      const issue = target();
      Object.assign(issue, { state: 'CLOSED', stateReason: opt('--reason') === 'not planned' ? 'NOT_PLANNED' : 'COMPLETED', closedAt: now });
      if (opt('--comment') !== null) comment(issue, opt('--comment'));
      save();
    } else if (command === 'api') {
      const pr = args[1].match(/^repos\\/([^/]+\\/[^/]+)\\/pulls\\/(\\d+)$/);
      if (pr) {
        const merged = (state.pulls ?? {})[pr[2]];
        if (!merged) process.exit(1);
        process.stdout.write(JSON.stringify({ number: Number(pr[2]), merged_at: merged.merged ? '2026-10-02T00:00:00Z' : null, base: { repo: { full_name: merged.repo ?? pr[1] } } }));
      }
    }
  `);
}

const ghCalls = (dir) => (existsSync(join(dir, 'gh-calls.jsonl'))
  ? readFileSync(join(dir, 'gh-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  : []);

const DAY = 86_400_000;
// The fake GitHub files seeded ledger rows yesterday, at one instant fixed when
// this file loads, so a run that crosses UTC midnight still prints the row
// `SEEDED_ROW` expects.
const SEEDED_MS = Date.now() - DAY;
const SEEDED_AT = new Date(SEEDED_MS).toISOString().replace(/\.\d+Z$/, 'Z');
/** A day as the status issue prints it. */
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const SEEDED_ROW = `${day(SEEDED_MS)} | ${day(SEEDED_MS + 7 * DAY)} |`;

/** The fake GitHub as the run left it. */
const ghState = (dir) => JSON.parse(readFileSync(join(dir, 'gh-state.json'), 'utf8'));
/** The public issues a label marks. */
const publicIssues = (dir, label) => (existsSync(join(dir, 'gh-state.json')) ? ghState(dir).public.filter((i) => i.labels.includes(label)) : []);
/** The status issue's body as the run left it. */
function statusIssueBody(dir) {
  const [status, ...more] = publicIssues(dir, 'security-audit-status');
  assert.ok(status && more.length === 0, 'expected exactly one status issue');
  return status.body;
}

/** `NAME: ${{ steps.<id>.outputs.<key> }}` entries of a step's `env:`, so the plumbing between steps is the shipped one. */
const outputEnv = (name) => [...stepText(name).matchAll(/^          (\w+): \$\{\{ steps\.(\w+)\.outputs\.(\w+) \}\}$/gm)]
  .map(([, variable, step, key]) => ({ variable, step, key }));

/**
 * Run the open-findings list and the four reporting steps as the runner
 * would: the list (before the agent, whose fragments are already written),
 * compose, the embargo filing, the ledger read, then the public step, each
 * handed the outputs its `env:` names. `plan` stands in for the plan step's
 * outputs.
 */
function runReporting(dir, env, { embargoToken = 'fixture-embargo-token', listToken = embargoToken, readToken = embargoToken, embargoEnv = {}, plan = {} } = {}) {
  const outputs = { plan };
  const run = (id, name, extra) => {
    const file = join(dir, `github-output-${id}`);
    writeFileSync(file, '');
    const resolved = Object.fromEntries(outputEnv(name).map(({ variable, step, key }) => [variable, outputs[step]?.[key] ?? '']));
    const result = spawnSync('bash', ['-c', runBlock(name)], { cwd: dir, encoding: 'utf8',
      env: { ...env, GITHUB_OUTPUT: file, ...resolved, ...extra } });
    outputs[id] = Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    return result;
  };
  // Every run reads the ledger, a PASS included.
  for (const name of ['File embargoed findings', 'Read the findings ledger']) assert.match(stepText(name), /^        if: always\(\)$/m);
  const listed = run('findings', 'List open findings', { GH_TOKEN: listToken, EMBARGO_REPO, ...embargoEnv });
  const composed = run('compose', 'Compose the audit report', {});
  assert.equal(composed.status, 0, composed.stderr);
  const embargoed = run('embargo', 'File embargoed findings', { GH_TOKEN: embargoToken, EMBARGO_REPO, ...embargoEnv });
  const read = run('ledger', 'Read the findings ledger', { GH_TOKEN: readToken, EMBARGO_REPO, ...embargoEnv });
  const published = run('publish', 'Publish the audit status', embargoEnv);
  return { listed, composed, embargoed, read, published, outputs };
}

/** The embargo calls that file the per-run report: not the ledger's list, issues, or comments. */
const reportCalls = (calls) => calls.filter(({ embargo, args }) => embargo && (args[1] === 'create'
  ? !args[args.indexOf('--title') + 1].startsWith('[audit-finding ')
  : args[1] === 'comment' && args[2].startsWith('https://')));

const privateParts = (dir) => readdirSync(dir).filter((f) => /^audit-private-part-\d+\.md$/.test(f)).sort()
  .map((f) => readFileSync(join(dir, f), 'utf8'));

// Each scenario writes `frags[i]` (options for `fragmentText`, null for none,
// or a string written raw) and the orchestrator's `status`.
const [SUPPLY, CI, REMOTE, LOCAL, HOSTED] = fragments;
const ORIGIN_BOUNDARY = sectionIds(HOSTED, 'docs/specs/security-hosted.md', 'Origin boundary');
const allPass = () => fragments.map(() => ({}));
/** Every fragment passes but those named: `{ [fragment]: options }`. */
const only = (byFragment) => fragments.map((f) => (f in byFragment ? byFragment[f] : {}));
const cases = [
  { name: 'all checks pass', status: 'PASS\n', frags: allPass(), expected: 'PASS' },
  { name: 'missing merged verdict', frags: allPass(), expected: 'INCONCLUSIVE', publicRows: ['The orchestrator wrote no verdict.'] },
  { name: 'embedded whitespace is not PASS', status: 'P A\nSS\n', frags: allPass(), expected: 'INCONCLUSIVE' },
  { name: 'PASS prefix with a suffix is unreadable', status: 'PASS', frags: only({ [SUPPLY]: { stated: 'PASS but unfinished' } }), expected: 'INCONCLUSIVE',
    notes: ["A domain's verdict could not be read"] },
  { name: 'missing fragment', status: 'PASS', frags: only({ [SUPPLY]: null }), expected: 'INCONCLUSIVE', notes: ['left no report'] },
  // Only the exact line is a verdict: `VERDICT: FAIL` with anything after it is
  // unreadable, and may be a mangled claim, so the headline says to look.
  { name: 'a VERDICT: FAIL with a suffix is unreadable', status: 'PASS', frags: only({ [CI]: { stated: 'FAIL — credential leaked' } }), expected: 'INCONCLUSIVE',
    notes: ["A domain's verdict could not be read", 'A domain claimed more than its result lines record'] },
  { name: 'unverifiable checks override merged PASS', status: 'PASS',
    frags: only({ [SUPPLY]: { stated: 'INCONCLUSIVE', results: { [firstId(SUPPLY)]: `- UNVERIFIABLE: ${firstId(SUPPLY)} — the clause: network error` } } }),
    expected: 'INCONCLUSIVE', notes: [`- \`${SUPPLY}\`, \`docs/specs/security-supply-chain.md\` -> "Disclosure": - UNVERIFIABLE: ${firstId(SUPPLY)} — the clause`] },
  { name: 'dissent overrides missing merged verdict',
    frags: only({ [SUPPLY]: { stated: 'FAIL', results: { [firstId(SUPPLY)]: `- FAIL: ${firstId(SUPPLY)} — the clause: violated` } } }), expected: 'FAIL' },
  { name: 'FAIL with explanation overrides merged PASS', status: 'PASS',
    frags: only({ [SUPPLY]: { stated: 'FAIL — credential leaked', results: { [firstId(SUPPLY)]: `- FAIL: ${firstId(SUPPLY)} — the clause: violated` } } }), expected: 'FAIL',
    notes: ["A domain's lines record a failure"] },
  // 2026-10-07: a fragment opened `VERDICT: PASS` over its own `UNVERIFIABLE`
  // line, and the line was believed. The computed verdict decides, and the
  // disagreement is reported.
  { name: 'a computed INCONCLUSIVE overrides a contradicting VERDICT: PASS', status: 'PASS',
    frags: only({ [HOSTED]: { results: { [firstId(HOSTED)]: `- UNVERIFIABLE: ${firstId(HOSTED)}.b — the clause: not reached` } } }),
    expected: 'INCONCLUSIVE', notes: ['### Anomalies', `\`${HOSTED}\`: its first line says \`VERDICT: PASS\`, its lines compute INCONCLUSIVE`, '`audit-status.txt` says `PASS`'],
    publicRows: [`| \`${HOSTED}\` | INCONCLUSIVE |`, "1 domain's own verdict line disagreed"] },
  { name: 'a computed FAIL overrides a contradicting VERDICT: PASS', status: 'PASS',
    frags: only({ [CI]: { results: { [firstId(CI)]: `- FAIL: ${firstId(CI)} — the clause: violated` } } }),
    expected: 'FAIL', notes: [`\`${CI}\`: its first line says \`VERDICT: PASS\`, its lines compute FAIL`], publicRows: [`| \`${CI}\` | FAIL | 1 |`] },
  // Taken at its word, a `FAIL` line with no failing result under it would file
  // a security finding nobody can find; overruled, it would pass a domain that
  // doubted itself. It is held at INCONCLUSIVE and reported.
  { name: 'a VERDICT: FAIL with no failing line is not believed either way', status: 'FAIL',
    frags: only({ [LOCAL]: { stated: 'FAIL' } }), expected: 'INCONCLUSIVE',
    notes: [`\`${LOCAL}\`: its first line says \`VERDICT: FAIL\`, its lines compute PASS`, '`audit-status.txt` says `FAIL`, the domains\' lines compute INCONCLUSIVE', 'A domain claimed more than its result lines record'] },
  // `audit-status.txt` is a conclusion like any other: a FAIL over
  // passing domains is an anomaly, not a finding.
  { name: 'an orchestrator FAIL over passing domains is not believed', status: 'FAIL', frags: allPass(), expected: 'INCONCLUSIVE',
    notes: ['`audit-status.txt` says `FAIL`, the domains\' lines compute PASS'] },
  // A domain more cautious than its lines claimed less, not more: no hint of
  // a hidden finding in the headline.
  { name: 'a cautious VERDICT: INCONCLUSIVE over passing lines is not a claimed finding', status: 'PASS',
    frags: only({ [LOCAL]: { stated: 'INCONCLUSIVE' } }), expected: 'INCONCLUSIVE', notes: ['This is not a security finding'] },
  // Whole sections were skipped silently: every rule the specs carry is owed a line.
  { name: 'a skipped section is INCONCLUSIVE', status: 'PASS',
    frags: only({ [HOSTED]: { drop: ORIGIN_BOUNDARY } }), expected: 'INCONCLUSIVE',
    notes: ['### Rules with no result line', `- \`${HOSTED}\`: ${ORIGIN_BOUNDARY.at(-1)}, \`docs/specs/security-hosted.md\` -> "Origin boundary"`],
    publicRows: [`| \`${HOSTED}\` | INCONCLUSIVE | 0 | ${ORIGIN_BOUNDARY.length} | 0 |`] },
  // #797: a `FAIL —` line the lift expected as `FAIL:` was lost. Off the
  // grammar, a line is malformed, and a malformed line cannot pass.
  { name: 'a malformed result line is INCONCLUSIVE', status: 'PASS',
    frags: only({ [SUPPLY]: { lines: [`- FAIL — ${firstId(SUPPLY)}: violated`] } }), expected: 'INCONCLUSIVE',
    notes: ['### Malformed lines', `- FAIL — ${firstId(SUPPLY)}`], publicRows: [`| \`${SUPPLY}\` | INCONCLUSIVE | 0 | 0 | 1 |`] },
  // The grammar's ID is bare: the code span a spec writes it in, or the old
  // positional citation, is off the grammar.
  ...[`- PASS: \`${firstId(SUPPLY)}\` — the clause: ok`, '- PASS: `docs/specs/security-supply-chain.md` -> "Disclosure" #1 — the clause: ok'].map((line) => ({
    name: `a result line naming its rule another way is malformed: ${line}`, status: 'PASS',
    frags: only({ [SUPPLY]: { lines: [line] } }), expected: 'INCONCLUSIVE', notes: ['### Malformed lines', line] })),
  { name: 'a bold result line is malformed', status: 'PASS',
    frags: only({ [SUPPLY]: { lines: ['- **FAIL IF** something holds: PASS.'] } }), expected: 'INCONCLUSIVE', notes: ['### Malformed lines'] },
  // Only an INFO is let off the grammar (below): a BLOCKER or WARNING written
  // off it may be a failure the lines no longer carry, and so may a line that
  // cannot be told for an INFO by its exact prefix.
  ...[
    '- BLOCKER: pnpm-lock.yaml:1340 — a tarball from outside the registry',
    '- WARNING: pnpm-lock.yaml:1340 — a tarball from outside the registry',
    '- **INFO**: pnpm-lock.yaml:1340 — a tarball from outside the registry',
    'INFO: pnpm-lock.yaml:1340 — a tarball from outside the registry',
    '- INFO: BLOCKER — a tarball from outside the registry',
  ].map((line) => ({ name: `a line off the grammar is INCONCLUSIVE: ${line}`, status: 'PASS',
    frags: only({ [SUPPLY]: { lines: [line] } }), expected: 'INCONCLUSIVE', notes: ['### Malformed lines', line] })),
  { name: 'a skipped clause is INCONCLUSIVE', status: 'PASS',
    frags: only({ [SUPPLY]: { results: { [firstId(SUPPLY)]: `- PASS: ${firstId(SUPPLY)}.a — one: ok\n- PASS: ${firstId(SUPPLY)}.c — three: ok` } } }),
    expected: 'INCONCLUSIVE', notes: [`- \`${SUPPLY}\`: ${firstId(SUPPLY)}.b`] },
  { name: 'a result naming a rule nobody owes is INCONCLUSIVE', status: 'PASS',
    frags: only({ [SUPPLY]: { lines: [`- PASS: ${firstId(CI)} — the clause: ok`] } }), expected: 'INCONCLUSIVE',
    notes: ['names no rule this domain owes'] },
  { name: 'no qualitative pass is INCONCLUSIVE', status: 'PASS', frags: only({ [LOCAL]: { qualitative: 0 } }), expected: 'INCONCLUSIVE',
    notes: ['it recorded no finished qualitative pass'] },
  { name: 'a BLOCKER fails the run', status: 'PASS',
    frags: only({ [REMOTE]: { stated: 'FAIL', lines: finding('BLOCKER', 'deploy/local/install-windows.ps1:88', 'Install-Service', 'a file name reaches Invoke-Expression') } }),
    expected: 'FAIL', publicRows: [`| \`${REMOTE}\` | FAIL | 0 | 0 | 0 | 1 | 0 |`] },
  { name: 'a BLOCKER without its evidence still fails, and is malformed', status: 'PASS',
    frags: only({ [LOCAL]: { stated: 'FAIL', lines: ['- BLOCKER: `lib/x.ts:4` `run` — something'] } }),
    expected: 'FAIL', notes: ['BLOCKER without its Code, Path, Reproduction evidence'] },
  // A domain cut off between rewriting its verdict line and writing its
  // sentinel reads as a clean PASS on line 1.
  { name: 'PASS without a sentinel is a cut-off domain', status: 'PASS', frags: only({ [LOCAL]: { sentinel: false } }), expected: 'INCONCLUSIVE', notes: ['cut off mid-report'],
    publicRows: [`| \`${LOCAL}\` | INCONCLUSIVE, cut off |`] },
  { name: 'a cut-off FAIL is still a finding', status: 'PASS',
    frags: only({ [LOCAL]: { stated: 'FAIL', sentinel: false, results: { [firstId(LOCAL)]: `- FAIL: ${firstId(LOCAL)} — the clause: violated` } } }),
    expected: 'FAIL', notes: ["A domain's lines record a failure", 'cut off mid-report'] },
  { name: 'a trailing blank line still ends a report', status: 'PASS', frags: fragments.map(() => ({ trailingBlank: true })), expected: 'PASS' },
  { name: 'FAIL records every incomplete condition', status: 'FAIL',
    frags: only({ [SUPPLY]: null, [CI]: 'garbled\n', [LOCAL]: { stated: 'INCONCLUSIVE', results: { [firstId(LOCAL)]: `- UNVERIFIABLE: ${firstId(LOCAL)} — c: e` } }, [HOSTED]: { stated: 'FAIL', results: { [firstId(HOSTED)]: `- FAIL: ${firstId(HOSTED)} — c: e` } } }),
    expected: 'FAIL', notes: ['left no report', 'could not be read', 'could not determine every check', 'record a failure'],
    publicRows: [`| \`${SUPPLY}\` | no report |`, `| \`${CI}\` | INCONCLUSIVE, cut off |`, `| \`${LOCAL}\` | INCONCLUSIVE |`, `| \`${HOSTED}\` | FAIL |`] },
];
for (const scenario of cases) {
  test(`reporting: ${scenario.name}`, (t) => {
    const { dir, env } = fixture(t);
    stubGh(dir);
    if (scenario.status !== undefined) writeFileSync(join(dir, 'audit-status.txt'), scenario.status);
    writeFileSync(join(dir, 'audit-report.md'), '# Fixture report\n');
    const written = [];
    scenario.frags.forEach((options, i) => {
      if (options === null) return;
      const text = typeof options === 'string' ? options : fragmentText(fragments[i], options);
      written.push(text);
      writeFileSync(join(dir, fragments[i]), text);
    });
    const { published, outputs } = runReporting(dir, env);
    assert.equal(outputs.compose.status, scenario.expected === 'INCONCLUSIVE' ? 'MISSING' : scenario.expected);
    assert.equal(published.status, scenario.expected === 'PASS' ? 0 : 1, published.stderr);
    const calls = ghCalls(dir);
    // Nothing ever closes a ledger issue.
    assert.ok(!calls.some(({ args, embargo }) => embargo && args[1] === 'close'));
    // Every run, whatever its outcome, writes the one status issue and nothing
    // else in public: no comment with no earlier outcome to change from.
    const publicBody = statusIssueBody(dir);
    const publicWrites = calls.filter(({ embargo, args }) => !embargo && args[0] === 'issue' && args[1] !== 'list');
    assert.deepEqual(publicWrites.map(({ args }) => args[1]), ['create']);
    assert.ok(publicWrites.every(({ token }) => token === 'fixture-workflow-token'));
    assert.match(publicBody, { PASS: /^\*\*PASS\*\* — no check failed, and no finding is open\.$/m, FAIL: /^\*\*FAIL\*\* — the audit failed\.$/m, INCONCLUSIVE: /^\*\*INCONCLUSIVE\*\* — the audit reached no usable verdict\.$/m }[scenario.expected]);
    assert.ok(publicBody.startsWith(`<!-- security-audit-status outcome=${scenario.expected} -->`), publicBody);
    if (scenario.expected === 'PASS') {
      // A clean pass files nothing in the private tracker.
      assert.ok(!calls.some(({ embargo, args }) => embargo && args[0] === 'issue' && (args[1] === 'create' || args[1] === 'comment')));
      return;
    }
    const body = readFileSync(join(dir, 'audit-private.md'), 'utf8');
    assert.match(body, scenario.expected === 'FAIL' ? /^Audit failed/ : /^Audit reached no usable verdict/);
    for (const note of scenario.notes ?? []) assert.ok(body.includes(note), `missing note: ${note}\n${body}`);
    // The private issue received every part, in order, under the embargo token.
    const parts = privateParts(dir);
    const filed = reportCalls(calls);
    assert.deepEqual(filed.map(({ body: posted }) => posted), parts);
    assert.ok(filed.every(({ token }) => token === 'fixture-embargo-token'));
    // The status issue carries none of what a domain wrote beyond its verdict.
    assert.ok(!publicBody.includes('Fixture report'));
    for (const text of written) {
      for (const line of text.split('\n').filter((l) => l.length > 6 && !/^VERDICT: (PASS|INCONCLUSIVE|FAIL)$/.test(l) && l !== SENTINEL)) {
        assert.ok(!publicBody.includes(line), `the public body carries fragment text: ${line}`);
      }
    }
    for (const row of scenario.publicRows ?? []) assert.ok(publicBody.includes(row), `missing public row: ${row}\n${publicBody}`);
  });
}

// Run 37720578105 went INCONCLUSIVE, holding the release gate, on one INFO
// written without its backticked location and root cause. An INFO cannot fail
// the run, so off the grammar it is reported as written and leaves the verdict
// alone; and no INFO, in the grammar or not, reaches the ledger.
test('an INFO off the grammar is an anomaly that leaves a PASS and files nothing', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'PASS');
  const loose = '- INFO: pnpm-lock.yaml:1340 — only non-registry resolution is the pinned tarball';
  fragments.forEach((f) => writeFileSync(join(dir, f), fragmentText(f, f === SUPPLY ? { lines: [loose, '- INFO: `docs/x.md:1` `drift` — in the grammar'] } : {})));
  const { published, outputs } = runReporting(dir, env);
  assert.equal(outputs.compose.status, 'PASS');
  assert.equal(published.status, 0, published.stderr);
  const body = readFileSync(join(dir, 'audit-private.md'), 'utf8');
  assert.ok(body.includes(`- \`${SUPPLY}\`: an \`INFO\` line off the grammar, which changes no verdict: ${loose}\n`), body);
  assert.equal(readFileSync(join(dir, 'audit-ledger/index.tsv'), 'utf8'), '');
  assert.ok(!ghCalls(dir).some(({ embargo, args }) => embargo && args[1] !== 'list'), JSON.stringify(ghCalls(dir)));
  assert.ok(!statusIssueBody(dir).includes('pinned tarball'));
});

// The private issue carries what did not pass; the PASS ledger stays in the
// encrypted artifact, so a clean domain's hundred lines do not bury the one
// that failed.
test('the private report carries no PASS line', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'FAIL');
  fragments.forEach((f, i) => writeFileSync(join(dir, f), fragmentText(f, i ? {} : { stated: 'FAIL', results: { [firstId(f)]: `- FAIL: ${firstId(f)} — c: violated` } })));
  runReporting(dir, env);
  const body = readFileSync(join(dir, 'audit-private.md'), 'utf8');
  assert.ok(!body.includes('- PASS:'), body);
  assert.ok(body.includes(`- FAIL: ${firstId(SUPPLY)} — c: violated`), body);
});

// One PowerShell issue was reported three times on #1027. Findings naming the
// same file and root cause within five lines are one finding: one entry in
// the private report, one in the ledger, at the worst severity reported.
test('duplicate findings merge in the private report and the ledger', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'PASS');
  fragments.forEach((f, i) => writeFileSync(join(dir, f), fragmentText(f, {
    lines: i === 2 ? [...finding('WARNING', 'deploy/local/install-windows.ps1:88', 'Install-Service', 'first'),
      ...finding('WARNING', './deploy/local/install-windows.ps1:91', 'install-service()', 'second')]
      : i === 1 ? finding('WARNING', 'deploy/local/install-windows.ps1:86', 'Install-Service', 'third')
        : i === 3 ? finding('WARNING', 'deploy/local/install-windows.ps1:140', 'Install-Service', 'far away') : [],
  })));
  const { outputs, published } = runReporting(dir, env);
  assert.equal(outputs.compose.status, 'PASS');
  assert.equal(published.status, 0, published.stderr);
  const body = readFileSync(join(dir, 'audit-private.md'), 'utf8');
  assert.ok(body.includes('_4 reported, 2 after merging duplicates'), body);
  const created = ghCalls(dir).filter(({ embargo, args }) => embargo && args[1] === 'create');
  // Two in-run findings, one ledger key: the far one shares the file and root cause.
  assert.equal(created.length, 1, JSON.stringify(created));
  const key = ledgerKey('finding', 'deploy/local/install-windows.ps1', 'install-service');
  assert.ok(created[0].args[created[0].args.indexOf('--title') + 1].startsWith(`[audit-finding ${key}] WARNING:`));
});

// The ledger: open if new, a comment if already open, never closed by a run.
test('the ledger opens a new finding and comments on one already open', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'FAIL');
  const failId = firstId(CI);
  fragments.forEach((f, i) => writeFileSync(join(dir, f), fragmentText(f, i === 1
    ? { stated: 'FAIL', results: { [failId]: `- FAIL: ${failId} — c: violated` }, lines: finding('BLOCKER', 'lib/a.ts:10', 'runIt', 'new one') }
    : {})));
  const known = failKeyOf(failId);
  const { published, outputs } = runReporting(dir, env, { embargoEnv: { GH_LEDGER_OPEN: `41 [audit-finding ${known}] FAIL: old\n42 [audit-finding 0123456789ab] WARNING: other\n` } });
  assert.equal(published.status, 1);
  assert.equal(outputs.embargo.result, 'filed');
  const embargoCalls = ghCalls(dir).filter(({ embargo }) => embargo);
  const comment = embargoCalls.find(({ args }) => args[1] === 'comment' && args[2] === '41');
  assert.ok(comment, JSON.stringify(embargoCalls));
  assert.match(comment.body, /^Seen again as FAIL in \[run 123\]/);
  const ledgerCreates = embargoCalls.filter(({ args }) => args[1] === 'create' && args[args.indexOf('--title') + 1].startsWith('[audit-finding '));
  assert.equal(ledgerCreates.length, 1);
  assert.ok(ledgerCreates[0].body.includes('- BLOCKER: `lib/a.ts:10` `runIt` — new one'));
  assert.ok(!embargoCalls.some(({ args }) => args[1] === 'close' || args[1] === 'edit'));
  // The status issue lists what is open privately, this run's new one
  // included, by key, severity, and date, and says nothing else of it.
  const publicBody = statusIssueBody(dir);
  assert.ok(publicBody.includes('3 findings are open in the private ledger.'), publicBody);
  assert.ok(publicBody.includes(`| \`${known}\` | FAIL | failed check | ${SEEDED_ROW}`), publicBody);
  assert.ok(!publicBody.includes('new one') && !publicBody.includes('runIt') && !publicBody.includes('old'), publicBody);
});

// A later PASS closed the failure issue on 2026-07-14 and 2026-10-06 while the
// findings behind it were unfixed. While the ledger holds one, a PASS still
// exits zero, but the status issue lists it rather than reading as all clear.
test('a PASS is not published as all clear while a ledger issue is open', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'PASS');
  fragments.forEach((f) => writeFileSync(join(dir, f), fragmentText(f)));
  const { published } = runReporting(dir, env, { embargoEnv: { GH_LEDGER_OPEN: '41 [audit-finding 0123456789ab] BLOCKER: old\n' } });
  assert.equal(published.status, 0, published.stderr);
  const body = statusIssueBody(dir);
  assert.match(body, /^\*\*PASS\*\* — no check failed this run, but 1 finding is still open \(below\)\.$/m);
  assert.ok(!body.includes('no finding is open'), body);
  assert.ok(body.includes(`| \`0123456789ab\` | BLOCKER | finding | ${SEEDED_ROW}`), body);
});

// The domains were handed the open findings, so they could pass; the filing or
// the ledger read the status issue lists went missing afterwards.
for (const [name, options, result] of [
  ['no findings filed', { embargoToken: '', listToken: 'fixture-embargo-token', readToken: 'fixture-embargo-token' }, 'missing-token'],
  ['an unread ledger', { readToken: '' }, 'filed'],
]) {
  test(`a PASS with ${name} fails and is not all clear`, (t) => {
    const { dir, env } = fixture(t);
    stubGh(dir);
    writeFileSync(join(dir, 'audit-status.txt'), 'PASS');
    fragments.forEach((f) => writeFileSync(join(dir, f), fragmentText(f)));
    const { published, outputs } = runReporting(dir, env, options);
    assert.equal(outputs.compose.status, 'PASS');
    assert.equal(outputs.embargo.result, result);
    assert.equal(published.status, 1);
    assert.match(published.stdout, /::error::/);
    const body = statusIssueBody(dir);
    assert.ok(!body.includes('no finding is open'), body);
    if (options.readToken === '') assert.match(body, /^\*\*PASS\*\*, but the private findings ledger could not be read/m);
    else assert.match(body, /^\*\*PASS\*\*, but the private filing failed[^\n]*\n[\s\S]*\*\*The private filing failed: `EMBARGO_TOKEN` is not set\.\*\*/m);
  });
}

// A WARNING does not fail the run, and is not lost with it either.
test('a passing run files its WARNINGs in the ledger and nothing else', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'PASS');
  fragments.forEach((f, i) => writeFileSync(join(dir, f), fragmentText(f, i === 2 ? { lines: finding('WARNING', 'lib/b.ts:5', 'paste', 'a paste submits a command') } : {})));
  const { published, outputs } = runReporting(dir, env);
  assert.equal(outputs.compose.status, 'PASS');
  assert.equal(published.status, 0, published.stderr);
  const embargoCalls = ghCalls(dir).filter(({ embargo, args }) => embargo && args[1] !== 'list');
  assert.equal(embargoCalls.length, 1);
  assert.ok(embargoCalls[0].args[embargoCalls[0].args.indexOf('--title') + 1].startsWith('[audit-finding '));
  // Listed on the status issue like any open finding, and nothing is disclosed yet.
  assert.ok(statusIssueBody(dir).includes('1 finding is open in the private ledger.'));
  assert.deepEqual(publicIssues(dir, 'security-audit-finding'), []);
});

// --- Re-verifying the open ledger findings ---

// Run 37713086378 passed four rules an earlier run had failed, with the code
// unchanged, on the presence of the controls they name. The domains are handed
// the open findings, and a PASS over one a rule cites must say why it no
// longer holds, at a `path:line`.
const CI_POLICIES = sectionIds(CI, 'docs/specs/security-ci.md', 'GitHub Actions Policies');
const MINTED_RULE = CI_POLICIES[1];
const MINTED_KEY = failKeyOf(MINTED_RULE);
const MINTED_OPEN = `41 [audit-finding ${MINTED_KEY}] FAIL: ${MINTED_RULE}\n`;
// Hand-filed under a name of its own, citing its rule by ID.
const MANUAL_RULE = CI_POLICIES.at(-1);
const MANUAL_OPEN = `42 [audit-finding manual-example-gate] FAIL ${MANUAL_RULE}: a hand-filed failure\n`;

/** Every domain passes; `ci` overrides the CI fragment's options. */
function runOverOpen(t, open, ci = {}, options = {}) {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'PASS');
  fragments.forEach((f) => writeFileSync(join(dir, f), fragmentText(f, f === CI ? ci : {})));
  const run = runReporting(dir, env, { embargoEnv: { GH_LEDGER_OPEN: open }, ...options });
  const body = existsSync(join(dir, 'audit-private.md')) ? readFileSync(join(dir, 'audit-private.md'), 'utf8') : '';
  return { dir, body, ...run };
}

for (const [name, open, ci, expected, note, options = {}] of [
  ['a PASS over an open failure with no reason is INCONCLUSIVE', MINTED_OPEN, {}, 'MISSING',
    `\`${CI}\`: ${MINTED_RULE} passes over \`[audit-finding ${MINTED_KEY}]\`, \`docs/specs/security-ci.md\` -> "GitHub Actions Policies"`],
  ['a PASS naming the open failure without a path:line is INCONCLUSIVE', MINTED_OPEN,
    { results: { [MINTED_RULE]: `- PASS: ${MINTED_RULE} — c: holds; [audit-finding ${MINTED_KEY}] fixed upstream` } }, 'MISSING',
    '### Open findings passed without a reason'],
  ['a PASS naming the open failure and where it was fixed passes', MINTED_OPEN,
    { results: { [MINTED_RULE]: `- PASS: ${MINTED_RULE} — c: holds; [audit-finding ${MINTED_KEY}] no longer holds: the gate now reads \`scripts/workflow-lint.mjs:130\`` } }, 'PASS', null],
  ['a PASS over a hand-filed rule citation with no reason is INCONCLUSIVE', MANUAL_OPEN, {}, 'MISSING',
    `\`${CI}\`: ${MANUAL_RULE} passes over \`[audit-finding manual-example-gate]\``],
  ['a PASS on another rule under the hand-filed rule\'s heading gives no reason', MANUAL_OPEN,
    { results: { [CI_POLICIES[0]]: `- PASS: ${CI_POLICIES[0]} — c: holds; [audit-finding manual-example-gate] no longer holds: \`.github/workflows/security-audit.yaml:17\`` } }, 'MISSING',
    `\`${CI}\`: ${MANUAL_RULE} passes over \`[audit-finding manual-example-gate]\``],
  ['the PASS line on the hand-filed rule may give the reason', MANUAL_OPEN,
    { results: { [MANUAL_RULE]: `- PASS: ${MANUAL_RULE} — c: holds; [audit-finding manual-example-gate] no longer holds: \`.github/workflows/security-audit.yaml:17\`` } }, 'PASS', null],
  ['a finding citing no rule holds no PASS to a reason', '43 [audit-finding manual-example-lint] WARNING a lint misses a case\n', {}, 'PASS', null],
  ['no open-findings list leaves every domain INCONCLUSIVE', '', {}, 'MISSING', 'No open ledger findings were handed to the domains.', { listToken: '' }],
]) {
  test(`reporting: ${name}`, (t) => {
    const { body, outputs } = runOverOpen(t, open, ci, options);
    assert.equal(outputs.compose.status, expected, body);
    if (note) assert.ok(body.includes(note), `missing note: ${note}\n${body}`);
  });
}

// The open failure re-reported on another clause is the same failure: the
// ledger comments on its issue rather than opening a second.
test('a failure re-reported under another clause letter is seen again, not refiled', (t) => {
  const { dir, outputs } = runOverOpen(t, MINTED_OPEN, { stated: 'FAIL', results: { [MINTED_RULE]:
    `- PASS: ${MINTED_RULE}.a — c: holds\n- PASS: ${MINTED_RULE}.b — c: holds\n- FAIL: ${MINTED_RULE}.c — c: violated again\n- FAIL: ${MINTED_RULE}.d — c: and here` } });
  assert.equal(outputs.compose.status, 'FAIL');
  assert.equal(readFileSync(join(dir, 'audit-ledger/index.tsv'), 'utf8'), `${MINTED_KEY}\tFAIL\n`);
  assert.ok(readFileSync(join(dir, 'audit-ledger/1.md'), 'utf8').includes(`- FAIL: ${MINTED_RULE}.d — c: and here`));
  const embargoCalls = ghCalls(dir).filter(({ embargo }) => embargo);
  assert.ok(embargoCalls.some(({ args }) => args[1] === 'comment' && args[2] === '41'), JSON.stringify(embargoCalls));
  assert.ok(!embargoCalls.some(({ args }) => args[1] === 'create' && args[args.indexOf('--title') + 1].startsWith('[audit-finding ')));
});

// A rule keeps its ID wherever it moves, so a refactor of the specs re-keys no
// open finding: the moved rule's failure is seen again on the issue it was
// filed under, and its metadata places it where it lives now.
for (const [where, spec, heading] of [
  ['another heading', 'docs/specs/security-ci.md', 'Desktop Releases'],
  ['another spec', 'docs/specs/security-audit.md', 'Embargo'],
]) {
  test(`a rule moved to ${where} keeps its failure's ledger key`, (t) => {
    const { dir, env } = fixture(t);
    const from = join(dir, 'docs/specs/security-ci.md');
    const ruleLine = readFileSync(from, 'utf8').split('\n').find((l) => l.startsWith(`- **FAIL IF** \`${MINTED_RULE}\` `));
    assert.ok(ruleLine, MINTED_RULE);
    writeFileSync(from, readFileSync(from, 'utf8').replace(`${ruleLine}\n`, ''));
    const to = join(dir, spec);
    const text = readFileSync(to, 'utf8');
    const under = text.indexOf(`\n## ${heading}\n`);
    assert.ok(under >= 0, heading);
    writeFileSync(to, `${text.slice(0, under)}\n## ${heading}\n\n${ruleLine}\n${text.slice(under + heading.length + 5)}`);
    stubGh(dir);
    writeFileSync(join(dir, 'audit-status.txt'), 'FAIL');
    fragments.forEach((f) => writeFileSync(join(dir, f), fragmentText(f, f === CI
      ? { stated: 'FAIL', results: { [MINTED_RULE]: `- FAIL: ${MINTED_RULE} — c: violated again` } } : {})));
    const { outputs } = runReporting(dir, env, { embargoEnv: { GH_LEDGER_OPEN: MINTED_OPEN } });
    assert.equal(outputs.compose.status, 'FAIL');
    assert.equal(readFileSync(join(dir, 'audit-ledger/index.tsv'), 'utf8'), `${MINTED_KEY}\tFAIL\n`);
    assert.ok(readFileSync(join(dir, 'audit-ledger/1.md'), 'utf8').startsWith(ledgerMeta({ key: MINTED_KEY, severity: 'FAIL', rule: MINTED_RULE, spec, heading })));
    const embargoCalls = ghCalls(dir).filter(({ embargo }) => embargo);
    assert.ok(embargoCalls.some(({ args }) => args[1] === 'comment' && args[2] === '41'), JSON.stringify(embargoCalls));
    assert.ok(!embargoCalls.some(({ args }) => args[1] === 'create' && args[args.indexOf('--title') + 1].startsWith('[audit-finding ')));
  });
}

// A ledger key must not move with what a domain chose to call it: the clause
// letter of a failure, or the line and wording of a finding's root cause.
test('ledger keys ignore the clause letter and a finding\'s wording', (t) => {
  const keyed = (ci) => {
    const { dir } = runOverOpen(t, '', { stated: 'FAIL', ...ci });
    return readFileSync(join(dir, 'audit-ledger/index.tsv'), 'utf8');
  };
  const rule = owedIds(CI)[0];
  const asB = keyed({ results: { [rule]: `- PASS: ${rule}.a — c: ok\n- FAIL: ${rule}.b — c: violated` } });
  const asC = keyed({ results: { [rule]: `- PASS: ${rule}.a — c: ok\n- PASS: ${rule}.b — c: ok\n- FAIL: ${rule}.c — c: violated` } });
  assert.equal(asB, asC);
  // The key hashes the rule's ID alone, never where the rule sits.
  assert.equal(asB, `${ledgerKey('check', rule)}\tFAIL\n`);
  const symbol = keyed({ stated: 'PASS', lines: finding('WARNING', 'lib/src/config.ts:40', 'parseConfig()', 'one night') });
  const reworded = keyed({ stated: 'PASS', lines: finding('WARNING', './lib/src/config.ts:90', 'parseConfig falls back to defaults', 'another night') });
  assert.equal(symbol, reworded);
  assert.equal(symbol, `${ledgerKey('finding', 'lib/src/config.ts', 'parseconfig')}\tWARNING\n`);
  // A cause written as its rule keys on the rule's ID, a clause letter ignored;
  // one in prose keys on all of it: a product name is no symbol.
  const ruleCause = (cause) => keyed({ stated: 'PASS', lines: finding('WARNING', '.github/workflows/x.yaml:4', cause, 'one') });
  assert.notEqual(ruleCause('S2'), ruleCause('S4'));
  assert.equal(ruleCause('S2'), ruleCause('S2.b'));
  assert.equal(ruleCause('S2'), `${ledgerKey('finding', '.github/workflows/x.yaml', 'S2')}\tWARNING\n`);
  const prose = (cause) => keyed({ stated: 'PASS', lines: finding('WARNING', '.github/workflows/x.yaml:4', cause, 'one') });
  assert.notEqual(prose('GitHub token reaches a log'), prose('GitHub cache is shared'));
});

// Hand-filed ledger issues carry keys no run mints; they still count as open,
// so a PASS that re-verified them still lists them on the status issue.
test('a hand-filed ledger key still counts as an open finding', (t) => {
  const { dir, outputs, published } = runOverOpen(t, MANUAL_OPEN,
    { results: { [MANUAL_RULE]: `- PASS: ${MANUAL_RULE} — c: holds; [audit-finding manual-example-gate] no longer holds: \`lib/src/x.ts:3\`` } });
  assert.equal(outputs.compose.status, 'PASS');
  assert.equal(published.status, 0, published.stderr);
  assert.equal(readFileSync(join(dir, OPEN_FINDINGS), 'utf8'), MANUAL_OPEN.slice(3));
  // Listed, its name withheld until it is disclosed.
  const body = statusIssueBody(dir);
  assert.ok(body.includes(`| hand-filed | FAIL | failed check | ${SEEDED_ROW}`), body);
  assert.ok(!body.includes('manual-example-gate'), body);
});

// The builder failing must not turn into a verdict.
test('a report builder that throws reports INCONCLUSIVE', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'PASS');
  fragments.forEach((f) => writeFileSync(join(dir, f), fragmentText(f)));
  writeFileSync(join(dir, 'scripts/security-audit-report.mjs'), 'throw new Error("boom");\n');
  stubGh(dir, { public: [{ number: 5, title: 'Security audit status', body: 'earlier status', labels: ['security-audit-status'], state: 'OPEN', comments: [] }] });
  const { outputs, published } = runReporting(dir, env);
  assert.equal(outputs.compose.status, 'MISSING');
  assert.equal(published.status, 1);
  // The status builder shares the module, so it throws too: a fixed sentence
  // on the status issue, never a body built some other way.
  assert.match(published.stdout, /::error::The status builder failed/);
  const [issue] = ghState(dir).public;
  assert.match(issue.comments.at(-1).body, /^The audit run at \S+ could not publish its status, so the body above is stale\. \[Run\]\(https:\/\/github\.com\/fixture\/repo\/actions\/runs\/123\)$/);
  assert.equal(issue.body, 'earlier status');
});

// The manifest is what makes a skipped section visible, so it must be derived
// from the specs: between them the domains and the deterministic check owe
// every rule each spec carries, and a domain owes every one a script does not
// answer alone.
test('every FAIL IF rule is owed by its domain, its deterministic check, or both', () => {
  const claimed = domains(repo);
  assert.deepEqual(claimed.map((d) => d.fragment).sort(), [...fragments].sort());
  const state = new Set(owedIds(STATE_FRAGMENT));
  for (const { fragment, specs } of claimed) {
    const owed = new Set(owedIds(fragment));
    for (const spec of specs) {
      const text = readFileSync(join(repo, spec), 'utf8').split(/^## Future\b/m)[0];
      const rules = text.split('\n').filter((l) => /^\s*(?:[-*]\s+)?\*\*FAIL IF\b/.test(l)).length;
      const covered = new Set([...owed, ...state].filter((id) => ruleOf(id).spec === spec));
      assert.equal(covered.size, rules, `${fragment}: ${spec}`);
    }
  }
  // Pinned to the script alone, a rule is the check's only; pinned beside a
  // test, the domain still answers the rest of it.
  const ci = new Set(owedIds(CI));
  assert.ok(state.has(VSCODE_RULE) && !ci.has(VSCODE_RULE));
  const gate = owedIds(STATE_FRAGMENT).find((id) => ruleOf(id).heading === 'Schedule and gate');
  assert.ok(gate && ci.has(gate));
});

// A domain that counts its way to a rule can land on a neighbour: run
// 38982560206's remote domain swapped two "Trust boundary" rules. So each
// template carries its rule's ID, names the rule by opening words no sibling
// under its heading shares, and places it by spec and heading.
test('the manifest names every owed rule by its ID and opening words its siblings do not share', () => {
  for (const fragment of allFragments) {
    const ids = owedIds(fragment);
    const lines = manifestLines(repo, fragment);
    assert.equal(lines.length, ids.length, fragment);
    const openings = new Map();
    ids.forEach((id, i) => {
      const m = lines[i].match(/^- PASS: (S\d+) — <clause of the rule opening "(.+?)(?: …)?", under `(.+)` -> "(.+)">: <evidence>$/);
      assert.ok(m, lines[i]);
      assert.equal(m[1], id);
      const rule = ruleOf(id);
      const [spec, heading] = [m[3], m[4]];
      assert.deepEqual([spec, heading], [rule.spec, rule.heading], id);
      const words = rule.text.replace(/^\s*(?:[-*]\s+)?\*\*FAIL IF\*\*\s*`S\d+`\s*/, '').replaceAll('**', '').split(/\s+/).join(' ');
      assert.ok(words.startsWith(m[2]), `${id}: "${m[2]}"`);
      const key = `${spec}\0${heading}`;
      assert.ok(!openings.get(key)?.has(m[2]), `${id} shares its opening with a sibling`);
      openings.set(key, (openings.get(key) ?? new Set()).add(m[2]));
    });
  }
  const cli = spawnSync(process.execPath, [join(repo, 'scripts/security-audit-report.mjs'), 'manifest', REMOTE], { cwd: repo, encoding: 'utf8' });
  assert.equal(cli.stdout, `${manifestLines(repo, REMOTE).join('\n')}\n`);
});

// An empty manifest would let any fragment pass, so a fragment no domain
// writes, or a scope naming a spec that is gone, fails closed.
test('the manifest fails closed on a fragment or spec nobody can resolve', (t) => {
  assert.throws(() => fragmentManifest(repo, 'audit-typo.md'), /no domain prompt writes/);
  const { dir } = fixture(t);
  const prompt = join(dir, '.github/audit/supply-chain.md');
  writeFileSync(prompt, readFileSync(prompt, 'utf8').replace('docs/specs/security-supply-chain.md', 'docs/specs/security-moved.md'));
  assert.throws(() => fragmentManifest(dir, SUPPLY), /does not exist/);
});

// "Domains": section by section, every `FAIL IF` in a security spec on disk is
// answered by exactly one domain, or, pinned to the deterministic check alone,
// by that check and none. A section two domains claim gets two verdicts; one
// no domain claims gets none.
test('every security spec FAIL IF section is claimed by exactly one domain', () => {
  const owners = new Map();
  for (const { domain, fragment } of domains(repo)) {
    for (const key of fragmentManifest(repo, fragment).keys()) owners.set(key, [...(owners.get(key) ?? []), domain]);
  }
  const state = fragmentManifest(repo, STATE_FRAGMENT);
  const sections = new Set([...ruleIndex(repo).values()].map((r) => `${r.spec}\0${r.heading}`));
  assert.ok(sections.size > 0);
  for (const key of sections) {
    const by = owners.get(key) ?? [];
    assert.ok(by.length === 1 || (by.length === 0 && state.has(key)), `${key.replace('\0', ' -> ')}: claimed by ${by.join(' and ') || 'no domain'}`);
  }
  assert.deepEqual([...owners.keys()].filter((key) => !sections.has(key)), []);
});

// The work streams replace a domain's own partition, so between them they hold
// every heading the manifest owes, each exactly once.
test('each domain\'s work streams cover every owed heading once', () => {
  for (const { domain, fragment } of domains(repo)) {
    const prompt = readFileSync(join(repo, `.github/audit/${domain}.md`), 'utf8');
    const section = prompt.split(/^## Work streams$/m)[1]?.split(/^## /m)[0];
    assert.ok(section, `${domain}: no ## Work streams section`);
    const named = [];
    for (const line of section.split('\n').filter((l) => l.startsWith('- `'))) {
      let spec = null;
      for (const m of line.matchAll(/`(docs\/specs\/[^`]+)`|"([^"]+)"/g)) {
        if (m[1]) spec = m[1];
        else named.push(`${spec}\0${m[2]}`);
      }
    }
    assert.ok(section.includes('- `qualitative` —'), `${domain}: no qualitative stream`);
    assert.deepEqual([...named].sort(), [...fragmentManifest(repo, fragment).keys()].sort(), domain);
  }
});

test('redaction covers every archived sink', (t) => {
  const { dir, env } = fixture(t);
  for (const sink of archivedSinks) writeFileSync(join(dir, sink), `${env.AUDIT_PAT} ${env.CLAUDE_CODE_OAUTH_TOKEN}`);
  const result = spawnSync('bash', ['-c', runBlock('Redact secrets from agent output')], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const sink of archivedSinks) assert.equal(readFileSync(join(dir, sink), 'utf8'), '*** ***');
});

test('redactor failure removes every archived sink', (t) => {
  const { dir, env } = fixture(t);
  for (const sink of archivedSinks) writeFileSync(join(dir, sink), env.AUDIT_PAT);
  stub(dir, 'node', 'process.exit(1);');
  const result = spawnSync('bash', ['-c', runBlock('Redact secrets from agent output')], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  for (const sink of archivedSinks) assert.equal(existsSync(join(dir, sink)), false, sink);
});

// --- The deterministic GitHub-state check and the skip-unchanged path ---

// The deterministic fragment owes the rules pinned to its script and no
// qualitative line; this one fails the VS Code reviewer rule.
const VSCODE_RULE = owedIds(STATE_FRAGMENT).find((id) => ruleOf(id).heading === 'VS Code Extension Releases');
const STATE_FAIL = fragmentText(STATE_FRAGMENT, { stated: 'FAIL',
  results: { [VSCODE_RULE]: `- FAIL: ${VSCODE_RULE} — \`vscode-extension-publish\` sets \`prevent_self_review: true\`: prevent_self_review false` } });

// The check's verdict is a domain's like any other: a FAIL there fails the run
// whatever the orchestrator wrote, and a missing fragment is an unfinished audit.
for (const [name, state, expected, row] of [
  ['a GitHub-state FAIL fails a merged PASS', STATE_FAIL, 'FAIL', '| `audit-github-state.md` | FAIL | 1 | 0 | 0 |'],
  ['a missing GitHub-state fragment is inconclusive', null, 'INCONCLUSIVE', '| `audit-github-state.md` | no report |'],
]) {
  test(`reporting: ${name}`, (t) => {
    const { dir, env } = fixture(t);
    stubGh(dir);
    writeFileSync(join(dir, 'audit-status.txt'), 'PASS');
    writeFileSync(join(dir, 'audit-report.md'), '# Fixture report\n');
    for (const f of fragments) writeFileSync(join(dir, f), fragmentText(f));
    if (state === null) rmSync(join(dir, STATE_FRAGMENT));
    else writeFileSync(join(dir, STATE_FRAGMENT), state);
    const { published, outputs } = runReporting(dir, env);
    assert.equal(published.status, 1);
    assert.equal(outputs.compose.status, expected === 'FAIL' ? 'FAIL' : 'MISSING');
    const publicBody = statusIssueBody(dir);
    assert.ok(publicBody.includes(row), publicBody);
    if (state) {
      assert.ok(publicBody.includes('- `docs/specs/security-ci.md` -> "VS Code Extension Releases"'), publicBody);
      assert.ok(!publicBody.includes('prevent_self_review false'), publicBody);
    }
  });
}

// The two reporting steps read only the deterministic fragment on a skipped
// run — the domains never ran, and the reporting step must not call that an
// unfinished audit — and the status the plan step wrote is held to that
// fragment's verdict.
const SKIP_FRAGMENTS = '${{ steps.plan.outputs.fragments || env.AUDIT_FRAGMENTS }}';
test('a skipped run narrows the reporting steps to the deterministic fragment', () => {
  for (const name of ['Compose the audit report', 'Publish the audit status']) {
    assert.ok(stepText(name).includes(`          AUDIT_FRAGMENTS: ${SKIP_FRAGMENTS}\n`), name);
  }
  assert.match(stepText('Audit against the security specs'), /^        if: steps\.plan\.outputs\.skip != 'true'$/m);
  assert.ok(allFragments.includes(STATE_FRAGMENT));
});
for (const [name, state, expected] of [['passes on a passing check', null, 'PASS'], ['fails on a failing check', STATE_FAIL, 'FAIL']]) {
  test(`reporting: a skipped run ${name}`, (t) => {
    const { dir, env } = fixture(t);
    stubGh(dir);
    writeFileSync(join(dir, 'audit-status.txt'), 'PASS\n');
    writeFileSync(join(dir, 'audit-report.md'), '# Security audit\n\nThe domains were skipped.\n');
    if (state) writeFileSync(join(dir, STATE_FRAGMENT), state);
    const { published, outputs } = runReporting(dir, { ...env, AUDIT_FRAGMENTS: STATE_FRAGMENT },
      { plan: { skip: 'true', full_run_at: '2026-10-05T12:00:00.000Z' } });
    assert.equal(outputs.compose.status, expected);
    assert.equal(published.status, expected === 'PASS' ? 0 : 1, published.stderr);
    const publicBody = statusIssueBody(dir);
    assert.ok(!publicBody.includes('audit-supply-chain.md'), publicBody);
    // The status issue says the domains were skipped, and when they last ran.
    assert.ok(publicBody.includes('The audit domains were skipped: the commit and GitHub settings are unchanged since a passing run. They last ran in full at 2026-10-05T12:00:00.000Z;'), publicBody);
  });
}

const HASH = 'a'.repeat(64);
const NOW = new Date('2026-10-07T12:00:00Z');
const prior = (overrides = {}, state = {}) => ({ id: 41, conclusion: 'success',
  state: { commit: COMMIT, state_hash: HASH, full_run_at: '2026-10-05T12:00:00Z', mode: 'full', ...state }, ...overrides });
for (const [name, input, skip, reason] of [
  ['an unchanged scheduled run skips', { previous: prior() }, true, /unchanged since run 41/],
  ['a dispatch never skips', { event: 'workflow_dispatch', previous: prior() }, false, /`workflow_dispatch` run always audits in full/],
  ['a changed commit audits in full', { sha: 'b'.repeat(40), previous: prior() }, false, /commit changed/],
  ['a changed GitHub state audits in full', { hash: 'c'.repeat(64), previous: prior() }, false, /hash changed/],
  ['no hash audits in full', { hash: '', previous: prior() }, false, /produced no hash/],
  ['a failed previous run audits in full', { previous: prior({ conclusion: 'failure' }) }, false, /concluded `failure`/],
  ['a previous run with no recorded state audits in full', { previous: { id: 41, conclusion: 'success', state: null } }, false, /no `audit-state` artifact/],
  ['no previous run audits in full', { previous: undefined }, false, /no earlier completed run/],
  ['a full audit a week old is repeated', { previous: prior({}, { full_run_at: '2026-09-30T12:00:00Z' }) }, false, /7 or more days old/],
  ['an unreadable full-run time is repeated', { previous: prior({}, { full_run_at: 'never' }) }, false, /7 or more days old/],
]) {
  test(`skip decision: ${name}`, () => {
    const decision = decide({ event: 'schedule', sha: COMMIT, hash: HASH, now: NOW, ...input });
    assert.equal(decision.skip, skip);
    assert.match(decision.reason, reason);
    // A skip carries the last full audit's time forward; a full run starts the clock.
    assert.equal(decision.fullRunAt, skip ? input.previous.state.full_run_at : NOW.toISOString());
  });
}

// The plan step as shipped, over a `gh` that lists runs and serves the
// previous run's `audit-state` artifact.
test('the plan step skips on recorded state, writes the stand-in report, and records its own', (t) => {
  const { dir, env } = fixture(t);
  rmSync(join(dir, STATE_FRAGMENT));
  const recorded = { commit: COMMIT, state_hash: HASH, full_run_at: new Date(Date.now() - 86_400_000).toISOString(), mode: 'full', run_id: '41' };
  stub(dir, 'gh', `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync('gh-calls.jsonl', JSON.stringify({ args, token: process.env.GH_TOKEN }) + '\\n');
    if (args[0] === 'api') process.stdout.write(JSON.stringify({ workflow_runs: [
      { id: 123, head_branch: 'main', conclusion: null, created_at: '2026-10-07T11:00:00Z' },
      { id: 41, head_branch: 'main', conclusion: 'success', created_at: '2026-10-06T11:00:00Z' },
      { id: 40, head_branch: 'main', conclusion: 'failure', created_at: '2026-10-05T11:00:00Z' } ] }));
    else if (args[0] === 'run' && args[1] === 'download' && args[2] === '41') {
      fs.writeFileSync(require('node:path').join(args[args.indexOf('-D') + 1], 'audit-state.json'), ${JSON.stringify(JSON.stringify(recorded))});
    } else process.exit(1);
  `);
  const output = join(dir, 'github-output');
  writeFileSync(output, '');
  const run = (event) => spawnSync(process.execPath, [join(repo, 'scripts/security-audit-plan.mjs')], { cwd: dir, encoding: 'utf8',
    env: { ...env, GITHUB_EVENT_NAME: event, STATE_HASH: HASH, GITHUB_OUTPUT: output } });
  const skipped = run('schedule');
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(readFileSync(output, 'utf8'), /^skip=true$/m);
  assert.match(readFileSync(output, 'utf8'), new RegExp(`^fragments=${STATE_FRAGMENT}$`, 'm'));
  assert.equal(readFileSync(join(dir, 'audit-status.txt'), 'utf8'), 'PASS\n');
  assert.match(readFileSync(join(dir, 'audit-report.md'), 'utf8'), /The domains were skipped: .*run 41/);
  const state = JSON.parse(readFileSync(join(dir, 'audit-state/audit-state.json'), 'utf8'));
  assert.deepEqual(state, { commit: COMMIT, state_hash: HASH, full_run_at: recorded.full_run_at, mode: 'skipped', run_id: '123' });
  // The run under way is never its own reference.
  assert.ok(ghCalls(dir).some(({ args }) => args.slice(0, 8).join(' ') === 'run download 41 -R fixture/repo -n audit-state -D'));

  rmSync(join(dir, 'audit-status.txt'));
  rmSync(join(dir, 'audit-report.md'));
  writeFileSync(output, '');
  const dispatched = run('workflow_dispatch');
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.match(readFileSync(output, 'utf8'), /^skip=false$/m);
  assert.doesNotMatch(readFileSync(output, 'utf8'), /^fragments=/m);
  assert.ok(!existsSync(join(dir, 'audit-status.txt')) && !existsSync(join(dir, 'audit-report.md')));
  assert.equal(JSON.parse(readFileSync(join(dir, 'audit-state/audit-state.json'), 'utf8')).mode, 'full');
});

// --- Embargo: detail goes private, the public issue gets verdicts and counts ---

// Issue #1027 published a working command-injection payload. A FAIL line and a
// BLOCKER carrying one, a FAIL line naming an ID no spec has, malformed
// lines carrying one, and a verdict line with an appended explanation: none of
// their text may reach the public body, and all of it must reach the private
// issue.
const EXPLOIT = '$(printf calc-injected-7f3a)';
const PAT_RULE = sectionIds(CI, 'docs/specs/security-audit.md', 'Environment and `AUDIT_PAT`')[0];
test('the status issue carries counts and verified section names, never finding text', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'FAIL');
  writeFileSync(join(dir, 'audit-report.md'), `# Security audit\n\nThe merged report quotes ${EXPLOIT}.\n`);
  fragments.forEach((f, i) => writeFileSync(join(dir, f), i !== 1 ? fragmentText(f) : fragmentText(f, {
    stated: `FAIL — ${EXPLOIT}`,
    results: { [PAT_RULE]: `- FAIL: ${PAT_RULE} — reproduced with ${EXPLOIT}` },
    lines: [
      `- FAIL: S99999 — an ID no spec has: run ${EXPLOIT} to see`,
      ...finding('BLOCKER', 'lib/a.ts:3', 'run', `the reporter runs ${EXPLOIT}`),
      `- **WARNING** — ${EXPLOIT} again`,
      '- INFO: `docs/x.md:1` `drift` — nothing to see',
      `- INFO: off the grammar, quoting ${EXPLOIT}`,
    ],
  })));
  const { published } = runReporting(dir, env);
  assert.equal(published.status, 1, published.stderr);
  const calls = ghCalls(dir);
  const publicBody = statusIssueBody(dir);
  assert.ok(!calls.some(({ embargo, body }) => !embargo && body?.includes('calc-injected-7f3a')));
  assert.ok(publicBody.includes(`| \`${fragments[1]}\` | FAIL | 2 | 0 | 2 | 1 | 0 |`), publicBody);
  // Every domain has its own row, the two that split application security included.
  for (const { fragment } of domains(repo)) assert.ok(publicBody.includes(`| \`${fragment}\` | `), fragment);
  for (const fragment of ['audit-remote.md', 'audit-local.md']) assert.ok(publicBody.includes(`| \`${fragment}\` | PASS | 0 | 0 | 0 | 0 | 0 |`), publicBody);
  assert.ok(publicBody.includes('- `docs/specs/security-audit.md` -> "Environment and `AUDIT_PAT`"'), publicBody);
  assert.ok(publicBody.includes('1 failed check named no rule its domain owes.'), publicBody);
  assert.ok(publicBody.includes(COMMIT), publicBody);
  assert.match(publicBody, /Finding detail stays private until the finding is fixed, or 7 days after it is filed/);
  const privately = calls.filter(({ embargo }) => embargo).map(({ body }) => body).join('');
  assert.ok(privately.includes(`- BLOCKER: \`lib/a.ts:3\` \`run\` — the reporter runs ${EXPLOIT}`), privately);
  assert.ok(privately.includes(`- **WARNING** — ${EXPLOIT} again`), privately);
  assert.ok(privately.includes(`- INFO: off the grammar, quoting ${EXPLOIT}`), privately);
});

test('a long report is split across the private issue and its comments, losing nothing', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'FAIL');
  const id = firstId(SUPPLY);
  const filler = Array.from({ length: 400 }, (_, i) => `  - Note: filler line ${i} of a long finding ${'x'.repeat(200)}`);
  const tail = `  - Note: the line past the old cut ${EXPLOIT}`;
  fragments.forEach((f, i) => writeFileSync(join(dir, f), fragmentText(f, i ? {} : {
    stated: 'FAIL', results: { [id]: `- FAIL: ${id} — c: violated` },
    lines: [...finding('WARNING', 'lib/a.ts:3', 'run', 'long'), ...filler, tail],
  })));
  runReporting(dir, env);
  const filed = reportCalls(ghCalls(dir));
  assert.ok(filed.length >= 3, `filed ${filed.length} part(s)`);
  assert.deepEqual(filed.map(({ args }) => args[1]), ['create', ...Array(filed.length - 1).fill('comment')]);
  assert.ok(filed[0].args.includes(EMBARGO_REPO));
  assert.ok(filed.every(({ body }) => body.length <= BODY_LIMIT));
  assert.ok(filed.map(({ body }) => body).join('').includes(tail));
});

for (const [name, options, result, publicNote] of [
  ['a missing EMBARGO_TOKEN', { embargoToken: '' }, 'missing-token', '`EMBARGO_TOKEN` is not set'],
  ['a refused private filing', { embargoEnv: { GH_FAIL_EMBARGO: '1' } }, 'failed', 'The private filing failed.'],
]) {
  test(`${name} fails loudly and publishes no detail`, (t) => {
    const { dir, env } = fixture(t);
    stubGh(dir);
    writeFileSync(join(dir, 'audit-status.txt'), 'FAIL');
    writeFileSync(join(dir, 'audit-report.md'), `# Security audit\n${EXPLOIT}\n`);
    fragments.forEach((f, i) => writeFileSync(join(dir, f), fragmentText(f, i ? {} : { stated: 'FAIL', lines: finding('BLOCKER', 'lib/a.ts:3', 'run', EXPLOIT) })));
    const { embargoed, published, outputs } = runReporting(dir, env, options);
    assert.equal(embargoed.status, 1);
    assert.match(embargoed.stdout, /::error::/);
    assert.equal(outputs.embargo.result, result);
    assert.ok(!`${embargoed.stdout}${embargoed.stderr}`.includes('calc-injected-7f3a'));
    if (result === 'missing-token') assert.equal(ghCalls(dir).filter(({ embargo }) => embargo).length, 0);
    // The status issue is still written, says the private filing failed, and
    // carries no more than it would have anyway.
    assert.equal(published.status, 1);
    const body = statusIssueBody(dir);
    assert.ok(body.includes(publicNote), body);
    assert.ok(!ghCalls(dir).some(({ embargo, body: posted }) => !embargo && posted?.includes('calc-injected-7f3a')));
  });
}

// The agent must never hold `EMBARGO_TOKEN`: it is named only in the `env:`
// of the three steps that list, file, and read the ledger, none is the
// agent's, and no job- or workflow-level `env:`, `$GITHUB_ENV` write, or
// whole-secrets expression reaches it elsewhere.
const HOLDERS = ['List open findings', 'File embargoed findings', 'Read the findings ledger'];
test('EMBARGO_TOKEN is in the env of the ledger steps alone', () => {
  const uses = workflow.split('\n').filter((line) => /secrets\s*\.\s*EMBARGO_TOKEN|secrets\s*\[/.test(line));
  assert.deepEqual(uses, HOLDERS.map(() => '          GH_TOKEN: ${{ secrets.EMBARGO_TOKEN }}'));
  for (const holder of HOLDERS) {
    const env = stepText(holder).match(/^        env:\n((?:          .*\n)+)/m)[1];
    assert.ok(env.includes(uses[0]), `the token is not in ${holder}'s env`);
  }
  for (const name of ['Audit against the security specs', 'Publish the audit status']) assert.ok(!stepText(name).includes('EMBARGO_TOKEN'), name);
  assert.doesNotMatch(workflow, /toJSON\(\s*secrets\s*\)|secrets: inherit/);
  assert.doesNotMatch(workflow, /GITHUB_ENV/);
});

// Holding the token, each step runs `gh` and nothing from the repository: no
// script a modified checkout could swap.
for (const holder of HOLDERS) {
  test(`${holder} runs no repository code`, () => {
    const block = runBlock(holder);
    assert.doesNotMatch(block, /\bnode\b|\bpnpm\b|\bnpx\b|scripts\/|\.\/|\bsource\b|^\s*\. /m);
    // Nor any other program: `gh` and shell builtins only.
    const code = block.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(code, /(?:^|[\s;|&(`]|\$\()(?:date|mktemp|mkdir|rm|mv|cp|tee|sed|awk|grep|head|tail|wc|cat|cut|tr|jq|curl|wget|python3?|env|xargs|find|sort)\b(?!-)/m);
  });
}

// --- Disclosure: what the ledger read keeps, and what becomes public when ---

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const maintainer = (body, authorAssociation = 'MEMBER') => ({ author: { login: 'a-maintainer' }, authorAssociation, body });
/**
 * A ledger issue as the embargo tracker holds it: its title and body carry text
 * that must never cross. Filed `ageDays` before `now`, and closed at `now`.
 */
function ledgerIssue(number, { key, severity = 'WARNING', meta, state = 'OPEN', stateReason = state === 'CLOSED' ? 'COMPLETED' : '', ageDays = 1, comments = [], now = Date.now() }) {
  return { number, title: `[audit-finding ${key}] ${severity}: lib/a.ts:3 run — title detail ${EXPLOIT}`,
    body: `${meta ? `${ledgerMeta({ key, severity, ...meta })}\n\n` : ''}Reported by \`audit-application.md\`:\n\n- ${severity}: body detail ${EXPLOIT}\n\n## Public summary\nfrom the body ${EXPLOIT}\n`,
    labels: [], state, stateReason, createdAt: iso(now - ageDays * DAY), closedAt: state === 'CLOSED' ? iso(now) : null,
    comments: [{ author: { login: 'a-maintainer' }, authorAssociation: 'MEMBER', body: 'Seen again as WARNING in [run 9](https://github.com/x/y/actions/runs/9) at `abcdef0`.' }, ...comments] };
}

/** Run the ledger read alone over a seeded tracker; returns the result and the parsed snapshot. */
function readLedger(t, embargo) {
  const { dir, env } = fixture(t);
  stubGh(dir, { embargo });
  const before = new Set(readdirSync(dir));
  const result = spawnSync('bash', ['-c', runBlock('Read the findings ledger')], { cwd: dir, encoding: 'utf8',
    env: { ...env, GH_TOKEN: 'fixture-embargo-token', EMBARGO_REPO, GITHUB_OUTPUT: join(dir, 'github-output') } });
  const added = readdirSync(dir).filter((f) => !before.has(f) && f !== 'gh-calls.jsonl' && f !== 'gh-state.json');
  const path = join(dir, 'audit-ledger-snapshot.jsonl');
  return { dir, result, added, text: existsSync(path) ? readFileSync(path, 'utf8') : null };
}

// The ledger read is the embargo's filter: of each ledger issue it keeps the
// state, dates, key and severity, the body's opening metadata line, and from
// maintainers' comments only a `Fixed in` PR and a `## Public summary`. The
// title's and body's text, the workflow's `Seen again` lines, a summary in the
// body, and a summary from anyone but a maintainer stay in the tracker.
test('the ledger read keeps metadata, citations, and maintainer summaries, never ledger text', (t) => {
  const { result, added, text } = readLedger(t, [
    ledgerIssue(7, { key: 'aaaaaaaaaaaa', meta: { file: 'lib/a.ts' }, state: 'CLOSED', comments: [
      maintainer('Fixed in #12 (merged).'),
      maintainer('Fixed by https://github.com/fixture/repo/pull/13'),
      maintainer('## Public summary\nA paste could submit a command.'),
      maintainer(`## Public summary\nfrom a stranger ${EXPLOIT}`, 'NONE'),
      maintainer('Fixed in #99', 'CONTRIBUTOR'),
      maintainer(`Reopened: Fixed in #55 was incomplete ${EXPLOIT}`)] }),
    ledgerIssue(8, { key: 'manual-hand-filed', severity: 'FAIL' }),
    { ...ledgerIssue(9, { key: 'bbbbbbbbbbbb' }), title: '[security-audit] FAIL on 2026-10-08 at abcdef0' },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(added, ['audit-ledger-snapshot.jsonl']);
  assert.equal(`${result.stdout}${result.stderr}`, 'Read 2 ledger issue(s).\n');
  assert.ok(!text.includes('calc-injected-7f3a') && !text.includes('detail') && !text.includes('Seen again'), text);
  const [fixed, manual] = text.trim().split('\n').map(JSON.parse);
  assert.deepEqual(fixed.title, { key: 'aaaaaaaaaaaa', severity: 'WARNING' });
  assert.deepEqual(fixed.meta, { key: 'aaaaaaaaaaaa', severity: 'WARNING', rule: null, spec: null, heading: null, file: 'lib/a.ts' });
  assert.deepEqual(fixed.fixed, [{ repo: null, pr: '12' }, { repo: 'fixture/repo', pr: '13' }]);
  assert.equal(fixed.summary, 'A paste could submit a command.');
  assert.deepEqual([fixed.state, fixed.stateReason], ['CLOSED', 'COMPLETED']);
  // No metadata line, no citation, no summary: key, severity, and dates alone.
  assert.deepEqual([manual.title, manual.meta, manual.fixed, manual.summary], [{ key: 'manual-hand-filed', severity: 'FAIL' }, null, [], null]);
  assert.deepEqual(parseLedger(text).map((e) => e.key), ['aaaaaaaaaaaa', 'manual-hand-filed']);
});

// The metadata line must open the body: one an agent wrote further down, in
// the finding text compose copies in, is not read.
test('only the metadata line that opens a ledger body is read', (t) => {
  const forged = ledgerIssue(7, { key: 'aaaaaaaaaaaa' });
  forged.body = `Reported by x:\n\n${ledgerMeta({ key: 'aaaaaaaaaaaa', severity: 'WARNING', file: 'scripts/security-audit-report.mjs' })}\n`;
  const { text } = readLedger(t, [forged]);
  assert.equal(JSON.parse(text).meta, null);
});

test('the ledger read without its token reads nothing and writes no snapshot', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir, { embargo: [ledgerIssue(7, { key: 'aaaaaaaaaaaa' })] });
  const result = spawnSync('bash', ['-c', runBlock('Read the findings ledger')], { cwd: dir, encoding: 'utf8',
    env: { ...env, GH_TOKEN: '', EMBARGO_REPO, GITHUB_OUTPUT: join(dir, 'github-output') } });
  assert.equal(result.status, 1);
  assert.ok(!existsSync(join(dir, 'audit-ledger-snapshot.jsonl')));
  assert.equal(ghCalls(dir).length, 0);
});

// Compose writes the metadata line first, and the read's filter reads it
// back whole, a heading carrying `-->` included.
test('a filed ledger issue opens with metadata the ledger read reads back', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'FAIL');
  const id = firstId(CI);
  const { spec, heading } = ruleOf(id);
  fragments.forEach((f, i) => writeFileSync(join(dir, f), fragmentText(f, i === 1
    ? { stated: 'FAIL', results: { [id]: `- FAIL: ${id} — c: violated` }, lines: finding('WARNING', './lib/src/b.ts:5', 'paste', 'a paste submits') }
    : {})));
  runReporting(dir, env);
  const filed = ghState(dir).embargo.filter((i) => i.title.startsWith('[audit-finding '));
  assert.equal(filed.length, 2);
  for (const issue of filed) assert.match(issue.body, /^<!-- audit-ledger \{[^\n]*\} -->\n\n/);
  const metas = readFileSync(join(dir, 'audit-ledger-snapshot.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).meta)
    .sort((a, b) => a.severity.localeCompare(b.severity));
  assert.deepEqual(metas, [
    { key: failKeyOf(id), severity: 'FAIL', rule: id, spec, heading, file: null },
    { key: ledgerKey('finding', 'lib/src/b.ts', 'paste'), severity: 'WARNING', rule: null, spec: null, heading: null, file: 'lib/src/b.ts' }]);
  assert.equal(ledgerMeta({ heading: 'a --> b' }), '<!-- audit-ledger {"heading":"a -\\u002d> b"} -->');
});

// The deadline is exactly seven days from the ledger issue's opening.
test('an open finding is due exactly seven days after it was filed', () => {
  const entry = { state: 'OPEN', createdAt: '2026-10-01T04:21:00Z' };
  assert.equal(disclosureReason(entry, new Date('2026-10-08T04:20:59.999Z')), null);
  assert.deepEqual(disclosureReason(entry, new Date('2026-10-08T04:21:00Z')), { kind: 'deadline' });
  assert.deepEqual(disclosureReason({ ...entry, state: 'CLOSED', stateReason: 'NOT_PLANNED' }, new Date('2026-10-01T05:00:00Z')), { kind: 'dismissed' });
  assert.deepEqual(disclosureReason({ ...entry, state: 'CLOSED', stateReason: 'COMPLETED' }, new Date('2026-10-01T05:00:00Z'), 12), { kind: 'fixed', pr: 12 });
  assert.deepEqual(disclosureReason({ ...entry, state: 'CLOSED', stateReason: 'COMPLETED' }, new Date('2026-10-01T05:00:00Z'), null), { kind: 'closed' });
});

/** A passing run over a seeded tracker; pass the `{ dir, env }` it returns to run again over what it left. */
function passOver(t, seed, again = null) {
  const { dir, env } = again ?? fixture(t);
  if (!again) stubGh(dir, seed);
  writeFileSync(join(dir, 'audit-status.txt'), 'PASS');
  fragments.forEach((f) => writeFileSync(join(dir, f), fragmentText(f)));
  return { dir, env, ...runReporting(dir, env) };
}
const disclosures = (dir) => publicIssues(dir, 'security-audit-finding');
const statusComments = (dir) => publicIssues(dir, 'security-audit-status')[0].comments.map((c) => c.body);
const EMBARGO_RULE = sectionIds(CI, 'docs/specs/security-audit.md', 'Embargo')[0];
/** Every row filed relative to one instant, `now`, so a test dates them all from the same clock. */
function DISCLOSURE_SEED(now = Date.now()) {
  const seeded = (number, fields) => ledgerIssue(number, { ...fields, now });
  return {
    pulls: { 77: { merged: true }, 78: { merged: false } },
    embargo: [
      seeded(1, { key: 'aaaaaaaaaaaa', meta: { file: 'scripts/security-audit-report.mjs' }, state: 'CLOSED',
        comments: [maintainer('Fixed in #77'), maintainer('## Public summary\nA paste could submit a command.')] }),
      seeded(2, { key: 'bbbbbbbbbbbb', meta: { file: 'lib/gone.ts' }, state: 'CLOSED', comments: [maintainer('Fixed in #78')] }),
      seeded(3, { key: 'cccccccccccc', state: 'CLOSED', stateReason: 'NOT_PLANNED' }),
      // Filed before its rule moved: the ID places it where the checked-out specs carry it now.
      seeded(4, { key: 'dddddddddddd', severity: 'FAIL', meta: { rule: EMBARGO_RULE, spec: 'docs/specs/security-ci.md', heading: 'GitHub Actions Policies' }, ageDays: 7.01 }),
      // No rule ID: the heading it was filed under, found in the checked-out spec.
      seeded(9, { key: '999999999999', severity: 'FAIL', meta: { spec: 'docs/specs/security-audit.md', heading: 'Disclosure' }, state: 'CLOSED' }),
      seeded(5, { key: 'eeeeeeeeeeee', severity: 'BLOCKER', ageDays: 6.99 }),
      seeded(6, { key: 'ffffffffffff', state: 'CLOSED', comments: [maintainer('Fixed in someone/else#77')] }),
      seeded(7, { key: '777777777777', severity: 'FAIL', meta: { spec: 'docs/specs/security-audit.md', heading: `Run ${EXPLOIT}` }, state: 'CLOSED' }),
      seeded(8, { key: '888888888888', meta: { file: 'scripts/../scripts/security-audit-report.mjs' }, state: 'CLOSED' }),
    ],
  };
}

// A closed ledger issue is public at once and a stale open one after seven
// days; each gets one issue built from validated fields and a maintainer's
// summary, never from the ledger's own text.
test('disclosure publishes fixed, dismissed, and overdue findings from validated fields alone', (t) => {
  const seeded = Date.now();
  const { dir, published } = passOver(t, DISCLOSURE_SEED(seeded));
  const ran = Date.now();
  assert.equal(published.status, 0, published.stderr);
  const byKey = Object.fromEntries(disclosures(dir).map((i) => [i.title.match(/^\[audit-disclosure ([^/\]]+)\/\d+\]/)[1], i]));
  assert.deepEqual(Object.keys(byKey).sort(), ['777777777777', '888888888888', '999999999999', 'aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd', 'ffffffffffff']);
  assert.ok(byKey['999999999999'].body.includes('| Where | `docs/specs/security-audit.md` -> "Disclosure" |'), byKey['999999999999'].body);
  // A heading the checked-out spec lacks, or a path that climbs, is withheld.
  assert.ok(byKey['777777777777'].body.includes('| Where | withheld: the cited spec section is not in the checked-out specs |'), byKey['777777777777'].body);
  assert.ok(byKey['888888888888'].body.includes('| Where | path withheld'), byKey['888888888888'].body);
  const all = { ...byKey };
  delete byKey['777777777777'];
  delete byKey['888888888888'];
  delete byKey['999999999999'];
  assert.deepEqual(Object.values(byKey).map((i) => i.title).sort(), [
    '[audit-disclosure aaaaaaaaaaaa/1] WARNING finding', '[audit-disclosure bbbbbbbbbbbb/2] WARNING finding',
    '[audit-disclosure cccccccccccc/3] WARNING finding', '[audit-disclosure dddddddddddd/4] FAIL failed check', '[audit-disclosure ffffffffffff/6] WARNING finding']);
  const { aaaaaaaaaaaa: fixed, bbbbbbbbbbbb: uncited, cccccccccccc: dismissed, dddddddddddd: overdue } = byKey;
  assert.deepEqual([fixed.state, fixed.stateReason, uncited.state, dismissed.stateReason, overdue.state], ['CLOSED', 'COMPLETED', 'CLOSED', 'NOT_PLANNED', 'OPEN']);
  assert.ok(fixed.body.includes('| Why disclosed | fixed in [#77](https://github.com/fixture/repo/pull/77) |'), fixed.body);
  assert.ok(fixed.body.includes('| Where | `scripts/security-audit-report.mjs` |'), fixed.body);
  assert.ok(fixed.body.includes('### Public summary\n\n_Written by a maintainer._\n\nA paste could submit a command.\n'), fixed.body);
  // An unmerged PR is no fix; a file the tree lacks is withheld.
  assert.ok(uncited.body.includes('| Why disclosed | closed, no fix PR cited |'), uncited.body);
  assert.ok(uncited.body.includes('| Where | path withheld'), uncited.body);
  // Another repository's PR is no fix either, and no metadata names no place.
  assert.ok(byKey.ffffffffffff.body.includes('| Why disclosed | closed, no fix PR cited |'), byKey.ffffffffffff.body);
  assert.ok(dismissed.body.includes('| Why disclosed | dismissed: closed as not planned |'), dismissed.body);
  assert.ok(dismissed.body.includes('| Where | not recorded'), dismissed.body);
  assert.ok(overdue.body.includes('| Why disclosed | 7 days after it was filed, not yet fixed |'), overdue.body);
  assert.ok(overdue.body.includes('| Where | `docs/specs/security-audit.md` -> "Embargo" |'), overdue.body);
  for (const issue of ghState(dir).public) {
    for (const text of [issue.title, issue.body, ...issue.comments.map((c) => c.body)]) {
      assert.ok(!text.includes('calc-injected-7f3a') && !text.includes('title detail') && !text.includes('body detail') && !text.includes('from the body'), text);
    }
  }
  // The status issue lists the one still embargoed, links the disclosed, and
  // says once per disclosure that it happened.
  const body = statusIssueBody(dir);
  // Filing dates come from the seed's one clock; the disclosure is dated by the
  // run's own, read back from its issue, so neither moves if UTC midnight passes.
  assert.ok(body.includes(`| \`eeeeeeeeeeee\` | BLOCKER | finding | ${day(seeded - 6.99 * DAY)} | ${day(seeded + 0.01 * DAY)} |`), body);
  assert.ok(body.includes(`| \`dddddddddddd\` | FAIL | failed check | ${day(seeded - 7.01 * DAY)} | disclosed: #${overdue.number} |`), body);
  const disclosedOn = overdue.body.match(/\| Disclosed \| (\d{4}-\d{2}-\d{2}) \|/)?.[1];
  assert.ok([day(seeded), day(ran)].includes(disclosedOn), overdue.body);
  assert.ok(body.includes(`- #${overdue.number} — \`dddddddddddd\`, FAIL failed check, disclosed ${disclosedOn}, not yet fixed`), body);
  assert.deepEqual(statusComments(dir).sort(), Object.entries(all).map(([key, i]) => `Disclosed: #${i.number}, \`${key}\` (${i.title.split('] ')[1]}).`).sort());
});

// Re-running publishes nothing twice, and a deadline disclosure is closed,
// with its fix, by the first run that sees its ledger issue closed.
test('disclosure is idempotent and closes a deadline disclosure once fixed', (t) => {
  const { dir, env } = passOver(t, DISCLOSURE_SEED());
  const first = { issues: disclosures(dir).length, comments: statusComments(dir).length };
  const calls = ghCalls(dir).length;
  passOver(t, null, { dir, env });
  assert.deepEqual({ issues: disclosures(dir).length, comments: statusComments(dir).length }, first);
  // The second run's only public write is the status issue's body.
  const writes = ghCalls(dir).slice(calls).filter(({ embargo, args }) => !embargo && args[0] === 'issue' && args[1] !== 'list');
  assert.deepEqual(writes.map(({ args }) => args.slice(1, 3)), [['edit', String(publicIssues(dir, 'security-audit-status')[0].number)]]);
  const state = ghState(dir);
  Object.assign(state.embargo.find((i) => i.number === 4), { state: 'CLOSED', stateReason: 'COMPLETED', closedAt: iso(Date.now()) })
    .comments.push(maintainer('Fixed by fixture/repo#77'));
  writeFileSync(join(dir, 'gh-state.json'), JSON.stringify(state));
  const third = passOver(t, null, { dir, env });
  assert.equal(third.published.status, 0, `${third.published.stdout}${third.published.stderr}`);
  const overdue = disclosures(dir).find((i) => i.title.startsWith('[audit-disclosure dddddddddddd/4]'));
  assert.equal(overdue.state, 'CLOSED');
  assert.ok(overdue.body.includes('| Why disclosed | fixed in [#77]'), overdue.body);
  assert.deepEqual({ issues: disclosures(dir).length, comments: statusComments(dir).length }, first);
});

// Subscribers hear of a change, not of every night.
test('the status issue is commented on only when the outcome changes', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir, { public: [{ number: 5, title: 'Security audit status', body: '<!-- security-audit-status outcome=PASS -->\nolder', labels: ['security-audit-status'], state: 'OPEN', comments: [] }] });
  const run = (status) => {
    writeFileSync(join(dir, 'audit-status.txt'), status);
    fragments.forEach((f, i) => writeFileSync(join(dir, f), fragmentText(f, i || status === 'PASS' ? {} : { stated: 'FAIL', results: { [firstId(f)]: `- FAIL: ${firstId(f)} — c: violated` } })));
    runReporting(dir, env);
    return ghState(dir).public[0];
  };
  assert.equal(run('PASS').comments.length, 0);
  const failed = run('FAIL');
  assert.match(failed.comments.at(-1).body, /^The audit's outcome changed from PASS to FAIL at /);
  assert.equal(run('FAIL').comments.length, 1);
  // The FAIL filed a ledger finding this PASS never re-verifies, so it is inconclusive.
  assert.match(run('PASS').comments.at(-1).body, /^The audit's outcome changed from FAIL to INCONCLUSIVE at /);
  assert.equal(ghState(dir).public.length, 1);
});

// A fixed finding that recurs is filed again under its key, as a second ledger
// issue: it is disclosed on its own clock, under its own issue, and the status
// issue never points it at the earlier disclosure.
test('a finding that recurs after its fix is disclosed again, as its own issue', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  const entry = (number, state, createdAt) => ({ number, state, stateReason: state === 'CLOSED' ? 'COMPLETED' : '', createdAt, closedAt: null,
    key: 'aaaaaaaaaaaa', severity: 'WARNING', meta: null, fixed: [], summary: null });
  const fixed = entry(3, 'CLOSED', '2026-10-01T00:00:00Z');
  const recurred = entry(9, 'OPEN', '2026-10-12T00:00:00Z');
  const both = planDisclosures({ ledger: [recurred, fixed], archive: new Map(), now, repo: 'fixture/repo', verify: () => false });
  assert.deepEqual(both.map((a) => a.title).sort(), ['[audit-disclosure aaaaaaaaaaaa/3] WARNING finding', '[audit-disclosure aaaaaaaaaaaa/9] WARNING finding']);
  const archive = new Map([['aaaaaaaaaaaa/3', { number: 40, key: 'aaaaaaaaaaaa', severity: 'WARNING', state: 'CLOSED', createdAt: '2026-10-02T00:00:00Z' }]]);
  const [again] = planDisclosures({ ledger: [recurred, fixed], archive, now, repo: 'fixture/repo', verify: () => false });
  assert.deepEqual([again.type, again.title], ['create', '[audit-disclosure aaaaaaaaaaaa/9] WARNING finding']);
  const body = statusBody({ status: 'PASS', fileStatus: 'PASS', date: '2026-10-13T00:00Z', runUrl: 'https://github.com/fixture/repo/actions/runs/1',
    commit: COMMIT, repo: 'fixture/repo', fragments: {}, embargoResult: 'filed', ledger: [recurred, fixed], archive, now: new Date('2026-10-13T00:00:00Z'), root: repo });
  assert.ok(body.includes('| `aaaaaaaaaaaa` | WARNING | finding | 2026-10-12 | 2026-10-19 |'), body);
});

// The builders' contract, apart from the steps: a hand-filed key is withheld
// until disclosed, a summary is only ever the snapshot's, and a cited PR
// counts only when the API says it merged here.
test('the status builder withholds a hand-filed key and plans no disclosure for an unverified PR', () => {
  const now = new Date('2026-10-11T04:21:00Z');
  const ledger = [{ number: 1, state: 'CLOSED', stateReason: 'COMPLETED', createdAt: '2026-10-10T00:00:00Z', closedAt: null,
    key: 'manual-osc-gate', severity: 'FAIL', meta: null, fixed: [{ repo: null, pr: 5 }], summary: null },
  { number: 2, state: 'OPEN', stateReason: '', createdAt: '2026-10-10T00:00:00Z', closedAt: null,
    key: 'manual-paste-gate', severity: 'WARNING', meta: null, fixed: [], summary: null }];
  const verified = [];
  const [action] = planDisclosures({ ledger, archive: new Map(), now, repo: 'fixture/repo', verify: (pr) => { verified.push(pr); return false; } });
  assert.deepEqual(verified, [5]);
  assert.ok(action.body.includes('| Why disclosed | closed, no fix PR cited |'));
  const body = statusBody({ status: 'PASS', fileStatus: 'PASS', date: '2026-10-11T04:21Z', runUrl: 'https://github.com/fixture/repo/actions/runs/1',
    commit: COMMIT, repo: 'fixture/repo', fragments: {}, embargoResult: 'filed', ledger, archive: new Map(), now, root: repo });
  assert.ok(body.includes('| hand-filed | WARNING | finding | 2026-10-10 | 2026-10-17 |'), body);
  assert.ok(!body.includes('manual-paste-gate'), body);
});

// The titles are embargoed detail: the list step hands them to the agent in
// one file and logs their count, and only after the plan step decides the run
// audits and before the agent starts.
test('the list step writes the open titles to one file and logs only their count', (t) => {
  const order = ['Skip the domains if nothing changed', 'List open findings', 'Audit against the security specs']
    .map((name) => workflow.indexOf(`      - name: ${name}\n`));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), String(order));
  assert.match(stepText('List open findings'), /^        if: steps\.plan\.outputs\.skip != 'true'$/m);
  const { dir, env } = fixture(t);
  stubGh(dir);
  const before = new Set(readdirSync(dir));
  const result = spawnSync('bash', ['-c', runBlock('List open findings')], { cwd: dir, encoding: 'utf8',
    env: { ...env, GH_TOKEN: 'fixture-embargo-token', EMBARGO_REPO, GITHUB_OUTPUT: join(dir, 'github-output'),
      GH_LEDGER_OPEN: `41 [audit-finding 0123456789ab] FAIL: secret detail ${EXPLOIT}\n42 [audit-finding manual-example-gate] FAIL security-ci.md GitHub Actions Policies: more detail\n` } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dir, OPEN_FINDINGS), 'utf8'),
    `[audit-finding 0123456789ab] FAIL: secret detail ${EXPLOIT}\n[audit-finding manual-example-gate] FAIL security-ci.md GitHub Actions Policies: more detail\n`);
  assert.deepEqual(readdirSync(dir).filter((f) => !before.has(f)).sort(), ['gh-calls.jsonl', OPEN_FINDINGS].sort());
  assert.equal(`${result.stdout}${result.stderr}`, '2 open finding(s) for the domains to re-verify.\n');
  assert.ok(ghCalls(dir).every(({ args, embargo }) => embargo && args.slice(0, 2).join(' ') === 'issue list'));
  // Without the token it reads nothing and writes no file, which holds every domain at INCONCLUSIVE.
  rmSync(join(dir, OPEN_FINDINGS));
  rmSync(join(dir, 'gh-calls.jsonl'));
  const missing = spawnSync('bash', ['-c', runBlock('List open findings')], { cwd: dir, encoding: 'utf8',
    env: { ...env, GH_TOKEN: '', EMBARGO_REPO, GITHUB_OUTPUT: join(dir, 'github-output') } });
  assert.equal(missing.status, 1);
  assert.ok(!existsSync(join(dir, OPEN_FINDINGS)) && ghCalls(dir).length === 0);
});

// Every path the transcript artifact uploads is age ciphertext, and the
// upload runs only when the encryption step succeeded.
test('the transcript artifact uploads ciphertext only', () => {
  const upload = stepText('Archive audit transcript');
  const paths = upload.match(/^          path: (.+)$/m)?.[1];
  assert.ok(paths && !paths.startsWith('|'), 'expected a single upload path');
  assert.match(paths, /\.age$/);
  assert.match(upload, /^        if: always\(\) && steps\.encrypt\.outcome == 'success'$/m);
  assert.match(stepText('Encrypt the audit transcript'), /^        id: encrypt$/m);
});

/** A fake `age` that marks its output and copies stdin, or fails half-way through when `AGE_FAIL` is set. */
function stubAge(dir) {
  stub(dir, 'age', `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const recipients = args[args.indexOf('-R') + 1];
    if (!fs.readFileSync(recipients, 'utf8').includes('age15aqsn6kx3eckj70cxf4l8072fefzd6sskzk9akvfp6m9fcwrsgsqs6valr')) process.exit(3);
    const out = args[args.indexOf('-o') + 1];
    fs.writeFileSync(out, 'age-encryption.org/v1\\n');
    if (process.env.AGE_FAIL) process.exit(1);
    fs.appendFileSync(out, fs.readFileSync(0));
  `);
  stub(dir, 'sudo', 'process.exit(0);');
}

test('the transcript is archived as age ciphertext holding every sink', (t) => {
  const { dir, env } = fixture(t);
  stubAge(dir);
  for (const sink of archivedSinks) writeFileSync(join(dir, sink), `plaintext of ${sink}`);
  const result = spawnSync('bash', ['-c', runBlock('Encrypt the audit transcript')], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const out = join(dir, 'audit-transcript.tar.gz.age');
  const sealed = readFileSync(out);
  assert.ok(sealed.toString('latin1').startsWith('age-encryption.org/v1\n'));
  const tarball = join(dir, 'archive.tar.gz');
  writeFileSync(tarball, sealed.subarray('age-encryption.org/v1\n'.length));
  const listed = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).stdout.split('\n')
    .map((f) => f.replace(/^\.\//, '')).filter(Boolean).sort();
  assert.deepEqual(listed, [...archivedSinks].sort());
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.partial')), []);
});

test('a failed encryption leaves nothing to upload and fails the step', (t) => {
  const { dir, env } = fixture(t);
  stubAge(dir);
  for (const sink of archivedSinks) writeFileSync(join(dir, sink), `plaintext of ${sink}`);
  const result = spawnSync('bash', ['-c', runBlock('Encrypt the audit transcript')], { cwd: dir, env: { ...env, AGE_FAIL: '1' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('audit-transcript')), []);
});

// 'FAIL — explained' pins the grammar against CI's: an appended explanation is
// still a finding, not an unreadable fragment. Status alone cannot tell the two
// apart (both exit 1), so that row also checks the message.
// The `false` rows write no sentinel: the local runner rejects a fragment its
// domain stopped short of finishing, exactly as CI's reporting step does, so a
// PASS on line 1 of a cut-off report does not exit zero here either.
/**
 * A stand-in for `scripts/github-state-check.mjs` in the local runner's tree:
 * it writes the fragment `FAKE_STATE_VERDICT` names, and refuses to run
 * without `--local`, which keeps a 403 on the operator's login from reading as
 * CI PAT drift.
 */
/** The local runner, the prompt files it reads, and the stand-in check, in a fixture tree. */
function localRunnerFixture(dir) {
  copyFileSync(join(repo, 'scripts/security-audit-local.sh'), join(dir, 'scripts/security-audit-local.sh'));
  for (const name of ['_preamble', 'orchestrator', 'supply-chain', 'ci-and-secrets', 'remote', 'local', 'hosted']) {
    copyFileSync(join(repo, `.github/audit/${name}.md`), join(dir, `.github/audit/${name}.md`));
  }
  fakeStateCheck(dir);
}

function fakeStateCheck(dir) {
  const texts = { PASS: fragmentText(STATE_FRAGMENT), FAIL: STATE_FAIL,
    INCONCLUSIVE: fragmentText(STATE_FRAGMENT, { stated: 'INCONCLUSIVE', drop: [VSCODE_RULE] }) };
  writeFileSync(join(dir, 'scripts/github-state-check.mjs'), `
    import { appendFileSync, writeFileSync } from 'node:fs';
    if (!process.argv.includes('--local')) process.exit(9);
    appendFileSync('state-check-calls', 'called\\n');
    writeFileSync(process.argv[process.argv.indexOf('--out') + 1], ${JSON.stringify(texts)}[process.env.FAKE_STATE_VERDICT ?? 'PASS']);
  `);
}

// The `drop` row is CI's computed verdict reaching the local runner: a
// fragment that says PASS over a skipped rule does not exit zero here either.
for (const [verdict, cliExit, expected, sentinel = true, stateVerdict = 'PASS', drop = false] of [['PASS', 0, 0], ['FAIL', 0, 1], ['FAIL \u2014 explained', 0, 1], ['INCONCLUSIVE', 0, 1], ['PASS extra', 0, 1], ['PASS', 7, 1], ['PASS', 0, 1, false], ['FAIL', 0, 1, false], ['PASS', 0, 1, true, 'FAIL'], ['PASS', 0, 1, true, 'INCONCLUSIVE'], ['PASS', 0, 1, true, 'PASS', true]]) {
  test(`local runner: ${verdict}, CLI exit ${cliExit}${sentinel ? '' : ', no sentinel'}${stateVerdict === 'PASS' ? '' : `, GitHub state ${stateVerdict}`}${drop ? ', a rule skipped' : ''}`, (t) => {
    const { dir, env: base } = fixture(t);
    const env = { ...base, FAKE_STATE_VERDICT: stateVerdict };
    localRunnerFixture(dir);
    stubGh(dir);
    stub(dir, 'claude', `
      const fs = require('node:fs');
      const prompt = process.argv[3];
      const output = prompt.match(/\\*\\*Output file:\\*\\* \\x60([^\\x60]+)\\x60/)[1];
      fs.writeFileSync(output, ${JSON.stringify(Object.fromEntries(fragments.map((f) => [f, fragmentText(f, { stated: verdict, sentinel, drop: drop ? [firstId(f)] : [] })])))}[output]);
      process.exit(${cliExit});
    `);
    // The all-domains path calls run_domain in a conditional: Bash disables
    // errexit inside it, so a failed CLI needs an explicit return.
    const result = spawnSync('bash', ['scripts/security-audit-local.sh'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
    if (verdict === 'FAIL') {
      assert.ok(!result.stderr.includes('first line is not a verdict'), result.stderr);
      // A dissent is reported as one whether or not the fragment finished.
      assert.match(result.stderr, /says `VERDICT: FAIL/);
    }
    // Only the exact line is a verdict: an appended explanation makes it unreadable.
    if (verdict.startsWith('FAIL ')) assert.match(result.stderr, /first line is not a verdict/);
    if (!sentinel) assert.match(result.stderr, /never wrote its sentinel/);
    for (const fragment of allFragments) assert.ok(existsSync(join(dir, fragment)), fragment);
    assert.equal(readFileSync(join(dir, STATE_FRAGMENT), 'utf8').split('\n')[0], `VERDICT: ${stateVerdict}`);
    // Local output stays local: the runner reads the ledger and files nothing, anywhere.
    assert.deepEqual(ghCalls(dir).map(({ args }) => args.slice(0, 2).join(' ')), ['issue list']);
  });
}

// One domain at a time: the deterministic check runs ahead of the two domains
// that read its fragment, alone on request, and not before the others.
for (const [arg, runsState, runsDomain] of [['github-state', true, false], ['ci-and-secrets', true, true], ['supply-chain', true, true], ['remote', false, true], ['local', false, true], ['hosted', false, true]]) {
  test(`local runner: \`${arg}\` ${runsState ? 'runs' : 'skips'} the GitHub-state check`, (t) => {
    const { dir, env } = fixture(t);
    rmSync(join(dir, STATE_FRAGMENT));
    localRunnerFixture(dir);
    stubGh(dir);
    stub(dir, 'claude', `
      const fs = require('node:fs');
      const output = process.argv[3].match(/\\*\\*Output file:\\*\\* \\x60([^\\x60]+)\\x60/)[1];
      fs.writeFileSync(output, ${JSON.stringify(Object.fromEntries(fragments.map((f) => [f, fragmentText(f)])))}[output]);
      fs.appendFileSync('claude-calls', output + '\\n');
    `);
    const result = spawnSync('bash', ['scripts/security-audit-local.sh', arg], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dir, 'state-check-calls')), runsState);
    assert.equal(existsSync(join(dir, 'claude-calls')), runsDomain);
  });
}

// The second-opinion audit: the same prompts on Codex, each domain's computed verdict
// gathered into the publishing command, which is printed and never run.
for (const [args, verdicts, expected] of [[['remote'], 'remote=PASS', 0], [[], 'supply-chain=PASS ci-and-secrets=PASS remote=PASS local=INCONCLUSIVE hosted=PASS', 1]]) {
  test(`local runner, Codex engine: ${args[0] ?? 'every domain'}`, (t) => {
    const { dir, env } = fixture(t);
    localRunnerFixture(dir);
    stubGh(dir);
    stub(dir, 'claude', 'process.exit(5);');
    // `local` leaves no fragment, which computes INCONCLUSIVE.
    stub(dir, 'codex', `
      const fs = require('node:fs');
      const argv = process.argv.slice(2);
      const output = argv[argv.length - 1].match(/\\*\\*Output file:\\*\\* \\x60([^\\x60]+)\\x60/)[1];
      if (output !== 'audit-local.md') fs.writeFileSync(output, ${JSON.stringify(Object.fromEntries(fragments.map((f) => [f, fragmentText(f)])))}[output]);
    `);
    const result = spawnSync('bash', ['scripts/security-audit-local.sh', '--engine', 'codex', ...args], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
    assert.match(result.stdout, new RegExp(`^gh workflow run codex-audit-report\\.yaml -R fixture/repo --ref main -f commit=\\S+ -f model=gpt-6-sol -f verdicts='${verdicts}'$`, 'm'));
    assert.deepEqual(ghCalls(dir).map(({ args: a }) => a.slice(0, 2).join(' ')).filter((c) => c !== 'issue list'), []);
  });
}

// A list written on another login: the domains read it, and the ledger is
// never listed, so this run's `gh` login needs no read on it.
test('local runner: AUDIT_OPEN_FINDINGS hands the domains a file, and the ledger is not read', (t) => {
  const { dir, env } = fixture(t);
  localRunnerFixture(dir);
  stubGh(dir);
  const title = '[audit-finding 0123456789ab] FAIL S9: from the file';
  mkdirSync(join(dir, 'elsewhere'));
  writeFileSync(join(dir, 'elsewhere/open.txt'), `${title}\n`);
  stub(dir, 'codex', `
    const fs = require('node:fs');
    const argv = process.argv.slice(2);
    const output = argv[argv.length - 1].match(/\\*\\*Output file:\\*\\* \\x60([^\\x60]+)\\x60/)[1];
    fs.writeFileSync('seen-open-findings', fs.readFileSync('audit-open-findings.txt'));
    fs.writeFileSync(output, ${JSON.stringify(Object.fromEntries(fragments.map((f) => [f, fragmentText(f)])))}[output]);
  `);
  // A relative path is the operator's, from where they ran the script.
  const result = spawnSync('bash', ['../scripts/security-audit-local.sh', '--engine', 'codex', 'remote'],
    { cwd: join(dir, 'elsewhere'), env: { ...env, AUDIT_OPEN_FINDINGS: 'open.txt', GH_LEDGER_OPEN: '7 [audit-finding ba9876543210] FAIL S5: from the ledger' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dir, 'seen-open-findings'), 'utf8'), `${title}\n`);
  assert.equal(existsSync(join(dir, 'gh-calls.jsonl')) ? readFileSync(join(dir, 'gh-calls.jsonl'), 'utf8') : '', '');

  const missing = spawnSync('bash', ['scripts/security-audit-local.sh', '--engine', 'codex', 'remote'],
    { cwd: dir, env: { ...env, AUDIT_OPEN_FINDINGS: 'nowhere.txt' }, encoding: 'utf8' });
  assert.equal(missing.status, 64);
  assert.match(missing.stderr, /AUDIT_OPEN_FINDINGS names no file: nowhere\.txt/);
});

test('local runner: an unknown engine is refused before anything runs', (t) => {
  const { dir, env } = fixture(t);
  localRunnerFixture(dir);
  const result = spawnSync('bash', ['scripts/security-audit-local.sh', '--engine', 'gemini'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /unknown engine 'gemini'/);
});

// The orchestrator prompt's two sanctioned shell blocks, executed as shipped.
// They are the only place that decides whether a domain reported, and prose is
// not a control: run 35205193090 merged a fragment its domain was still
// filling in, because the predicate then was the file's existence.
const orchestrator = readFileSync(join(repo, '.github/audit/orchestrator.md'), 'utf8');

/** A fenced `sh` block from a prompt file, chosen by a string it contains. */
function promptShellBlock(markdown, containing) {
  const blocks = [...markdown.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
  const hit = blocks.filter((b) => b.includes(containing));
  assert.equal(hit.length, 1, `expected exactly one \`sh\` block containing ${containing}`);
  return hit[0];
}

// The producer side. Every consumer below is pinned by executing the shipped
// text, but the literal the domains are told to write lives only in
// `_preamble.md` — so without this the producer could be renamed and the whole
// suite would stay green against a sentinel nothing writes.
test('the preamble tells domains to write the sentinel every reader waits for', () => {
  const preamble = readFileSync(join(repo, '.github/audit/_preamble.md'), 'utf8');
  const written = [...preamble.matchAll(/^printf '[^']*' >> <your fragment>$/gm)];
  assert.equal(written.length, 1, 'expected exactly one closing `printf` in the preamble');
  assert.match(written[0][0], new RegExp(SENTINEL.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&')));
});
// The delegation wait. The orchestrator carries this rule for itself in §2,
// but a domain is given `_preamble.md` plus its own file and never reads that
// one — so run 35327271988's `application-security` backgrounded its wait loop,
// ended its turn, and lost four work streams that finished before the deadline.
// The prose half is pinned as text: the rule, the backgrounding ban, the Bash
// timeout without which every call is backgrounded anyway, and the two
// properties of its deadline. Every domain shares one `$RUNNER_TEMP`, so a
// fixed deadline file would make whichever domain delegates first set the bound
// for all of them; and the bound that has to hold is the caller's, which is
// already on disk at the path §2 persists it to.
test('the preamble forbids a delegating domain from waiting by ending its turn', () => {
  const preamble = readFileSync(join(repo, '.github/audit/_preamble.md'), 'utf8');
  assert.match(preamble, /never end your turn to wait/i);
  assert.match(preamble, /never\s+with `run_in_background`/);
  assert.match(preamble, /`timeout: 600000`/);
  assert.match(preamble, /^DEADLINE_FILE="\$RUNNER_TEMP\/delegate-deadline-<your fragment>"$/m);
  assert.match(preamble, /^\s*CALLER=\$\(cat "\$RUNNER_TEMP\/audit-deadline"/m);
});

// And run it: the regexes above pin the rule's wording, not the bound. Filling
// the block's two placeholders makes it the same runnable text §2's wait is
// tested as, which is what catches the margin pointing the wrong way or the
// `DEADLINE` break going missing.
test('the delegate wait bounds itself by its caller\'s deadline', (t) => {
  const block = promptShellBlock(readFileSync(join(repo, '.github/audit/_preamble.md'), 'utf8'), 'delegate-deadline-')
    .replace('<your fragment>', 'audit-local.md')
    .replace("<every delegated stream's .done file exists>", '[ -f delegates-done ]');
  const runDelegateWait = (caller, done) => {
    const dir = tempDir(t, 'dormouse-audit-delegate-');
    if (caller !== undefined) writeFileSync(join(dir, 'audit-deadline'), `${caller}\n`);
    if (done) writeFileSync(join(dir, 'delegates-done'), '');
    const r = spawnSync('bash', ['-c', block], { cwd: dir, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: dir }, timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr);
    return { answer: r.stdout.trim().split('\n').at(-1),
      persisted: Number(readFileSync(join(dir, 'delegate-deadline-audit-local.md'), 'utf8')) };
  };
  const now = Math.floor(Date.now() / 1000);
  // The caller's own bound, three minutes early — not the domain's own clock.
  assert.deepEqual(runDelegateWait(now + 1920, true), { answer: 'ALL FINISHED', persisted: now + 1920 - 180 });
  // No caller deadline on disk yet: 25 minutes from here, give or take the
  // second the shell's `date` may have ticked past `now`.
  const fallback = runDelegateWait(undefined, true).persisted - now;
  assert.ok(fallback === 1500 || fallback === 1501, `fallback deadline was now + ${fallback}`);
  // An expired caller means stop now and write up, not wait out the call cap.
  assert.equal(runDelegateWait(now - 1, false).answer, 'DEADLINE');
});

const finishedFn = orchestrator.match(/^finished\(\) \{.*$/m)[0];

for (const [name, body, expected] of [
  ['missing', null, false],
  ['empty', '', false],
  ['still being filled in', 'VERDICT: INCONCLUSIVE\n\n### FAIL IF results\n\n- one check\n', false],
  ['sentinel not on the last line', `VERDICT: PASS\n${SENTINEL}\ntrailing\n`, false],
  ['finished', `VERDICT: PASS\n\n${SENTINEL}\n`, true],
  // A domain that appends one more newline has still finished. Read as cut off,
  // this would report the very bug the sentinel exists to catch.
  ['finished with trailing blank lines', `VERDICT: PASS\n\n${SENTINEL}\n\n\n`, true],
]) {
  test(`orchestrator wait predicate: ${name}`, (t) => {
    const dir = tempDir(t, 'dormouse-audit-wait-');
    if (body !== null) writeFileSync(join(dir, 'audit-local.md'), body);
    const result = spawnSync('bash', ['-c', `${finishedFn}\nfinished audit-local.md && echo YES || echo NO`],
      { cwd: dir, encoding: 'utf8' });
    assert.equal(result.stdout.trim(), expected ? 'YES' : 'NO', result.stderr);
  });
}

// The whole wait block, with only its per-call cap and poll interval shrunk so
// a nine-minute call takes a second. Each substitution must hit exactly once,
// so a reshaped block fails here rather than running unshrunk.
const waitBlock = [[/\+ 540 \)\)/g, '+ 1 ))'], [/sleep 10$/gm, 'sleep 0.1']].reduce((block, [from, to]) => {
  assert.equal(block.match(from)?.length, 1, `expected exactly one ${from} in the wait block`);
  return block.replace(from, to);
}, promptShellBlock(orchestrator, 'audit-deadline'));

/** Runs the wait block in a fresh fragment dir; `deadline` pre-seeds the persisted file. */
function runWait(t, { finished = [], writing = [], deadline } = {}) {
  const dir = tempDir(t, 'dormouse-audit-wait-');
  for (const f of finished) writeFileSync(join(dir, f), `VERDICT: PASS\n\n${SENTINEL}\n`);
  for (const f of writing) writeFileSync(join(dir, f), 'VERDICT: INCONCLUSIVE\n\n### FAIL IF results\n\n');
  if (deadline !== undefined) writeFileSync(join(dir, 'audit-deadline'), `${deadline}\n`);
  const result = spawnSync('bash', ['-c', waitBlock], { cwd: dir, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: dir }, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trim().split('\n');
  return { dir, lines, answer: lines.at(-1), persisted: Number(readFileSync(join(dir, 'audit-deadline'), 'utf8')) };
}
const now = () => Math.floor(Date.now() / 1000);

// Run 34581574869: a call that outlived the Bash cap returned nothing to act on.
test('orchestrator wait: a call with nothing reported ends itself and says so', (t) => {
  const before = now();
  const { lines, answer, persisted } = runWait(t);
  assert.equal(answer, 'STILL WAITING');
  assert.deepEqual(lines.slice(0, -1), fragments.map((f) => `${f}: not started`));
  // Persisted on the first call, 32 minutes out.
  assert.ok(persisted >= before + 1920 && persisted <= now() + 1920, String(persisted));
});

// Appended fragments exist long before they are finished; existence must not end the wait.
test('orchestrator wait: fragments still being written keep the wait going', (t) => {
  const [first, ...rest] = fragments;
  const { lines, answer } = runWait(t, { finished: [first], writing: rest });
  assert.equal(answer, 'STILL WAITING');
  assert.deepEqual(lines.slice(0, -1), [`${first}: finished`, ...rest.map((f) => `${f}: still writing`)]);
});

// One domain still writing keeps the wait going, whichever one it is. The
// wait block's per-domain status lines are pinned to `AUDIT_FRAGMENTS`; its
// `until` predicate is not, so a fragment dropped from that predicate would
// let the orchestrator merge and publish while that domain was still writing.
for (const held of fragments) {
  test(`orchestrator wait: ${held} alone unfinished keeps the wait going`, (t) => {
    const { answer } = runWait(t, { finished: fragments.filter((f) => f !== held), writing: [held] });
    assert.equal(answer, 'STILL WAITING');
  });
}

test('orchestrator wait: a re-issued call reads back the persisted deadline', (t) => {
  const deadline = now() + 600;
  const { answer, persisted } = runWait(t, { deadline });
  assert.equal(answer, 'STILL WAITING');
  assert.equal(persisted, deadline);
});

test('orchestrator wait: a passed deadline ends the wait', (t) => {
  const { answer } = runWait(t, { writing: fragments, deadline: now() - 1 });
  assert.equal(answer, 'DEADLINE');
});

test('orchestrator wait: every domain finished ends the wait', (t) => {
  const { lines, answer } = runWait(t, { finished: fragments, deadline: now() - 1 });
  assert.equal(answer, 'ALL FINISHED');
  assert.deepEqual(lines.slice(0, -1), fragments.map((f) => `${f}: finished`));
});

const merge = promptShellBlock(orchestrator, 'audit-report.md');

test('merge distinguishes finished, cut-off, and absent domains', (t) => {
  const dir = tempDir(t, 'dormouse-audit-merge-');
  // The trailing blank line is what pins `emit` to the last non-blank line: on
  // exact `tail -n1` this finished domain is published under the cut-off caveat.
  writeFileSync(join(dir, 'audit-supply-chain.md'), `VERDICT: PASS\nsupply evidence\n\n${SENTINEL}\n\n`);
  writeFileSync(join(dir, 'audit-ci-secrets.md'), 'VERDICT: INCONCLUSIVE\nci evidence\n');
  writeFileSync(join(dir, 'audit-local.md'), `VERDICT: PASS\nlocal evidence\n${SENTINEL}\n`);
  writeFileSync(join(dir, 'audit-hosted.md'), `VERDICT: PASS\nhosted evidence\n${SENTINEL}\n`);
  const result = spawnSync('bash', ['-c', merge], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = readFileSync(join(dir, 'audit-report.md'), 'utf8');

  // A finished domain is rendered with no caveat.
  assert.match(report, /## Supply chain\n\nVERDICT: PASS\nsupply evidence/);
  // A domain cut off mid-report keeps its findings and is labelled as partial,
  // above its own text so the caveat cannot be read as part of the report.
  assert.match(report, /## CI and secrets\n\n_Incomplete —[^\n]*\nVERDICT: INCONCLUSIVE\nci evidence/);
  assert.equal(report.match(/_Incomplete —/g).length, 1);
  // A domain that never wrote anything is neither.
  assert.match(report, /## Remote control\n\n_No report —/);
  // The domains after it are emitted too — a heading dropped from `emit` would
  // silently publish a report missing a domain that did report.
  assert.match(report, /## Local application\n\nVERDICT: PASS\nlocal evidence/);
  assert.match(report, /## Hosted accounts\n\nVERDICT: PASS\nhosted evidence/);
});

// "Orchestration": the orchestrator reads a verdict from, and merges, each
// domain prompt's fragment; that `AUDIT_FRAGMENTS` names each and the wait
// holds for each is pinned above. A domain missing from either is a report
// nobody publishes.
test('every domain\'s fragment is expected and merged', (t) => {
  const verdicts = promptShellBlock(orchestrator, 'security-audit-report.mjs check').match(/^for f in (.+); do$/m)[1].split(' ');
  const dir = tempDir(t, 'dormouse-audit-merge-');
  for (const { fragment } of domains(repo)) writeFileSync(join(dir, fragment), `VERDICT: PASS\n${fragment} evidence\n${SENTINEL}\n`);
  assert.equal(spawnSync('bash', ['-c', merge], { cwd: dir }).status, 0);
  const report = readFileSync(join(dir, 'audit-report.md'), 'utf8');
  for (const { fragment } of domains(repo)) {
    assert.ok(verdicts.includes(fragment), `${fragment}: no verdict read`);
    assert.ok(report.includes(`\n\nVERDICT: PASS\n${fragment} evidence\n`), `${fragment}: not merged`);
  }
  assert.equal(report.match(/^## /gm).length, domains(repo).length);
});

// --- docs/specs/security-audit.md's textual rules about the workflow and prompts ---

const release = readFileSync(join(repo, '.github/workflows/release.yml'), 'utf8');
const local = readFileSync(join(repo, 'scripts/security-audit-local.sh'), 'utf8');
const agents = JSON.parse(stepText('Audit against the security specs').match(/--agents '(.+)'$/m)[1]);
const DOMAINS = ['supply-chain', 'ci-and-secrets', 'remote', 'local', 'hosted'];

// "Schedule and gate": nightly and on dispatch, and three separate things make
// it the release gate — the dispatch, the failing watch, and the `needs:` edge.
test('the audit runs nightly and on dispatch, and gates the VS Code publish', () => {
  // The weekly canary's line follows; scripts/security-audit-canary.test.mjs owns it.
  assert.match(workflow, /^on:\n  schedule:\n    - cron: "21 4 \* \* \*"\n(?:    - cron: .+\n)*  workflow_dispatch:\n/m);
  const gate = workflowRunBlock(release, 'Dispatch security audit and gate on its result').replace(/^\s*#.*$/gm, '');
  assert.match(gate, /^set -euo pipefail$/m);
  assert.match(gate, /^workflow="security-audit\.yaml"$/m);
  assert.match(gate, /^gh workflow run "\$workflow" -R "\$repo" --ref "\$tag"$/m);
  assert.match(gate, /^gh run watch "\$run_id" -R "\$repo" --exit-status$/m);
  const publish = release.slice(release.indexOf('\n  publish-vscode:\n'));
  assert.match(publish, /^    needs:\n(?:      - .+\n)*      - security-audit\n/m);
});

// "Findings ledger": one audit job at a time, so no two runs file or publish
// at once, and a queued run, the release gate's included, waits rather than
// being dropped.
test('audit jobs run one at a time and every queued run is kept', () => {
  const doc = YAML.parse(workflow);
  assert.equal(doc.concurrency, undefined, 'a workflow-level group would hold the canary too and queue the default way');
  const { group, ...rest } = doc.jobs.audit.concurrency ?? {};
  assert.ok(typeof group === 'string' && group && !group.includes('${{'), `the audit job's group is one fixed name for every run: ${group}`);
  assert.deepEqual(rest, { queue: 'max', 'cancel-in-progress': false });
  const steps = doc.jobs.audit.steps.map((step) => step.name);
  for (const name of ['File embargoed findings', 'Publish the audit status']) assert.ok(steps.includes(name), name);
  assert.equal(doc.jobs.canary.concurrency, undefined);
});

// "Domains": the code-reading domains on Opus, the mechanical ones on the
// Sonnet floor, in CI and in the local runner alike; every prompt file either
// names exists, and both read the same files.
test('the model split holds in CI and locally, over the same prompt files', () => {
  assert.match(stepText('Audit against the security specs'), /^            --model sonnet$/m);
  assert.deepEqual(Object.keys(agents).sort(), [...DOMAINS].sort());
  for (const domain of DOMAINS) {
    assert.equal(agents[domain].model, ['remote', 'local', 'hosted'].includes(domain) ? 'opus' : undefined, domain);
    assert.ok(agents[domain].prompt.includes(`\`.github/audit/${domain}.md\``), domain);
  }
  for (const file of [...JSON.stringify(agents).matchAll(/\.github\/audit\/([\w-]+\.md)/g)].map((m) => m[1]).concat('orchestrator.md')) {
    assert.ok(existsSync(join(repo, '.github/audit', file)), file);
  }
  assert.match(local, /^  local model_args="--model sonnet"$/m);
  assert.match(local, /^  case "\$domain" in remote\|local\|hosted\) model_args="--model opus" ;; esac$/m);
  assert.match(local, /^for f in _preamble orchestrator supply-chain ci-and-secrets remote local hosted; do$/m);
  assert.match(local, /cat "\$AUDIT_DIR\/_preamble\.md"; echo; cat "\$AUDIT_DIR\/\$domain\.md"/);
});

// "Second-opinion audit": the Codex engine is pinned and sandboxed, and its report
// workflow publishes only what its builder checked, for an admin, from main.
const codexWorkflow = readFileSync(join(repo, '.github/workflows/codex-audit-report.yaml'), 'utf8');

test('the second-opinion audit runs sandboxed on its pinned model and program, and gates nothing', () => {
  assert.match(local, /^CODEX_MODEL=gpt-6-sol$/m);
  assert.match(local, /^CODEX_PROGRAM=daybreak_blue$/m);
  const exec = local.match(/codex exec [^\n]*\\\n[^\n]*/)?.[0] ?? '';
  assert.match(exec, /-m "\$CODEX_MODEL" --cyber-access-program "\$CODEX_PROGRAM"/);
  assert.match(exec, /--sandbox workspace-write /);
  assert.doesNotMatch(local, /danger-full-access|dangerously-bypass/);
  // The release gate lists runs of security-audit.yaml alone.
  assert.doesNotMatch(release, /codex/i);
  const doc = YAML.parse(codexWorkflow);
  assert.deepEqual(Object.keys(doc.on), ['workflow_dispatch']);
  assert.deepEqual(doc.permissions, {});
  assert.deepEqual(Object.keys(doc.jobs), ['publish']);
  assert.deepEqual(doc.jobs.publish.permissions, { contents: 'read', issues: 'write', actions: 'read' });
  assert.equal(doc.jobs.publish.environment, undefined);
  assert.doesNotMatch(codexWorkflow, /secrets\./);
  const steps = doc.jobs.publish.steps;
  for (const step of steps) assert.doesNotMatch(step.run ?? '', /\$\{\{/, `${step.name ?? step.uses} interpolates into its script`);
  assert.equal(steps[0].name, 'Refuse any ref but main');
  for (const [ref, status] of [['refs/heads/main', 0], ['refs/tags/v1.2.3', 1], ['refs/heads/feature', 1]]) {
    assert.equal(spawnSync('bash', ['-c', steps[0].run], { env: { ...process.env, GITHUB_REF: ref } }).status, status, ref);
  }
  const posting = steps.filter((step) => /\bgh\b|security-audit-public-body/.test(step.run ?? ''));
  assert.deepEqual(posting.map((step) => step.name), ['Publish the second-opinion report']);
  assert.match(posting[0].run, /node scripts\/security-audit-public-body\.mjs --engine codex /);
  assert.equal(doc.jobs.publish.steps.find((step) => step.uses?.startsWith('actions/checkout@')).with['persist-credentials'], false);
});

/** The builder's second-opinion path in a fixture tree, over a `gh` stub answering what it reads. */
function codexFixture(t, { role = 'admin', compare = 'ahead', run = {}, record = {} } = {}) {
  const { dir, env } = fixture(t);
  copyFileSync(join(repo, 'scripts/security-audit-canary.mjs'), join(dir, 'scripts/security-audit-canary.mjs'));
  mkdirSync(join(dir, 'website/scripts'), { recursive: true });
  copyFileSync(join(repo, 'website/scripts/generate-canary-recall.js'), join(dir, 'website/scripts/generate-canary-recall.js'));
  const claudeRun = { display_title: 'security-audit canary (recall measurement, not an audit)', head_branch: 'main',
    path: '.github/workflows/security-audit.yaml', head_repository: { full_name: 'fixture/repo' }, head_sha: COMMIT, ...run };
  const canaryRecall = { seeded: 8, caught: 6, unfinished: 0, run_url: 'https://github.com/diffplug/dormouse/actions/runs/77', ...record };
  stub(dir, 'gh', `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
    fs.appendFileSync('gh-calls.jsonl', JSON.stringify({ args, body: opt('--body-file') && fs.readFileSync(opt('--body-file'), 'utf8') }) + '\\n');
    const path = args[0] === 'api' ? args[1] : '';
    if (/\\/collaborators\\/[^/]+\\/permission$/.test(path)) process.stdout.write(${JSON.stringify(role)} + '\\n');
    else if (/\\/compare\\//.test(path)) process.stdout.write(JSON.stringify({ status: ${JSON.stringify(compare)} }));
    else if (/\\/actions\\/runs\\/77$/.test(path)) process.stdout.write(${JSON.stringify(JSON.stringify(claudeRun))});
    else if (args[0] === 'run' && args[1] === 'download') fs.writeFileSync(opt('-D') + '/canary-recall.json', ${JSON.stringify(JSON.stringify(canaryRecall))});
    else if (args[0] === 'issue' && args[1] === 'list') process.stdout.write(JSON.stringify([{ number: 9 }, { number: 4 }]));
    else if (!(args[0] === 'issue' && args[1] === 'comment')) process.exit(3);
  `);
  return { dir, env: { ...env, GITHUB_TRIGGERING_ACTOR: 'maintainer' } };
}

const CODEX_ARGS = ['--engine', 'codex', '--date', '2026-10-20T12:00Z', '--run-url', 'https://github.com/fixture/repo/actions/runs/5',
  '--commit', COMMIT, '--model', 'gpt-6-sol', '--verdicts', 'remote=PASS local=FAIL', '--canary-run', '77', '--canary-seeded', '8',
  '--canary-caught', '5', '--canary-either', '7', '--canary-unfinished', '0', '--record', 'codex-recall.json'];
const runCodex = (dir, env, args = CODEX_ARGS) => spawnSync(process.execPath, ['scripts/security-audit-public-body.mjs', ...args], { cwd: dir, env, encoding: 'utf8' });
const withArg = (name, value) => CODEX_ARGS.map((a, i) => (CODEX_ARGS[i - 1] === name ? value : a));

test('the second-opinion report comments once on the status issue and writes its recall record', (t) => {
  const { dir, env } = codexFixture(t);
  const result = runCodex(dir, env);
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(join(dir, 'gh-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const writes = calls.filter(({ args }) => args[0] === 'issue' && args[1] !== 'list');
  assert.deepEqual(writes.map(({ args }) => args.slice(0, 3)), [['issue', 'comment', '4']]);
  assert.match(writes[0].body, /^<!-- codex-audit-report -->\n/);
  assert.match(writes[0].body, /Claude caught 6 of 8 \(75%\), Codex 5 \(63%\), and the two together 7 \(88%\)\./);
  assert.match(writes[0].body, /\| `local` \| FAIL \|/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'codex-recall.json'), 'utf8')), {
    claude_run_url: 'https://github.com/fixture/repo/actions/runs/77', commit: COMMIT, model: 'gpt-6-sol',
    seeded: 8, caught: 5, either: 7, unfinished: 0, run_url: 'https://github.com/fixture/repo/actions/runs/5' });
});

// Published without Claude's scorecard: the either count is not computed,
// which the record keeps as null and the comment says, never as zero.
test('the second-opinion report publishes a canary whose either count was not computed', (t) => {
  const { dir, env } = codexFixture(t);
  const result = runCodex(dir, env, withArg('--canary-either', ''));
  assert.equal(result.status, 0, result.stderr);
  const comment = readFileSync(join(dir, 'gh-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .find(({ args }) => args[0] === 'issue' && args[1] === 'comment');
  assert.match(comment.body, /Claude caught 6 of 8 \(75%\), Codex 5 \(63%\); how many the two caught together was not computed\./);
  assert.equal(JSON.parse(readFileSync(join(dir, 'codex-recall.json'), 'utf8')).either, null);
});

for (const [name, options, args, message] of [
  ['a dispatch by a non-admin', { role: 'write' }, CODEX_ARGS, /only an admin/],
  ['a commit off main', { compare: 'diverged' }, CODEX_ARGS, /is not on main/],
  ['a canary run that is not a canary', { run: { display_title: 'security-audit' } }, CODEX_ARGS, /is not a canary run/],
  ['a canary run at another commit', { run: { head_sha: 'f'.repeat(40) } }, CODEX_ARGS, /the same key seeds the same seeds only over the same commit/],
  ['other seeds', { record: { seeded: 6, caught: 5 } }, CODEX_ARGS, /seeded 6, not 8/],
  ['either below Claude', {}, withArg('--canary-either', '5'), /cannot follow/],
  ['either above the sum', { record: { caught: 1 } }, CODEX_ARGS, /cannot follow/],
  ['a finding typed as a verdict', {}, withArg('--verdicts', 'remote=FAIL:token-in-log'), /invalid verdict/],
  ['an unknown domain', {}, withArg('--verdicts', 'secrets=PASS'), /no domain/],
  ['a model name carrying text', {}, withArg('--model', 'gpt-6-sol see src/x.ts:12'), /invalid model/],
  ['caught above either', {}, withArg('--canary-caught', '8'), /invalid canary counts/],
  ['half the canary counts', {}, withArg('--canary-unfinished', ''), /invalid canary unfinished/],
  ['caught above seeded, either not computed', {}, withArg('--canary-either', '').map((a, i, all) => (all[i - 1] === '--canary-caught' ? '9' : a)), /invalid canary counts/],
]) {
  test(`the second-opinion report posts nothing for ${name}`, (t) => {
    const { dir, env } = codexFixture(t, options);
    const result = runCodex(dir, env, args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    const calls = existsSync(join(dir, 'gh-calls.jsonl')) ? readFileSync(join(dir, 'gh-calls.jsonl'), 'utf8') : '';
    assert.doesNotMatch(calls, /"comment"/);
    assert.ok(!existsSync(join(dir, 'codex-recall.json')));
  });
}

// "Domains": dormouse.sh/security publishes each domain with the specs its
// scope claims, read from the same prompts the audit runs.
test('the published audit index lists every domain with its specs', async () => {
  const { auditIndex } = await import('../website/scripts/generate-docs.js');
  const index = await auditIndex(repo);
  const published = Object.fromEntries(index.domains.map((d) => [d.name, d.specs.map((s) => s.path).sort()]));
  assert.deepEqual(published, Object.fromEntries(domains(repo).map((d) => [d.domain, [...d.specs].sort()])));
});

// "Domains": every path is some domain's because one domain takes the
// remainder of every other's claims — the top-level coverage rule.
test('one domain takes the remainder of every other domain\'s claims', () => {
  const prompt = (domain) => readFileSync(join(repo, `.github/audit/${domain}.md`), 'utf8');
  const catchAll = domains(repo).filter(({ domain }) => /^You are also the \*\*catch-all\*\* domain/m.test(prompt(domain)));
  assert.deepEqual(catchAll.map((d) => d.domain), ['local']);
  const remainder = prompt('local').match(/^You are also the \*\*catch-all\*\* domain.*$/m)[0];
  for (const { domain } of domains(repo).filter((d) => d.domain !== 'local')) {
    assert.ok(remainder.includes(`\`${domain}.md\``), `the remainder does not subtract ${domain}`);
  }
});

// "Orchestration": the job outlives the orchestrator's persisted deadline, and
// the Bash cap outlives the wait loop's own break.
test('the job timeout and Bash cap stay above the waits they bound', () => {
  const deadline = Number(orchestrator.match(/\+ (\d+) \)\) > "\$DEADLINE_FILE"/)[1]);
  const callBreak = Number(orchestrator.match(/CALL_END=\$\(\( \$\(date \+%s\) \+ (\d+) \)\)/)[1]);
  const jobMinutes = Number(workflow.match(/^    timeout-minutes: (\d+)$/m)[1]);
  const bashCap = Number(stepText('Audit against the security specs').match(/BASH_DEFAULT_TIMEOUT_MS: "(\d+)"/)[1]);
  assert.ok(jobMinutes * 60 > deadline, `job ${jobMinutes}m vs deadline ${deadline}s`);
  assert.ok(bashCap > callBreak * 1000, `cap ${bashCap}ms vs break ${callBreak}s`);
});

// `AUDIT_FRAGMENTS` names every domain's output file and nothing a domain does
// not write, beside the deterministic check's.
test('AUDIT_FRAGMENTS names every domain\'s fragment', () => {
  const outputs = DOMAINS.map((d) => readFileSync(join(repo, `.github/audit/${d}.md`), 'utf8').match(/\*\*Output file:\*\* `([^`]+)`/)[1]);
  assert.deepEqual([...fragments].sort(), [...outputs].sort());
  assert.deepEqual(allFragments, [...fragments, STATE_FRAGMENT]);
});

// "Outcomes and reporting" and "Embargo": every step after the agent runs
// whatever the agent did, and the PAT is verified before the agent starts.
test('the redaction, archive, and reporting steps run on every outcome, after the PAT check', () => {
  for (const name of ['Redact secrets from agent output', 'Encrypt the audit transcript', 'Compose the audit report', 'Read the findings ledger', 'Publish the audit status']) {
    assert.match(stepText(name), /^        if: always\(\)$/m, name);
  }
  const order = ['Verify AUDIT_PAT is provisioned', 'Check GitHub state', 'Audit against the security specs', 'Redact secrets from agent output']
    .map((name) => workflow.indexOf(`      - name: ${name}\n`));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), String(order));
  assert.match(runBlock('Verify AUDIT_PAT is provisioned'), /^\[ -n "\$AUDIT_PAT" \] && exit 0$/m);
  assert.match(workflow, /^    environment:\n      name: security-audit$/m);
  // No step prints either credential.
  for (const line of workflow.split('\n')) {
    if (/\b(echo|printf)\b/.test(line)) assert.doesNotMatch(line, /\$\{?(AUDIT_PAT|CLAUDE_CODE_OAUTH_TOKEN)\b/, line);
  }
});
