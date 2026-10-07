import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BODY_LIMIT } from './clamp-issue-body.mjs';
import { domains, fragmentManifest, ledgerKey } from './security-audit-report.mjs';
import { repoRoot, tempDir, workflowRunBlock } from './lint-kit.mjs';

const repo = repoRoot;
const workflow = readFileSync(join(repo, '.github/workflows/security-audit.yaml'), 'utf8');
const fragments = workflow.match(/^\s+AUDIT_FRAGMENTS: (.+)$/m)[1].split(/\s+/);

// Execute the shipped block, so changes to its parser or guards reach these tests.
const runBlock = (name) => workflowRunBlock(workflow, name);

/** One step's whole text, from its `- name:` line to the next step. */
function stepText(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `missing workflow step: ${name}`);
  const end = workflow.indexOf('\n      - ', start + 1);
  return workflow.slice(start, end < 0 ? undefined : end);
}

// Every sink the encrypted archive takes, as its loop names them. The
// redaction tests below write a secret into each, and the encryption test
// checks the archive holds them, so a sink added to one list and not the
// other fails one of the two.
const archivedSinks = runBlock('Encrypt the audit transcript')
  .match(/^for f in (.+); do$/m)[1]
  .replace('"$RUNNER_TEMP/claude-execution-output.json"', 'claude-execution-output.json')
  .replace('$AUDIT_FRAGMENTS', fragments.join(' '))
  .split(/\s+/);

const EMBARGO_REPO = stepText('File embargoed findings').match(/^          EMBARGO_REPO: (.+)$/m)[1];
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

// The one literal every reader waits for and every fixture writes. The
// producer copy in `.github/audit/_preamble.md` is pinned against it below.
const SENTINEL = '<!-- END OF REPORT -->';

/** Every rule a fragment's domain owes, as the result-line id the preamble fixes, from the real specs. */
const owedIds = (fragment) => [...fragmentManifest(repo, fragment)].flatMap(([key, count]) => {
  const [spec, heading] = key.split('\0');
  return Array.from({ length: count }, (_, i) => `\`${spec}\` -> "${heading}" #${i + 1}`);
});

/**
 * A fragment written to the grammar. Every owed rule passes unless `results`
 * overrides it by id; `drop` omits rules by id prefix; `lines` are appended
 * verbatim. `stated` is the domain's own verdict line.
 */
function fragmentText(fragment, { stated = 'PASS', results = {}, drop = [], lines = [], qualitative = 1, sentinel = true, trailingBlank = false } = {}) {
  const out = [`VERDICT: ${stated}`, ''];
  for (const id of owedIds(fragment)) {
    if (drop.some((prefix) => id.startsWith(prefix))) continue;
    out.push(results[id] ?? `- PASS: ${id} — the clause: evidence`);
  }
  out.push(...lines);
  for (let i = 0; i < qualitative; i++) out.push('- QUALITATIVE: done — the whole scope');
  if (sentinel) out.push('', SENTINEL, ...(trailingBlank ? [''] : []));
  return `${out.join('\n')}\n`;
}

/** The first rule a fragment owes, for overriding. */
const firstId = (fragment) => owedIds(fragment)[0];

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
  for (const script of ['clamp-issue-body.mjs', 'security-audit-public-body.mjs', 'security-audit-report.mjs']) {
    copyFileSync(join(repo, 'scripts', script), join(dir, 'scripts', script));
  }
  // The manifest is derived from these specs and the domain prompts' scopes,
  // and the public builder names a failed check only by a heading they carry.
  for (const spec of readdirSync(join(repo, 'docs/specs')).filter((f) => /^security[a-z-]*\.md$/.test(f))) {
    copyFileSync(join(repo, 'docs/specs', spec), join(dir, 'docs/specs', spec));
  }
  for (const f of readdirSync(join(repo, '.github/audit'))) {
    copyFileSync(join(repo, '.github/audit', f), join(dir, '.github/audit', f));
  }
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, RUNNER_TEMP: dir,
    AUDIT_FRAGMENTS: fragments.join(' '), GITHUB_REPOSITORY: 'fixture/repo', GITHUB_RUN_ID: '123',
    GITHUB_SHA: COMMIT, GH_TOKEN: 'fixture-workflow-token',
    AUDIT_PAT: 'fixture-admin-token', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth-token' };
  return { dir, env };
}

