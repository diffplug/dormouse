import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BODY_LIMIT } from './clamp-issue-body.mjs';
import { decide } from './security-audit-plan.mjs';
import { repoRoot, tempDir, workflowRunBlock } from './lint-kit.mjs';

const repo = repoRoot;
const workflow = readFileSync(join(repo, '.github/workflows/security-audit.yaml'), 'utf8');
const allFragments = workflow.match(/^\s+AUDIT_FRAGMENTS: (.+)$/m)[1].split(/\s+/);
// The deterministic GitHub-state check's fragment rides the same list; the
// rest are the four domains the orchestrator waits for and merges.
const STATE_FRAGMENT = 'audit-github-state.md';
const fragments = allFragments.filter((f) => f !== STATE_FRAGMENT);

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
  .replace('$AUDIT_FRAGMENTS', allFragments.join(' '))
  .split(/\s+/);

const EMBARGO_REPO = stepText('File embargoed findings').match(/^          EMBARGO_REPO: (.+)$/m)[1];
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function fixture(t) {
  const dir = tempDir(t, 'dormouse-audit-');
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'docs/specs'), { recursive: true });
  mkdirSync(join(dir, '.github/audit'), { recursive: true });
  for (const script of ['clamp-issue-body.mjs', 'security-audit-public-body.mjs']) {
    copyFileSync(join(repo, 'scripts', script), join(dir, 'scripts', script));
  }
  // The public builder names a failed check only by a heading these specs carry.
  for (const spec of readdirSync(join(repo, 'docs/specs')).filter((f) => /^security[a-z-]*\.md$/.test(f))) {
    copyFileSync(join(repo, 'docs/specs', spec), join(dir, 'docs/specs', spec));
  }
  copyFileSync(join(repo, '.github/audit/transcript-recipient.txt'), join(dir, '.github/audit/transcript-recipient.txt'));
  // The deterministic check passed unless a case says otherwise.
  writeFileSync(join(dir, STATE_FRAGMENT), `VERDICT: PASS\n\n### FAIL IF results\n\n- PASS: fixture\n\n${SENTINEL}\n`);
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
 * A `gh` that records each call with the token it was handed and the body it
 * posted. `issue list` finds open issue 23; a create in the embargo repository
 * answers with its URL, or fails when `GH_FAIL_EMBARGO` is set.
 */
