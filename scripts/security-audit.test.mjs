import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot, tempDir, workflowRunBlock } from './lint-kit.mjs';

const repo = repoRoot;
const workflow = readFileSync(join(repo, '.github/workflows/security-audit.yaml'), 'utf8');
const fragments = workflow.match(/^\s+AUDIT_FRAGMENTS: (.+)$/m)[1].split(/\s+/);
const publishedSinks = workflow.match(/          path: \|\n((?:            .*\n)+)/)[1]
  .trim().split('\n').map((line) => line.trim().replace('${{ runner.temp }}/', ''));

// Execute the shipped block, so changes to its parser or guards reach these tests.
const runBlock = (name) => workflowRunBlock(workflow, name);

function fixture(t) {
  const dir = tempDir(t, 'dormouse-audit-');
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(join(repo, 'scripts/clamp-issue-body.mjs'), join(dir, 'scripts/clamp-issue-body.mjs'));
  const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, RUNNER_TEMP: dir,
    AUDIT_FRAGMENTS: fragments.join(' '), GITHUB_REPOSITORY: 'fixture/repo', GITHUB_RUN_ID: '123',
    AUDIT_PAT: 'fixture-admin-token', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth-token' };
  return { dir, env };
}

function stub(dir, name, source) {
  writeFileSync(join(dir, 'bin', name), `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
}

// The one literal every reader waits for and every fixture writes. The
// producer copy in `.github/audit/_preamble.md` is pinned against it below.
const SENTINEL = '<!-- END OF REPORT -->';

const reporting = runBlock('Surface result, file or close issue');
const cases = [
  { name: 'all checks pass', status: 'PASS\n', verdicts: ['PASS', 'PASS', 'PASS'], expected: 'PASS' },
  { name: 'missing merged verdict', verdicts: ['PASS', 'PASS', 'PASS'], expected: 'INCONCLUSIVE' },
  { name: 'embedded whitespace is not PASS', status: 'P A\nSS\n', verdicts: ['PASS', 'PASS', 'PASS'], expected: 'INCONCLUSIVE' },
  { name: 'PASS prefix with a suffix is unreadable', status: 'PASS', verdicts: ['PASS but unfinished', 'PASS', 'PASS'], expected: 'INCONCLUSIVE' },
  { name: 'missing fragment', status: 'PASS', verdicts: [null, 'PASS', 'PASS'], expected: 'INCONCLUSIVE' },
  { name: 'unverifiable checks override merged PASS', status: 'PASS', verdicts: ['INCONCLUSIVE', 'PASS', 'PASS'], expected: 'INCONCLUSIVE' },
  { name: 'dissent overrides missing merged verdict', verdicts: ['FAIL', 'PASS', 'PASS'], expected: 'FAIL' },
  { name: 'FAIL with explanation overrides merged PASS', status: 'PASS', verdicts: ['FAIL — credential leaked', 'PASS', 'PASS'], expected: 'FAIL' },
  { name: 'FAIL with explanation overrides missing merged verdict', verdicts: ['FAIL — credential leaked', 'PASS', 'PASS'], expected: 'FAIL' },
  { name: 'FAIL records every incomplete condition', status: 'FAIL', verdicts: [null, 'garbled', 'INCONCLUSIVE'], expected: 'FAIL', notes: ['left no report', 'could not be read', 'could not determine every check'] },
  { name: 'dissent and incomplete domains coexist', status: 'PASS', verdicts: ['FAIL', null, 'INCONCLUSIVE'], expected: 'FAIL', notes: ['returned `FAIL`', 'left no report', 'could not determine every check'] },
  // A domain cut off between rewriting its verdict line and writing its
  // sentinel reads as a clean PASS on line 1. Without the sentinel guard that
  // is a merged PASS over a report that stopped early, and PASS opens the
  // release gate.
  { name: 'PASS without a sentinel is a cut-off domain', status: 'PASS', verdicts: ['PASS', 'PASS', 'PASS'], unfinished: [2], expected: 'INCONCLUSIVE', notes: ['cut off mid-report'] },
  { name: 'a cut-off FAIL is still a finding', status: 'PASS', verdicts: ['PASS', 'PASS', 'FAIL'], unfinished: [2], expected: 'FAIL', notes: ['returned `FAIL`', 'cut off mid-report'] },
  { name: 'a trailing blank line still ends a report', status: 'PASS', verdicts: ['PASS', 'PASS', 'PASS'], trailingBlank: true, expected: 'PASS' },
];
for (const scenario of cases) {
  test(`reporting: ${scenario.name}`, (t) => {
    const { dir, env } = fixture(t);
    stub(dir, 'gh', `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.appendFileSync('gh-calls.jsonl', JSON.stringify(args) + '\\n');
      if (args[0] === 'issue' && args[1] === 'list') process.stdout.write('23\\n');
    `);
    if (scenario.status !== undefined) writeFileSync(join(dir, 'audit-status.txt'), scenario.status);
    writeFileSync(join(dir, 'audit-report.md'), '# Fixture report\n');
    scenario.verdicts.forEach((verdict, i) => {
      if (verdict === null) return;
      const sentinel = scenario.unfinished?.includes(i)
        ? ''
        : `${SENTINEL}\n${scenario.trailingBlank ? '\n' : ''}`;
      writeFileSync(join(dir, fragments[i]), `VERDICT: ${verdict}\nEvidence\n${sentinel}`);
    });
    const result = spawnSync('bash', ['-c', reporting], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.status, scenario.expected === 'PASS' ? 0 : 1, result.stderr);
    const calls = readFileSync(join(dir, 'gh-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.some((args) => args[0] === 'issue' && args[1] === 'close'), scenario.expected === 'PASS');
    if (scenario.expected !== 'PASS') {
      const body = readFileSync(join(dir, 'audit-comment.md'), 'utf8');
      assert.match(body, scenario.expected === 'FAIL' ? /Audit failed/ : /Audit reached no usable verdict/);
      for (const note of scenario.notes ?? []) assert.ok(body.includes(note), `missing note: ${note}`);
    }
  });
}

test('redaction covers every published sink', (t) => {
  const { dir, env } = fixture(t);
  const sinks = publishedSinks;
  for (const sink of sinks) writeFileSync(join(dir, sink), `${env.AUDIT_PAT} ${env.CLAUDE_CODE_OAUTH_TOKEN}`);
  const result = spawnSync('bash', ['-c', runBlock('Redact secrets from agent output')], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const sink of sinks) assert.equal(readFileSync(join(dir, sink), 'utf8'), '*** ***');
});

test('redactor failure removes every published sink', (t) => {
  const { dir, env } = fixture(t);
  const sinks = publishedSinks;
  for (const sink of sinks) writeFileSync(join(dir, sink), env.AUDIT_PAT);
  stub(dir, 'node', 'process.exit(1);');
  const result = spawnSync('bash', ['-c', runBlock('Redact secrets from agent output')], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  for (const sink of sinks) assert.equal(existsSync(join(dir, sink)), false, sink);
});

// 'FAIL — explained' pins the grammar against CI's: an appended explanation is
// still a finding, not an unreadable fragment. Status alone cannot tell the two
// apart (both exit 1), so that row also checks the message.
// The `false` rows write no sentinel: the local runner rejects a fragment its
// domain stopped short of finishing, exactly as CI's reporting step does, so a
// PASS on line 1 of a cut-off report does not exit zero here either.
for (const [verdict, cliExit, expected, sentinel = true] of [['PASS', 0, 0], ['FAIL', 0, 1], ['FAIL \u2014 explained', 0, 1], ['INCONCLUSIVE', 0, 1], ['PASS extra', 0, 1], ['PASS', 7, 1], ['PASS', 0, 1, false]]) {
  test(`local runner: ${verdict}, CLI exit ${cliExit}${sentinel ? '' : ', no sentinel'}`, (t) => {
    const { dir, env } = fixture(t);
    copyFileSync(join(repo, 'scripts/security-audit-local.sh'), join(dir, 'scripts/security-audit-local.sh'));
    mkdirSync(join(dir, '.github/audit'), { recursive: true });
    for (const name of ['_preamble', 'orchestrator', 'supply-chain', 'ci-and-secrets', 'application-security']) {
      copyFileSync(join(repo, `.github/audit/${name}.md`), join(dir, `.github/audit/${name}.md`));
    }
    stub(dir, 'claude', `
      const fs = require('node:fs');
      const prompt = process.argv[3];
      const output = prompt.match(/\\*\\*Output file:\\*\\* \\x60([^\\x60]+)\\x60/)[1];
      fs.writeFileSync(output, ${JSON.stringify(`VERDICT: ${verdict}\nEvidence\n${sentinel ? '<!-- END OF REPORT -->\n' : ''}`)});
      process.exit(${cliExit});
    `);
    // The all-domains path calls run_domain in a conditional: Bash disables
    // errexit inside it, so a failed CLI needs an explicit return.
    const result = spawnSync('bash', ['scripts/security-audit-local.sh'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
    if (verdict.startsWith('FAIL')) {
      assert.ok(!result.stderr.includes('no readable verdict'), result.stderr);
    }
    if (!sentinel) assert.match(result.stderr, /cut off before finishing/);
    for (const fragment of fragments) assert.ok(existsSync(join(dir, fragment)), fragment);
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
// Just the predicate, not the loop around it: the loop blocks for 25 minutes
// by design, and what needs pinning is what it blocks on.
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

const merge = promptShellBlock(orchestrator, 'audit-report.md');

test('merge distinguishes finished, cut-off, and absent domains', (t) => {
  const dir = tempDir(t, 'dormouse-audit-merge-');
  writeFileSync(join(dir, 'audit-supply-chain.md'), `VERDICT: PASS\nsupply evidence\n\n${SENTINEL}\n`);
  writeFileSync(join(dir, 'audit-ci-secrets.md'), 'VERDICT: INCONCLUSIVE\nci evidence\n');
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
});