function stub(dir, name, source) {
  writeFileSync(join(dir, 'bin', name), `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
}

/**
 * A `gh` that records each call with the token it was handed and the body it
 * posted. A public `issue list` finds open issue 23 unless `GH_NO_PUBLIC_ISSUE`
 * is set; the embargo repository's lists the rows of `GH_LEDGER_OPEN`. A
 * create in the embargo repository answers with its URL; every embargo call
 * fails when `GH_FAIL_EMBARGO` is set.
 */
function stubGh(dir) {
  stub(dir, 'gh', `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const bodyAt = args.indexOf('--body-file');
    const body = bodyAt === -1 ? (args.includes('--body') ? args[args.indexOf('--body') + 1] : null) : fs.readFileSync(args[bodyAt + 1], 'utf8');
    const embargo = args.includes(${JSON.stringify(EMBARGO_REPO)}) || (args[2] ?? '').includes(${JSON.stringify(EMBARGO_REPO)});
    fs.appendFileSync('gh-calls.jsonl', JSON.stringify({ args, token: process.env.GH_TOKEN, body, embargo }) + '\\n');
    if (embargo && process.env.GH_FAIL_EMBARGO) process.exit(1);
    if (args[0] === 'issue' && args[1] === 'list') {
      if (embargo) process.stdout.write(process.env.GH_LEDGER_OPEN ?? '');
      else if (!process.env.GH_NO_PUBLIC_ISSUE) process.stdout.write('23\\n');
    }
    if (embargo && args[1] === 'create') process.stdout.write('https://github.com/${EMBARGO_REPO}/issues/7\\n');
  `);
}

const ghCalls = (dir) => (existsSync(join(dir, 'gh-calls.jsonl'))
  ? readFileSync(join(dir, 'gh-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  : []);

/** `NAME: ${{ steps.<id>.outputs.<key> }}` entries of a step's `env:`, so the plumbing between steps is the shipped one. */
const outputEnv = (name) => [...stepText(name).matchAll(/^          (\w+): \$\{\{ steps\.(\w+)\.outputs\.(\w+) \}\}$/gm)]
  .map(([, variable, step, key]) => ({ variable, step, key }));

/**
 * Run the three reporting steps as the runner would: compose, the embargo
 * filing, then the public step, each handed the outputs its `env:` names.
 */
function runReporting(dir, env, { embargoToken = 'fixture-embargo-token', embargoEnv = {} } = {}) {
  const outputs = {};
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
  assert.match(stepText('File embargoed findings'), /^        if: always\(\)$/m);
  const composed = run('compose', 'Compose the audit report', {});
  assert.equal(composed.status, 0, composed.stderr);
  const embargoed = run('embargo', 'File embargoed findings', { GH_TOKEN: embargoToken, EMBARGO_REPO, ...embargoEnv });
  const surfaced = run('surface', 'Surface result, file or close issue', embargoEnv);
  return { composed, embargoed, surfaced, outputs };
}

/** The embargo calls that file the per-run report: not the ledger's list, issues, or comments. */
const reportCalls = (calls) => calls.filter(({ embargo, args }) => embargo && (args[1] === 'create'
  ? !args[args.indexOf('--title') + 1].startsWith('[audit-finding ')
  : args[1] === 'comment' && args[2].startsWith('https://')));

const privateParts = (dir) => readdirSync(dir).filter((f) => /^audit-private-part-\d+\.md$/.test(f)).sort()
  .map((f) => readFileSync(join(dir, f), 'utf8'));

// Each scenario writes `frags[i]` (options for `fragmentText`, null for none,
// or a string written raw) and the orchestrator's `status`.
const [SUPPLY, CI, APP, HOSTED] = fragments;
const allPass = () => fragments.map(() => ({}));
const cases = [
  { name: 'all checks pass', status: 'PASS\n', frags: allPass(), expected: 'PASS' },
  { name: 'missing merged verdict', frags: allPass(), expected: 'INCONCLUSIVE', publicRows: ['The orchestrator wrote no verdict.'] },
  { name: 'embedded whitespace is not PASS', status: 'P A\nSS\n', frags: allPass(), expected: 'INCONCLUSIVE' },
  { name: 'PASS prefix with a suffix is unreadable', status: 'PASS', frags: [{ stated: 'PASS but unfinished' }, {}, {}, {}], expected: 'INCONCLUSIVE',
    notes: ["A domain's verdict could not be read"] },
  { name: 'missing fragment', status: 'PASS', frags: [null, {}, {}, {}], expected: 'INCONCLUSIVE', notes: ['left no report'] },
  { name: 'unverifiable checks override merged PASS', status: 'PASS',
    frags: [{ stated: 'INCONCLUSIVE', results: { [firstId(SUPPLY)]: `- UNVERIFIABLE: ${firstId(SUPPLY)} — the clause: network error` } }, {}, {}, {}],
    expected: 'INCONCLUSIVE', notes: ['- UNVERIFIABLE: `docs/specs/security-supply-chain.md`'] },
  { name: 'dissent overrides missing merged verdict',
    frags: [{ stated: 'FAIL', results: { [firstId(SUPPLY)]: `- FAIL: ${firstId(SUPPLY)} — the clause: violated` } }, {}, {}, {}], expected: 'FAIL' },
  { name: 'FAIL with explanation overrides merged PASS', status: 'PASS',
    frags: [{ stated: 'FAIL — credential leaked', results: { [firstId(SUPPLY)]: `- FAIL: ${firstId(SUPPLY)} — the clause: violated` } }, {}, {}, {}], expected: 'FAIL',
    notes: ["A domain's lines record a failure"] },
  // 2026-10-07: a fragment opened `VERDICT: PASS` over its own `UNVERIFIABLE`
  // line, and the line was believed. The computed verdict decides, and the
  // disagreement is reported.
  { name: 'a computed INCONCLUSIVE overrides a contradicting VERDICT: PASS', status: 'PASS',
    frags: [{}, {}, {}, { results: { [firstId(HOSTED)]: `- UNVERIFIABLE: ${firstId(HOSTED)}.b — the clause: not reached` } }],
    expected: 'INCONCLUSIVE', notes: ['### Anomalies', `\`${HOSTED}\`: its first line says \`VERDICT: PASS\`, its lines compute INCONCLUSIVE`, '`audit-status.txt` says `PASS`'],
    publicRows: [`| \`${HOSTED}\` | INCONCLUSIVE |`, "1 domain's own verdict line disagreed"] },
  { name: 'a computed FAIL overrides a contradicting VERDICT: PASS', status: 'PASS',
    frags: [{}, { results: { [firstId(CI)]: `- FAIL: ${firstId(CI)} — the clause: violated` } }, {}, {}],
    expected: 'FAIL', notes: [`\`${CI}\`: its first line says \`VERDICT: PASS\`, its lines compute FAIL`], publicRows: [`| \`${CI}\` | FAIL | 1 |`] },
  // Taken at its word, a `FAIL` line with no failing result under it would file
  // a security finding nobody can find; overruled, it would pass a domain that
  // doubted itself. It is held at INCONCLUSIVE and reported.
  { name: 'a VERDICT: FAIL with no failing line is not believed either way', status: 'FAIL',
    frags: [{}, {}, { stated: 'FAIL' }, {}], expected: 'INCONCLUSIVE',
    notes: [`\`${APP}\`: its first line says \`VERDICT: FAIL\`, its lines compute PASS`, '`audit-status.txt` says `FAIL`, the domains\' lines compute INCONCLUSIVE', 'A domain claimed more than its result lines record'] },
  // `audit-status.txt` is a conclusion like any other: a FAIL over four
  // passing domains is an anomaly, not a finding.
  { name: 'an orchestrator FAIL over passing domains is not believed', status: 'FAIL', frags: allPass(), expected: 'INCONCLUSIVE',
    notes: ['`audit-status.txt` says `FAIL`, the domains\' lines compute PASS'] },
  // Whole sections were skipped silently: every rule the specs carry is owed a line.
  { name: 'a skipped section is INCONCLUSIVE', status: 'PASS',
    frags: [{}, {}, {}, { drop: ['`docs/specs/security-hosted.md` -> "Origin boundary"'] }], expected: 'INCONCLUSIVE',
    notes: ['### Rules with no result line', `- \`${HOSTED}\`: \`docs/specs/security-hosted.md\` -> "Origin boundary" #6`],
    publicRows: [`| \`${HOSTED}\` | INCONCLUSIVE | 0 | 6 | 0 |`] },
  // #797: a `FAIL —` line the lift expected as `FAIL:` was lost. Off the
  // grammar, a line is malformed, and a malformed line cannot pass.
  { name: 'a malformed result line is INCONCLUSIVE', status: 'PASS',
    frags: [{ lines: ['- FAIL — `docs/specs/security-supply-chain.md` -> "Disclosure" #1: violated'] }, {}, {}, {}], expected: 'INCONCLUSIVE',
    notes: ['### Malformed lines', '- FAIL — `docs/specs/security-supply-chain.md`'], publicRows: [`| \`${SUPPLY}\` | INCONCLUSIVE | 0 | 0 | 1 |`] },
  { name: 'a bold result line is malformed', status: 'PASS',
    frags: [{ lines: ['- **FAIL IF** something holds: PASS.'] }, {}, {}, {}], expected: 'INCONCLUSIVE', notes: ['### Malformed lines'] },
  { name: 'a skipped clause is INCONCLUSIVE', status: 'PASS',
    frags: [{ results: { [firstId(SUPPLY)]: `- PASS: ${firstId(SUPPLY)}.a — one: ok\n- PASS: ${firstId(SUPPLY)}.c — three: ok` } }, {}, {}, {}],
    expected: 'INCONCLUSIVE', notes: [`- \`${SUPPLY}\`: ${firstId(SUPPLY)}.b`] },
  { name: 'a result naming a rule nobody owes is INCONCLUSIVE', status: 'PASS',
    frags: [{ lines: ['- PASS: `docs/specs/security-supply-chain.md` -> "Disclosure" #99 — the clause: ok'] }, {}, {}, {}], expected: 'INCONCLUSIVE',
    notes: ['names no rule this domain owes'] },
  { name: 'no qualitative pass is INCONCLUSIVE', status: 'PASS', frags: [{}, {}, { qualitative: 0 }, {}], expected: 'INCONCLUSIVE',
    notes: ['it recorded no finished qualitative pass'] },
  { name: 'a BLOCKER fails the run', status: 'PASS',
    frags: [{}, {}, { stated: 'FAIL', lines: finding('BLOCKER', 'deploy/local/install-windows.ps1:88', 'Install-Service', 'a file name reaches Invoke-Expression') }, {}],
    expected: 'FAIL', publicRows: [`| \`${APP}\` | FAIL | 0 | 0 | 0 | 1 | 0 |`] },
  { name: 'a BLOCKER without its evidence still fails, and is malformed', status: 'PASS',
    frags: [{}, {}, { stated: 'FAIL', lines: ['- BLOCKER: `lib/x.ts:4` `run` — something'] }, {}],
    expected: 'FAIL', notes: ['BLOCKER without its Code, Path, Reproduction evidence'] },
  // A domain cut off between rewriting its verdict line and writing its
  // sentinel reads as a clean PASS on line 1.
  { name: 'PASS without a sentinel is a cut-off domain', status: 'PASS', frags: [{}, {}, { sentinel: false }, {}], expected: 'INCONCLUSIVE', notes: ['cut off mid-report'],
    publicRows: [`| \`${APP}\` | INCONCLUSIVE, cut off |`] },
  { name: 'a cut-off FAIL is still a finding', status: 'PASS',
    frags: [{}, {}, { stated: 'FAIL', sentinel: false, results: { [firstId(APP)]: `- FAIL: ${firstId(APP)} — the clause: violated` } }, {}],
    expected: 'FAIL', notes: ["A domain's lines record a failure", 'cut off mid-report'] },
  { name: 'a trailing blank line still ends a report', status: 'PASS', frags: fragments.map(() => ({ trailingBlank: true })), expected: 'PASS' },
  { name: 'FAIL records every incomplete condition', status: 'FAIL',
    frags: [null, 'garbled\n', { stated: 'INCONCLUSIVE', results: { [firstId(APP)]: `- UNVERIFIABLE: ${firstId(APP)} — c: e` } }, { stated: 'FAIL', results: { [firstId(HOSTED)]: `- FAIL: ${firstId(HOSTED)} — c: e` } }],
    expected: 'FAIL', notes: ['left no report', 'could not be read', 'could not determine every check', 'record a failure'],
    publicRows: [`| \`${SUPPLY}\` | no report |`, `| \`${CI}\` | INCONCLUSIVE, cut off |`, `| \`${APP}\` | INCONCLUSIVE |`, `| \`${HOSTED}\` | FAIL |`] },
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
    const { surfaced, outputs } = runReporting(dir, env);
    assert.equal(outputs.compose.status, scenario.expected === 'INCONCLUSIVE' ? 'MISSING' : scenario.expected);
    assert.equal(surfaced.status, scenario.expected === 'PASS' ? 0 : 1, surfaced.stderr);
    const calls = ghCalls(dir);
    assert.equal(calls.some(({ args, embargo }) => !embargo && args[0] === 'issue' && args[1] === 'close'), scenario.expected === 'PASS');
    // Nothing ever closes a ledger issue.
    assert.ok(!calls.some(({ args, embargo }) => embargo && args[1] === 'close'));
    if (scenario.expected === 'PASS') {
      // A clean pass files nothing, in either tracker.
      assert.ok(!calls.some(({ args }) => args[0] === 'issue' && (args[1] === 'create' || args[1] === 'comment')));
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
    // The public issue carries none of what a domain wrote beyond its verdict.
    const published = calls.filter(({ embargo, body: posted }) => !embargo && posted !== null);
    assert.equal(published.length, 1);
    assert.ok(published.every(({ token }) => token === 'fixture-workflow-token'));
    const publicBody = published[0].body;
    assert.match(publicBody, scenario.expected === 'FAIL' ? /^Audit failed/ : /^Audit reached no usable verdict/);
    assert.ok(!publicBody.includes('Fixture report'));
    for (const text of written) {
      for (const line of text.split('\n').filter((l) => l.length > 6 && !/^VERDICT: (PASS|INCONCLUSIVE|FAIL)$/.test(l) && l !== SENTINEL)) {
        assert.ok(!publicBody.includes(line), `the public body carries fragment text: ${line}`);
      }
    }
    for (const row of scenario.publicRows ?? []) assert.ok(publicBody.includes(row), `missing public row: ${row}\n${publicBody}`);
  });
}

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
  const { outputs, surfaced } = runReporting(dir, env);
  assert.equal(outputs.compose.status, 'PASS');
  assert.equal(surfaced.status, 0, surfaced.stderr);
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
  const [, spec, heading, rule] = failId.match(/^`([^`]+)` -> "([^"]+)" #(\d+)$/);
  const known = ledgerKey('check', spec, heading, rule, '');
  const { surfaced, outputs } = runReporting(dir, env, { embargoEnv: { GH_LEDGER_OPEN: `41 [audit-finding ${known}] FAIL: old\n42 [audit-finding 0123456789ab] WARNING: other\n` } });
  assert.equal(surfaced.status, 1);
  assert.equal(outputs.embargo.result, 'filed');
  assert.equal(outputs.embargo.open_findings, '2');
  const embargoCalls = ghCalls(dir).filter(({ embargo }) => embargo);
  const comment = embargoCalls.find(({ args }) => args[1] === 'comment' && args[2] === '41');
  assert.ok(comment, JSON.stringify(embargoCalls));
  assert.match(comment.body, /^Seen again as FAIL in \[run 123\]/);
  const ledgerCreates = embargoCalls.filter(({ args }) => args[1] === 'create' && args[args.indexOf('--title') + 1].startsWith('[audit-finding '));
  assert.equal(ledgerCreates.length, 1);
  assert.ok(ledgerCreates[0].body.includes('- BLOCKER: `lib/a.ts:10` `runIt` — new one'));
  assert.ok(!embargoCalls.some(({ args }) => args[1] === 'close' || args[1] === 'edit'));
  // The public body counts what is still open privately, and says nothing else of it.
  const publicBody = ghCalls(dir).find(({ embargo, body }) => !embargo && body !== null).body;
  assert.ok(publicBody.includes('2 findings from earlier runs are still open in the private ledger.'), publicBody);
  assert.ok(!publicBody.includes('new one') && !publicBody.includes('runIt'));
});

// A later PASS closed the issue on 2026-07-14 and 2026-10-06 while the
// findings behind it were unfixed. While the ledger holds one an earlier run
// opened, a PASS says so on the public issue instead of closing it.
test('a PASS does not close the public issue while a ledger issue is open', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'PASS');
  fragments.forEach((f) => writeFileSync(join(dir, f), fragmentText(f)));
  const { surfaced } = runReporting(dir, env, { embargoEnv: { GH_LEDGER_OPEN: '41 [audit-finding 0123456789ab] BLOCKER: old\n' } });
  assert.equal(surfaced.status, 0, surfaced.stderr);
  const pub = ghCalls(dir).filter(({ embargo }) => !embargo);
  assert.ok(!pub.some(({ args }) => args[1] === 'close'));
  const comment = pub.find(({ args }) => args[1] === 'comment' && args[2] === '23');
  assert.match(comment.body, /^PASS this run at .*; 1 finding\(s\) from earlier runs are still under private review/);
  assert.ok(!comment.body.includes('0123456789ab'));
});

test('a PASS whose ledger cannot be read closes nothing and fails', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'PASS');
  fragments.forEach((f) => writeFileSync(join(dir, f), fragmentText(f)));
  const { embargoed, surfaced, outputs } = runReporting(dir, env, { embargoToken: '' });
  assert.equal(embargoed.status, 1);
  assert.equal(outputs.embargo.result, 'missing-token');
  assert.equal(surfaced.status, 1);
  assert.match(surfaced.stdout, /::error::/);
  assert.ok(!ghCalls(dir).some(({ args }) => args[1] === 'close'));
});

test('a PASS with an empty ledger closes the public issue', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'PASS');
  fragments.forEach((f) => writeFileSync(join(dir, f), fragmentText(f)));
  const { surfaced } = runReporting(dir, env);
  assert.equal(surfaced.status, 0, surfaced.stderr);
  const close = ghCalls(dir).find(({ args }) => args[1] === 'close');
  assert.deepEqual(close.args.slice(0, 3), ['issue', 'close', '23']);
});

// A WARNING does not fail the run, and is not lost with it either.
test('a passing run files its WARNINGs in the ledger and nothing else', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'PASS');
  fragments.forEach((f, i) => writeFileSync(join(dir, f), fragmentText(f, i === 2 ? { lines: finding('WARNING', 'lib/b.ts:5', 'paste', 'a paste submits a command') } : {})));
  const { surfaced, outputs } = runReporting(dir, env);
  assert.equal(outputs.compose.status, 'PASS');
  assert.equal(surfaced.status, 0, surfaced.stderr);
  const embargoCalls = ghCalls(dir).filter(({ embargo, args }) => embargo && args[1] !== 'list');
  assert.equal(embargoCalls.length, 1);
  assert.ok(embargoCalls[0].args[embargoCalls[0].args.indexOf('--title') + 1].startsWith('[audit-finding '));
  // Opened by this run, so it does not hold the public issue open.
  assert.ok(ghCalls(dir).some(({ args }) => args[1] === 'close'));
});

// The builder failing must not turn into a verdict.
test('a report builder that throws reports INCONCLUSIVE', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'PASS');
  fragments.forEach((f) => writeFileSync(join(dir, f), fragmentText(f)));
  writeFileSync(join(dir, 'scripts/security-audit-report.mjs'), 'throw new Error("boom");\n');
  const { outputs, surfaced } = runReporting(dir, env);
  assert.equal(outputs.compose.status, 'MISSING');
  assert.equal(surfaced.status, 1);
  assert.ok(!ghCalls(dir).some(({ args }) => args[1] === 'close'));
});

// The manifest is what makes a skipped section visible, so it must be derived
// from the specs and cover every one each domain claims.
test('every domain owes a result for every FAIL IF rule in its specs', () => {
  const claimed = domains(repo);
  assert.deepEqual(claimed.map((d) => d.fragment).sort(), [...fragments].sort());
  for (const { fragment, specs } of claimed) {
    const owed = fragmentManifest(repo, fragment);
    for (const spec of specs) {
      const text = readFileSync(join(repo, spec), 'utf8').split(/^## Future\b/m)[0];
      const rules = text.split('\n').filter((l) => /^\s*(?:[-*]\s+)?\*\*FAIL IF\b/.test(l)).length;
      const counted = [...owed].filter(([key]) => key.startsWith(`${spec}\0`)).reduce((n, [, c]) => n + c, 0);
      assert.equal(counted, rules, `${fragment}: ${spec}`);
    }
  }
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

// --- Embargo: detail goes private, the public issue gets verdicts and counts ---

// Issue #1027 published a working command-injection payload. A FAIL line and a
// BLOCKER carrying one, a FAIL line naming a heading no spec has, malformed
// lines carrying one, and a verdict line with an appended explanation: none of
// their text may reach the public body, and all of it must reach the private
// issue.
const EXPLOIT = '$(printf calc-injected-7f3a)';
test('the public issue carries counts and verified section names, never finding text', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'FAIL');
  writeFileSync(join(dir, 'audit-report.md'), `# Security audit\n\nThe merged report quotes ${EXPLOIT}.\n`);
  fragments.forEach((f, i) => writeFileSync(join(dir, f), i !== 1 ? fragmentText(f) : fragmentText(f, {
    stated: `FAIL — ${EXPLOIT}`,
    results: { '`docs/specs/security-audit.md` -> "Environment and `AUDIT_PAT`" #1': `- FAIL: \`docs/specs/security-audit.md\` -> "Environment and \`AUDIT_PAT\`" #1 — reproduced with ${EXPLOIT}` },
    lines: [
      `- FAIL: \`docs/specs/security-audit.md\` -> "Run ${EXPLOIT} to see" #1 — a heading no spec has`,
      ...finding('BLOCKER', 'lib/a.ts:3', 'run', `the reporter runs ${EXPLOIT}`),
      `- **WARNING** — ${EXPLOIT} again`,
      '- INFO: `docs/x.md:1` `drift` — nothing to see',
    ],
  })));
  const { surfaced } = runReporting(dir, env);
  assert.equal(surfaced.status, 1, surfaced.stderr);
  const calls = ghCalls(dir);
  const publicBody = calls.find(({ embargo, body }) => !embargo && body !== null).body;
  assert.ok(!publicBody.includes('calc-injected-7f3a'), publicBody);
  assert.ok(publicBody.includes(`| \`${fragments[1]}\` | FAIL | 2 | 0 | 2 | 1 | 0 |`), publicBody);
  assert.ok(publicBody.includes('- `docs/specs/security-audit.md` -> "Environment and `AUDIT_PAT`"'), publicBody);
  assert.ok(publicBody.includes('1 failed check named no section heading'), publicBody);
  assert.ok(publicBody.includes(COMMIT), publicBody);
  assert.match(publicBody, /triaged privately until fixed/);
  const privately = calls.filter(({ embargo }) => embargo).map(({ body }) => body).join('');
  assert.ok(privately.includes(`- BLOCKER: \`lib/a.ts:3\` \`run\` — the reporter runs ${EXPLOIT}`), privately);
  assert.ok(privately.includes(`- **WARNING** — ${EXPLOIT} again`), privately);
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
    const { embargoed, surfaced, outputs } = runReporting(dir, env, options);
    assert.equal(embargoed.status, 1);
    assert.match(embargoed.stdout, /::error::/);
    assert.equal(outputs.embargo.result, result);
    assert.ok(!`${embargoed.stdout}${embargoed.stderr}`.includes('calc-injected-7f3a'));
    if (result === 'missing-token') assert.equal(ghCalls(dir).filter(({ embargo }) => embargo).length, 0);
    // The public issue is still filed, says the private filing failed, and
    // carries no more than it would have anyway.
    assert.equal(surfaced.status, 1);
    const published = ghCalls(dir).filter(({ embargo, body }) => !embargo && body !== null);
    assert.equal(published.length, 1);
    assert.ok(published[0].body.includes(publicNote), published[0].body);
    assert.ok(!published[0].body.includes('calc-injected-7f3a'), published[0].body);
  });
}