function stubGh(dir) {
  stub(dir, 'gh', `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const bodyAt = args.indexOf('--body-file');
    const body = bodyAt === -1 ? null : fs.readFileSync(args[bodyAt + 1], 'utf8');
    const embargo = args.includes(${JSON.stringify(EMBARGO_REPO)}) || (args[2] ?? '').includes(${JSON.stringify(EMBARGO_REPO)});
    fs.appendFileSync('gh-calls.jsonl', JSON.stringify({ args, token: process.env.GH_TOKEN, body, embargo }) + '\\n');
    if (embargo && process.env.GH_FAIL_EMBARGO) process.exit(1);
    if (args[0] === 'issue' && args[1] === 'list') process.stdout.write('23\\n');
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
 * Run the three reporting steps as the runner would: compose, then the
 * embargo filing unless the verdict passed (its `if:`), then the public step,
 * each handed the outputs its `env:` names.
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
  assert.match(stepText('File embargoed findings'), /^        if: always\(\) && steps\.compose\.outputs\.status != 'PASS'$/m);
  const composed = run('compose', 'Compose the audit report', {});
  assert.equal(composed.status, 0, composed.stderr);
  const embargoed = outputs.compose.status === 'PASS' ? null
    : run('embargo', 'File embargoed findings', { GH_TOKEN: embargoToken, EMBARGO_REPO, ...embargoEnv });
  const surfaced = run('surface', 'Surface result, file or close issue', {});
  return { composed, embargoed, surfaced, outputs };
}

const privateParts = (dir) => readdirSync(dir).filter((f) => /^audit-private-part-\d+\.md$/.test(f)).sort()
  .map((f) => readFileSync(join(dir, f), 'utf8'));

// The one literal every reader waits for and every fixture writes. The
// producer copy in `.github/audit/_preamble.md` is pinned against it below.
const SENTINEL = '<!-- END OF REPORT -->';

const cases = [
  { name: 'all checks pass', status: 'PASS\n', verdicts: ['PASS', 'PASS', 'PASS', 'PASS'], expected: 'PASS' },
  { name: 'missing merged verdict', verdicts: ['PASS', 'PASS', 'PASS', 'PASS'], expected: 'INCONCLUSIVE', publicRows: ['The orchestrator wrote no verdict.'] },
  { name: 'embedded whitespace is not PASS', status: 'P A\nSS\n', verdicts: ['PASS', 'PASS', 'PASS', 'PASS'], expected: 'INCONCLUSIVE' },
  { name: 'PASS prefix with a suffix is unreadable', status: 'PASS', verdicts: ['PASS but unfinished', 'PASS', 'PASS', 'PASS'], expected: 'INCONCLUSIVE' },
  { name: 'missing fragment', status: 'PASS', verdicts: [null, 'PASS', 'PASS', 'PASS'], expected: 'INCONCLUSIVE' },
  { name: 'unverifiable checks override merged PASS', status: 'PASS', verdicts: ['INCONCLUSIVE', 'PASS', 'PASS', 'PASS'], expected: 'INCONCLUSIVE' },
  { name: 'dissent overrides missing merged verdict', verdicts: ['FAIL', 'PASS', 'PASS', 'PASS'], expected: 'FAIL' },
  { name: 'FAIL with explanation overrides merged PASS', status: 'PASS', verdicts: ['FAIL — credential leaked', 'PASS', 'PASS', 'PASS'], expected: 'FAIL' },
  { name: 'FAIL with explanation overrides missing merged verdict', verdicts: ['FAIL — credential leaked', 'PASS', 'PASS', 'PASS'], expected: 'FAIL' },
  { name: 'FAIL records every incomplete condition', status: 'FAIL', verdicts: [null, 'garbled', 'INCONCLUSIVE', 'PASS'], expected: 'FAIL', notes: ['left no report', 'could not be read', 'could not determine every check'],
    publicRows: ['| `audit-supply-chain.md` | no report |', '| `audit-ci-secrets.md` | unreadable |', '| `audit-application.md` | INCONCLUSIVE |', '| `audit-hosted.md` | PASS |'] },
  { name: 'dissent and incomplete domains coexist', status: 'PASS', verdicts: ['FAIL', null, 'INCONCLUSIVE', 'PASS'], expected: 'FAIL', notes: ['returned `FAIL`', 'left no report', 'could not determine every check'] },
  // A domain cut off between rewriting its verdict line and writing its
  // sentinel reads as a clean PASS on line 1. Without the sentinel guard that
  // is a merged PASS over a report that stopped early, and PASS opens the
  // release gate.
  { name: 'PASS without a sentinel is a cut-off domain', status: 'PASS', verdicts: ['PASS', 'PASS', 'PASS', 'PASS'], unfinished: [2], expected: 'INCONCLUSIVE', notes: ['cut off mid-report'],
    publicRows: ['| `audit-application.md` | PASS, cut off |'] },
  { name: 'a cut-off FAIL is still a finding', status: 'PASS', verdicts: ['PASS', 'PASS', 'FAIL', 'PASS'], unfinished: [2], expected: 'FAIL', notes: ['returned `FAIL`', 'cut off mid-report'] },
  { name: 'a trailing blank line still ends a report', status: 'PASS', verdicts: ['PASS', 'PASS', 'PASS', 'PASS'], trailingBlank: true, expected: 'PASS' },
  // The no-verdict note is the reader's index into the merged report, so it
  // names every marker the merge can leave there. Drop one and the reader is
  // told to look for two shapes in a report that has three.
  { name: 'the no-verdict note names every report marker', verdicts: ['PASS', 'PASS', 'PASS', 'PASS'], unfinished: [2], expected: 'INCONCLUSIVE', notes: ['`UNVERIFIABLE`', '`_Incomplete …_`', '`_No report …_`'] },
  // Run 34581574869 ended its turn before §3, so no merged report existed and
  // this arm published a single line — while two domains' finished `VERDICT:
  // PASS` fragments sat in the working directory and reached a human only
  // through the artifact. The fragments are what the run found; the absence of
  // a merge is not a reason to drop them.
  // Cut off, not absent: this arm runs the same sentinel test the guard loop
  // above does, so all three domain states read the same here as in a merged
  // report. Without the `_Incomplete …_` marker the no-verdict note sends the
  // reader after a third marker the body does not carry, and the cut-off
  // domain's fragment is published looking finished.
  // Anchored to its heading and counted, because a bare `notes` entry is
  // satisfied by the marker appearing anywhere: dropping the sentinel test
  // marks every fragment and inverting it marks the finished one, and both
  // read as a pass. Those are the inverse of the bug this arm fixes.
  { name: 'no merged report publishes the fragments, marking cut-off and absent domains', report: null, verdicts: ['PASS', 'PASS', null, 'PASS'], unfinished: [1], expected: 'INCONCLUSIVE',
    notes: ['the merge never ran', '## audit-supply-chain.md', 'VERDICT: PASS', '## audit-application.md', '_No report — this domain produced no fragment._',
      '## audit-ci-secrets.md\n\n_Incomplete — this domain never closed its report'],
    counts: { '_Incomplete — this domain never closed its report': 1 } },
  // Run 35842217451 composed a 226,302-character body; the clamp keeps the
  // head, so what reached the issue was `VERDICT: INCONCLUSIVE` for
  // `audit-ci-secrets.md` without the one `UNVERIFIABLE` line the note sends
  // the reader to, and without two later domains' sections at all. Every
  // verdict and non-passing finding is lifted into the head ahead of the
  // report, where the clamp cannot reach it.
  { name: 'the lines that decided the verdict outlive truncation', status: 'PASS',
    verdicts: ['PASS', 'INCONCLUSIVE', 'PASS', 'PASS'],
    evidence: [null, '- UNVERIFIABLE: token scope needs a live credential', null, null],
    report: `# Fixture report\n${'filler paragraph. '.repeat(3000)}\n`,
    expected: 'INCONCLUSIVE', split: true,
    notes: ['- `audit-ci-secrets.md`: - UNVERIFIABLE: token scope needs a live credential',
      '- `audit-hosted.md`: VERDICT: PASS'] },
  // The lift reads line starts, so the `FAIL IF` vocabulary every fragment is
  // written in must not read as a finding: a passing clause quoting one, and
  // the heading the list sits under, are both PASS evidence.
  { name: 'a passing FAIL IF clause is not lifted as a finding', status: 'PASS',
    verdicts: ['PASS', 'PASS', 'PASS', 'PASS'],
    evidence: ['### FAIL IF results\n- PASS: **FAIL IF** a secret leaks — none does.', null, null, null],
    unfinished: [0], expected: 'INCONCLUSIVE',
    counts: { 'FAIL IF': 0 } },
  // A fragment carrying no marker line at all — the unreadable-verdict state
  // the guard loop above already reports. The lift's `grep` matches nothing
  // and exits 1; without `|| true` this step's `set -eo pipefail` ends it
  // before the body is composed, so the reader gets a red run and an artifact
  // instead of a truncated report. `raw` bypasses the verdict-line prefix
  // every other fixture fragment carries.
  { name: 'a fragment with no marker line still gets reported', status: 'PASS',
    verdicts: ['PASS', 'PASS', 'PASS', 'PASS'],
    raw: [null, null, '# audit-application.md\n\nI reviewed the specs but could not finish.\n', null],
    expected: 'INCONCLUSIVE', posts: true,
    notes: ["A domain's verdict could not be read", '- `audit-hosted.md`: VERDICT: PASS'] },
  // The cap falls on the findings alone, so one domain's findings cannot push
  // a later domain's verdict out of the head — the loss the lift exists to
  // prevent. 42 findings in the first fragment is two past the cap.
  { name: 'findings past the cap do not push out a later verdict', status: 'PASS',
    verdicts: ['PASS', 'PASS', 'PASS', 'PASS'],
    evidence: [Array.from({ length: 42 }, (_, i) => `WARNING: finding ${i}`).join('\n'), null, null, null],
    unfinished: [0], expected: 'INCONCLUSIVE',
    notes: ['- `audit-hosted.md`: VERDICT: PASS', 'more findings; read them in the transcript'] },
];
for (const scenario of cases) {
  test(`reporting: ${scenario.name}`, (t) => {
    const { dir, env } = fixture(t);
    stubGh(dir);
    if (scenario.status !== undefined) writeFileSync(join(dir, 'audit-status.txt'), scenario.status);
    if (scenario.report !== null) writeFileSync(join(dir, 'audit-report.md'), scenario.report ?? '# Fixture report\n');
    const written = [];
    scenario.verdicts.forEach((verdict, i) => {
      if (verdict === null) return;
      const sentinel = scenario.unfinished?.includes(i)
        ? ''
        : `${SENTINEL}\n${scenario.trailingBlank ? '\n' : ''}`;
      const evidence = scenario.evidence?.[i] ?? 'Evidence';
      const text = scenario.raw?.[i] ?? `VERDICT: ${verdict}\n${evidence}\n${sentinel}`;
      written.push(text);
      writeFileSync(join(dir, fragments[i]), text);
    });
    const { surfaced } = runReporting(dir, env);
    assert.equal(surfaced.status, scenario.expected === 'PASS' ? 0 : 1, surfaced.stderr);
    const calls = ghCalls(dir);
    assert.equal(calls.some(({ args }) => args[0] === 'issue' && args[1] === 'close'), scenario.expected === 'PASS');
    if (scenario.expected === 'PASS') {
      // A pass files nothing, in either tracker.
      assert.ok(!calls.some(({ args }) => args[0] === 'issue' && (args[1] === 'create' || args[1] === 'comment')));
      return;
    }
    // The step aborting before it posts leaves every `notes` assertion below
    // unreachable, so name the post itself.
    if (scenario.posts) {
      assert.ok(calls.some(({ args, embargo }) => !embargo && args[0] === 'issue' && args[1] === 'comment'), 'no public issue comment was posted');
    }
    const body = readFileSync(join(dir, 'audit-private.md'), 'utf8');
    assert.match(body, scenario.expected === 'FAIL' ? /Audit failed/ : /Audit reached no usable verdict/);
    // The deciding lines are in the head, the issue's own body, whatever the split does.
    const parts = privateParts(dir);
    const head = scenario.split ? parts[0] : body;
    // Without this the split case passes vacuously on a body that fit.
    if (scenario.split) assert.ok(parts.length > 1 && parts.every((part) => part.length <= BODY_LIMIT), `parts: ${parts.length}`);
    for (const note of scenario.notes ?? []) assert.ok(head.includes(note), `missing note: ${note}`);
    for (const [note, n] of Object.entries(scenario.counts ?? {})) {
      assert.equal(body.split(note).length - 1, n, `wrong occurrence count for: ${note}`);
    }
    // The private issue received every part, in order, under the embargo token.
    const filed = calls.filter(({ embargo }) => embargo);
    assert.deepEqual(filed.map(({ body: posted }) => posted), parts);
    assert.ok(filed.every(({ token }) => token === 'fixture-embargo-token'));
    // The public issue carries none of what a domain wrote beyond its verdict.
    const published = calls.filter(({ embargo, body: posted }) => !embargo && posted !== null);
    assert.equal(published.length, 1);
    assert.ok(published.every(({ token }) => token === 'fixture-workflow-token'));
    const publicBody = published[0].body;
    assert.match(publicBody, scenario.expected === 'FAIL' ? /^Audit failed/ : /^Audit reached no usable verdict/);
    assert.ok(!publicBody.includes('Fixture report') && !publicBody.includes('filler paragraph'));
    for (const text of written) {
      for (const line of text.split('\n').filter((l) => l.length > 6 && !/^VERDICT: (PASS|INCONCLUSIVE)$/.test(l) && l !== SENTINEL)) {
        assert.ok(!publicBody.includes(line), `the public body carries fragment text: ${line}`);
      }
    }
    for (const row of scenario.publicRows ?? []) assert.ok(publicBody.includes(row), `missing public row: ${row}`);
  });
}

// The two sinks the redactor guards are the encrypted archive and the private
// issue, which is composed from the same files.
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

const STATE_FAIL = [
  'VERDICT: FAIL', '', '### FAIL IF results', '',
  '- PASS: `docs/specs/security-ci.md` -> "Automated Maintainer (tend)" — `tend` holds exactly the secrets the inventory places there: fixture',
  '- FAIL: `docs/specs/security-ci.md` -> "VS Code Extension Releases" — `vscode-extension-publish` sets `prevent_self_review: true`: prevent_self_review false',
  '', SENTINEL, '',
].join('\n');

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
    for (const f of fragments) writeFileSync(join(dir, f), `VERDICT: PASS\n${SENTINEL}\n`);
    if (state === null) rmSync(join(dir, STATE_FRAGMENT));
    else writeFileSync(join(dir, STATE_FRAGMENT), state);
    const { surfaced, outputs } = runReporting(dir, env);
    assert.equal(surfaced.status, 1);
    assert.equal(outputs.compose.status, expected === 'FAIL' ? 'FAIL' : 'MISSING');
    const publicBody = ghCalls(dir).find(({ embargo, body }) => !embargo && body !== null).body;
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
const SKIP_FRAGMENTS = "${{ steps.plan.outputs.skip == 'true' && 'audit-github-state.md' || env.AUDIT_FRAGMENTS }}";
test('a skipped run narrows the reporting steps to the deterministic fragment', () => {
  for (const name of ['Compose the audit report', 'Surface result, file or close issue']) {
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
    writeFileSync(join(dir, 'audit-report.md'), '# Security audit\n\nThe four domains were skipped.\n');
    if (state) writeFileSync(join(dir, STATE_FRAGMENT), state);
    const { surfaced, outputs } = runReporting(dir, { ...env, AUDIT_FRAGMENTS: STATE_FRAGMENT });
    assert.equal(outputs.compose.status, expected);
    assert.equal(surfaced.status, expected === 'PASS' ? 0 : 1, surfaced.stderr);
    if (expected === 'FAIL') {
      const publicBody = ghCalls(dir).find(({ embargo, body }) => !embargo && body !== null).body;
      assert.ok(!publicBody.includes('audit-supply-chain.md'), publicBody);
    }
  });
}

const HASH = 'a'.repeat(64);
const SHA = COMMIT;
const NOW = new Date('2026-10-07T12:00:00Z');
const prior = (overrides = {}, state = {}) => ({ id: 41, conclusion: 'success',
  state: { commit: SHA, state_hash: HASH, full_run_at: '2026-10-05T12:00:00Z', mode: 'full', ...state }, ...overrides });
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
    const decision = decide({ event: 'schedule', sha: SHA, hash: HASH, now: NOW, ...input });
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
  copyFileSync(join(repo, 'scripts/security-audit-plan.mjs'), join(dir, 'scripts/security-audit-plan.mjs'));
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
  const run = (event) => spawnSync(process.execPath, [join(dir, 'scripts/security-audit-plan.mjs')], { cwd: dir, encoding: 'utf8',
    env: { ...env, GITHUB_EVENT_NAME: event, STATE_HASH: HASH, GITHUB_OUTPUT: output } });
  const skipped = run('schedule');
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(readFileSync(output, 'utf8'), /^skip=true$/m);
  assert.equal(readFileSync(join(dir, 'audit-status.txt'), 'utf8'), 'PASS\n');
  assert.match(readFileSync(join(dir, 'audit-report.md'), 'utf8'), /four domains were skipped: .*run 41/);
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
  assert.ok(!existsSync(join(dir, 'audit-status.txt')) && !existsSync(join(dir, 'audit-report.md')));
  assert.equal(JSON.parse(readFileSync(join(dir, 'audit-state/audit-state.json'), 'utf8')).mode, 'full');
});