// The agent must never hold `EMBARGO_TOKEN`: it is named in exactly one step's
// `env:`, that step is not the agent's, and no job- or workflow-level `env:`,
// `$GITHUB_ENV` write, or whole-secrets expression reaches it elsewhere.
test('EMBARGO_TOKEN is in the embargo step\'s env alone', () => {
  const holder = 'File embargoed findings';
  const uses = workflow.split('\n').filter((line) => /secrets\s*\.\s*EMBARGO_TOKEN|secrets\s*\[/.test(line));
  assert.deepEqual(uses, ['          GH_TOKEN: ${{ secrets.EMBARGO_TOKEN }}']);
  const env = stepText(holder).match(/^        env:\n((?:          .*\n)+)/m)[1];
  assert.ok(env.includes(uses[0]), 'the token is not in the embargo step\'s env');
  assert.ok(!stepText('Audit against the security specs').includes('EMBARGO'));
  assert.doesNotMatch(workflow, /toJSON\(\s*secrets\s*\)|secrets: inherit/);
  assert.doesNotMatch(workflow, /GITHUB_ENV/);
});

// Holding the token, the step runs `gh` on the parts the compose step wrote
// and nothing from the repository: no script a modified checkout could swap.
test('the embargo step runs no repository code', () => {
  const block = runBlock('File embargoed findings');
  assert.doesNotMatch(block, /\bnode\b|\bpnpm\b|\bnpx\b|scripts\/|\.\/|\bsource\b|^\s*\. /m);
  // Nor any other program: `gh` and shell builtins only.
  const code = block.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /(?:^|[\s;|&(`]|\$\()(?:date|mktemp|mkdir|sed|awk|grep|head|tail|wc|cat|cut|tr|jq|curl|wget|python3?|env|xargs|find|sort)\b(?!-)/m);
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
// The last row is CI's computed verdict reaching the local runner: a fragment
// that says PASS over a skipped rule does not exit zero here either.
for (const [verdict, cliExit, expected, sentinel = true, drop = false] of [['PASS', 0, 0], ['FAIL', 0, 1], ['FAIL \u2014 explained', 0, 1], ['INCONCLUSIVE', 0, 1], ['PASS extra', 0, 1], ['PASS', 7, 1], ['PASS', 0, 1, false], ['FAIL', 0, 1, false], ['PASS', 0, 1, true, true]]) {
  test(`local runner: ${verdict}, CLI exit ${cliExit}${sentinel ? '' : ', no sentinel'}${drop ? ', a rule skipped' : ''}`, (t) => {
    const { dir, env } = fixture(t);
    copyFileSync(join(repo, 'scripts/security-audit-local.sh'), join(dir, 'scripts/security-audit-local.sh'));
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
    if (verdict.startsWith('FAIL')) {
      assert.ok(!result.stderr.includes('no readable verdict'), result.stderr);
      // A dissent is reported as one whether or not the fragment finished. CI
      // records both conditions and escalates to FAIL; reporting only the
      // cut-off here would hide a finding the domain did write.
      assert.match(result.stderr, /reports FAIL/);
    }
    if (!sentinel) assert.match(result.stderr, /cut off before finishing/);
    for (const fragment of fragments) assert.ok(existsSync(join(dir, fragment)), fragment);
    // Local output stays local: the runner files nothing, anywhere.
    assert.deepEqual(ghCalls(dir), []);
  });
}

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
    .replace('<your fragment>', 'audit-application.md')
    .replace("<every delegated stream's .done file exists>", '[ -f delegates-done ]');
  const runDelegateWait = (caller, done) => {
    const dir = tempDir(t, 'dormouse-audit-delegate-');
    if (caller !== undefined) writeFileSync(join(dir, 'audit-deadline'), `${caller}\n`);
    if (done) writeFileSync(join(dir, 'delegates-done'), '');
    const r = spawnSync('bash', ['-c', block], { cwd: dir, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: dir }, timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr);
    return { answer: r.stdout.trim().split('\n').at(-1),
      persisted: Number(readFileSync(join(dir, 'delegate-deadline-audit-application.md'), 'utf8')) };
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
    if (body !== null) writeFileSync(join(dir, 'audit-application.md'), body);
    const result = spawnSync('bash', ['-c', `${finishedFn}\nfinished audit-application.md && echo YES || echo NO`],
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
  assert.match(report, /## Application security\n\n_No report —/);
  // The fourth domain is emitted too — a heading dropped from `emit` would
  // silently publish a report missing a domain that did report.
  assert.match(report, /## Hosted accounts\n\nVERDICT: PASS\nhosted evidence/);
});