// --- Embargo: detail goes private, the public issue gets verdicts and counts ---

// Issue #1027 published a working command-injection payload. A FAIL line and a
// BLOCKER carrying one, a FAIL line naming a heading no spec has, and a
// verdict line with an appended explanation: none of their text may reach the
// public body, and all of it must reach the private issue.
const EXPLOIT = '$(printf calc-injected-7f3a)';
test('the public issue carries counts and verified section names, never finding text', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'FAIL');
  writeFileSync(join(dir, 'audit-report.md'), `# Security audit\n\nThe merged report quotes ${EXPLOIT}.\n`);
  writeFileSync(join(dir, fragments[0]), `VERDICT: PASS\n- PASS: fine\n${SENTINEL}\n`);
  writeFileSync(join(dir, fragments[1]), [
    `VERDICT: FAIL — ${EXPLOIT}`,
    '### FAIL IF results',
    `- FAIL: \`docs/specs/security-audit.md\` -> "Environment and \`AUDIT_PAT\`" — reproduced with ${EXPLOIT}`,
    `- FAIL: \`docs/specs/security-audit.md\` -> "Run ${EXPLOIT} to see" — a heading no spec has`,
    '- PASS: `docs/specs/security-ci.md` -> "GitHub Actions Policies" — pinned',
    '### Qualitative findings',
    `- BLOCKER: the reporter runs ${EXPLOIT}`,
    `- **WARNING** — ${EXPLOIT} again`,
    '- INFO: nothing to see',
    SENTINEL, '',
  ].join('\n'));
  writeFileSync(join(dir, fragments[2]), `VERDICT: PASS\n${SENTINEL}\n`);
  writeFileSync(join(dir, fragments[3]), `VERDICT: PASS\n${SENTINEL}\n`);
  const { surfaced } = runReporting(dir, env);
  assert.equal(surfaced.status, 1, surfaced.stderr);
  const calls = ghCalls(dir);
  const publicBody = calls.find(({ embargo, body }) => !embargo && body !== null).body;
  assert.ok(!publicBody.includes('calc-injected-7f3a'), publicBody);
  assert.ok(publicBody.includes(`| \`${fragments[1]}\` | FAIL | 2 | 1 | 1 |`), publicBody);
  assert.ok(publicBody.includes('- `docs/specs/security-audit.md` -> "Environment and `AUDIT_PAT`"'), publicBody);
  assert.ok(publicBody.includes('1 failed check named no section heading'), publicBody);
  assert.ok(publicBody.includes(COMMIT), publicBody);
  assert.match(publicBody, /triaged privately until fixed/);
  const privately = calls.filter(({ embargo }) => embargo).map(({ body }) => body).join('');
  assert.ok(privately.includes(`The merged report quotes ${EXPLOIT}.`), privately);
  assert.ok(privately.includes(`- BLOCKER: the reporter runs ${EXPLOIT}`), privately);
});

test('a long report is split across the private issue and its comments, losing nothing', (t) => {
  const { dir, env } = fixture(t);
  stubGh(dir);
  writeFileSync(join(dir, 'audit-status.txt'), 'FAIL');
  const tail = `- FAIL: the finding past the old cut ${EXPLOIT}`;
  writeFileSync(join(dir, 'audit-report.md'), `# Security audit\n${'filler line of a long report.\n'.repeat(4000)}${tail}\n`);
  fragments.forEach((f, i) => writeFileSync(join(dir, f), `VERDICT: ${i ? 'PASS' : 'FAIL'}\n${SENTINEL}\n`));
  runReporting(dir, env);
  const filed = ghCalls(dir).filter(({ embargo }) => embargo);
  assert.ok(filed.length >= 4, `filed ${filed.length} part(s)`);
  assert.deepEqual(filed.map(({ args }) => args[1]), ['create', ...Array(filed.length - 1).fill('comment')]);
  assert.ok(filed[0].args.includes(EMBARGO_REPO));
  assert.ok(filed.every(({ body }) => body.length <= BODY_LIMIT));
  assert.ok(filed.at(-1).body.includes(tail));
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
    fragments.forEach((f, i) => writeFileSync(join(dir, f), `VERDICT: ${i ? 'PASS' : 'FAIL'}\n- BLOCKER: ${EXPLOIT}\n${SENTINEL}\n`));
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
function fakeStateCheck(dir) {
  writeFileSync(join(dir, 'scripts/github-state-check.mjs'), `
    import { appendFileSync, writeFileSync } from 'node:fs';
    if (!process.argv.includes('--local')) process.exit(9);
    appendFileSync('state-check-calls', 'called\\n');
    writeFileSync(process.argv[process.argv.indexOf('--out') + 1], 'VERDICT: ' + (process.env.FAKE_STATE_VERDICT ?? 'PASS') + '\\n\\n${SENTINEL}\\n');
  `);
}

for (const [verdict, cliExit, expected, sentinel = true, stateVerdict = 'PASS'] of [['PASS', 0, 0], ['FAIL', 0, 1], ['FAIL \u2014 explained', 0, 1], ['INCONCLUSIVE', 0, 1], ['PASS extra', 0, 1], ['PASS', 7, 1], ['PASS', 0, 1, false], ['FAIL', 0, 1, false], ['PASS', 0, 1, true, 'FAIL'], ['PASS', 0, 1, true, 'INCONCLUSIVE']]) {
  test(`local runner: ${verdict}, CLI exit ${cliExit}${sentinel ? '' : ', no sentinel'}${stateVerdict === 'PASS' ? '' : `, GitHub state ${stateVerdict}`}`, (t) => {
    const { dir, env: base } = fixture(t);
    const env = { ...base, FAKE_STATE_VERDICT: stateVerdict };
    copyFileSync(join(repo, 'scripts/security-audit-local.sh'), join(dir, 'scripts/security-audit-local.sh'));
    fakeStateCheck(dir);
    mkdirSync(join(dir, '.github/audit'), { recursive: true });
    for (const name of ['_preamble', 'orchestrator', 'supply-chain', 'ci-and-secrets', 'application-security', 'hosted']) {
      copyFileSync(join(repo, `.github/audit/${name}.md`), join(dir, `.github/audit/${name}.md`));
    }
    stubGh(dir);
    stub(dir, 'claude', `
      const fs = require('node:fs');
      const prompt = process.argv[3];
      const output = prompt.match(/\\*\\*Output file:\\*\\* \\x60([^\\x60]+)\\x60/)[1];
      fs.writeFileSync(output, ${JSON.stringify(`VERDICT: ${verdict}\nEvidence\n${sentinel ? `${SENTINEL}\n\n` : ''}`)});
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
    for (const fragment of allFragments) assert.ok(existsSync(join(dir, fragment)), fragment);
    assert.equal(readFileSync(join(dir, STATE_FRAGMENT), 'utf8').split('\n')[0], `VERDICT: ${stateVerdict}`);
    // Local output stays local: the runner files nothing, anywhere.
    assert.deepEqual(ghCalls(dir), []);
  });
}

// One domain at a time: the deterministic check runs ahead of the two domains
// that read its fragment, alone on request, and not before the others.
for (const [arg, runsState, runsDomain] of [['github-state', true, false], ['ci-and-secrets', true, true], ['supply-chain', true, true], ['hosted', false, true]]) {
  test(`local runner: \`${arg}\` ${runsState ? 'runs' : 'skips'} the GitHub-state check`, (t) => {
    const { dir, env } = fixture(t);
    rmSync(join(dir, STATE_FRAGMENT));
    copyFileSync(join(repo, 'scripts/security-audit-local.sh'), join(dir, 'scripts/security-audit-local.sh'));
    for (const name of ['_preamble', 'orchestrator', 'supply-chain', 'ci-and-secrets', 'application-security', 'hosted']) {
      copyFileSync(join(repo, `.github/audit/${name}.md`), join(dir, `.github/audit/${name}.md`));
    }
    fakeStateCheck(dir);
    stub(dir, 'claude', `
      const fs = require('node:fs');
      const output = process.argv[3].match(/\\*\\*Output file:\\*\\* \\x60([^\\x60]+)\\x60/)[1];
      fs.writeFileSync(output, ${JSON.stringify(`VERDICT: PASS\n${SENTINEL}\n`)});
      fs.appendFileSync('claude-calls', output + '\\n');
    `);
    const result = spawnSync('bash', ['scripts/security-audit-local.sh', arg], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dir, 'state-check-calls')), runsState);
    assert.equal(existsSync(join(dir, 'claude-calls')), runsDomain);
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
    .replace("<every delegate's output file is complete>", '[ -f delegates-done ]');
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

// --- docs/specs/security-audit.md's textual rules about the workflow and prompts ---

const release = readFileSync(join(repo, '.github/workflows/release.yml'), 'utf8');
const local = readFileSync(join(repo, 'scripts/security-audit-local.sh'), 'utf8');
const agents = JSON.parse(stepText('Audit against the security specs').match(/--agents '(.+)'$/m)[1]);
const DOMAINS = ['supply-chain', 'ci-and-secrets', 'application-security', 'hosted'];

// "Schedule and gate": nightly and on dispatch, and three separate things make
// it the release gate — the dispatch, the failing watch, and the `needs:` edge.
test('the audit runs nightly and on dispatch, and gates the VS Code publish', () => {
  assert.match(workflow, /^on:\n  schedule:\n    - cron: "21 4 \* \* \*"\n  workflow_dispatch:\n/m);
  const gate = workflowRunBlock(release, 'Dispatch security audit and gate on its result').replace(/^\s*#.*$/gm, '');
  assert.match(gate, /^set -euo pipefail$/m);
  assert.match(gate, /^workflow="security-audit\.yaml"$/m);
  assert.match(gate, /^gh workflow run "\$workflow" -R "\$repo" --ref "\$tag"$/m);
  assert.match(gate, /^gh run watch "\$run_id" -R "\$repo" --exit-status$/m);
  const publish = release.slice(release.indexOf('\n  publish-vscode:\n'));
  assert.match(publish, /^    needs:\n(?:      - .+\n)*      - security-audit\n/m);
});

// "Domains": the code-reading domains on Opus, the mechanical ones on the
// Sonnet floor, in CI and in the local runner alike; every prompt file either
// names exists, and both read the same files.
test('the model split holds in CI and locally, over the same prompt files', () => {
  assert.match(stepText('Audit against the security specs'), /^            --model sonnet$/m);
  assert.deepEqual(Object.keys(agents).sort(), [...DOMAINS].sort());
  for (const domain of DOMAINS) {
    assert.equal(agents[domain].model, ['application-security', 'hosted'].includes(domain) ? 'opus' : undefined, domain);
    assert.ok(agents[domain].prompt.includes(`\`.github/audit/${domain}.md\``), domain);
  }
  for (const file of [...JSON.stringify(agents).matchAll(/\.github\/audit\/([\w-]+\.md)/g)].map((m) => m[1]).concat('orchestrator.md')) {
    assert.ok(existsSync(join(repo, '.github/audit', file)), file);
  }
  assert.match(local, /^  local model_args="--model sonnet"$/m);
  assert.match(local, /^  case "\$domain" in application-security\|hosted\) model_args="--model opus" ;; esac$/m);
  assert.match(local, /^for f in _preamble orchestrator supply-chain ci-and-secrets application-security hosted; do$/m);
  assert.match(local, /cat "\$AUDIT_DIR\/_preamble\.md"; echo; cat "\$AUDIT_DIR\/\$domain\.md"/);
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
  for (const name of ['Redact secrets from agent output', 'Encrypt the audit transcript', 'Compose the audit report', 'Surface result, file or close issue']) {
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
