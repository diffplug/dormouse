import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { CANARY_DOMAINS, POOL_DIR, parseSeed, publicRecord, readPool, redact, score, summaryLine } from './security-audit-canary.mjs';
import { SENTINEL, domains, ruleNumber } from './security-audit-report.mjs';
import { repoRoot as repo, tempDir, workflowRunBlock } from './lint-kit.mjs';

// docs/specs/security-audit.md -> "Canary recall".

const workflow = readFileSync(join(repo, '.github/workflows/security-audit.yaml'), 'utf8');
const release = readFileSync(join(repo, '.github/workflows/release.yml'), 'utf8');
const orchestrator = readFileSync(join(repo, '.github/audit/orchestrator.md'), 'utf8');
/** One job's text, from its key to the next job's. */
function jobText(id) {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  assert.ok(start >= 0, `missing job: ${id}`);
  const next = workflow.slice(start + 1).search(/\n {2}[\w-]+:\n/);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}
const canary = jobText('canary');
const audit = jobText('audit');
const canaryBlock = (name) => workflowRunBlock(canary, name);
const agentsOf = (job) => JSON.parse(job.match(/--agents '(.+)'$/m)[1]);
const fragmentOf = Object.fromEntries(domains(repo).map((d) => [d.domain, d.fragment]));
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

// --- The pool ---------------------------------------------------------------

// A stale seed is one that no longer applies, or whose rule moved: either would
// measure nothing on the night it is drawn, so `pnpm test` fails first.
test('every canary parses, names a rule its domain owns, and applies to this tree', () => {
  const pool = readPool(repo);
  assert.ok(pool.length >= CANARY_DOMAINS.length, 'the pool is nearly empty');
  for (const s of pool) {
    if (s.rule) {
      const owner = domains(repo).find((d) => d.specs.includes(s.rule.spec));
      assert.equal(owner?.domain, s.domain, `${s.id}: ${s.rule.spec} is not ${s.domain}'s`);
      assert.equal(ruleNumber(repo, s.rule.spec, s.rule.heading, s.rule.phrase), s.rule.n, `${s.id}: the rule moved`);
    }
    const run = spawnSync('git', ['apply', '--check', join(POOL_DIR, `${s.id}.patch`)], { cwd: repo, encoding: 'utf8' });
    assert.equal(run.status, 0, `${s.id} no longer applies: ${run.stderr}`);
  }
});

// One over another too, as the seed step applies them, so a night's draw
// seldom has to skip one. `git apply --check` over several patches checks each
// against the tree alone, so they are applied, in a copy of the files they touch.
test('the whole pool applies, one seed over another', (t) => {
  const dir = tempDir(t, 'dormouse-canary-pool-');
  const pool = readPool(repo);
  for (const file of new Set(pool.flatMap((s) => s.files))) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(repo, file), join(dir, file));
  }
  for (const s of pool) {
    const run = spawnSync('git', ['apply', join(repo, POOL_DIR, `${s.id}.patch`)], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, `${s.id} does not apply over the seeds before it: ${run.stderr}`);
  }
});

// --- Fixtures ---------------------------------------------------------------

const seedPatch = (header, file, from, to) => `${header}

diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -1 +1 @@
-${from}
+${to}
`;
const POOL = {
  // Two seeds on one line: whichever is drawn first, the other cannot apply.
  'gate-a': seedPatch('Domain: application-security\nRule: `docs/specs/security-local.md` -> "Terminal output" #9 — x\nExpect: src/gate.ts\nSource: fixture', 'src/gate.ts', 'check();', 'skip();'),
  'gate-b': seedPatch('Domain: application-security\nClass: fixture\nExpect: src/gate.ts\nSource: fixture', 'src/gate.ts', 'check();', 'never();'),
  room: seedPatch('Domain: hosted\nClass: fixture\nExpect: src/room.ts\nSource: fixture', 'src/room.ts', 'forward();', 'store();'),
};

function stub(bin, name, source) {
  writeFileSync(join(bin, name), `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
}

/**
 * A checkout as the canary job sees it: the scripts and prompts it runs, a pool,
 * and a `gh` and `git` that record each call (`git` then runs the real one).
 */
function checkout(t) {
  const base = tempDir(t, 'dormouse-canary-');
  const dir = join(base, 'checkout');
  const bin = join(base, 'bin');
  const runner = join(base, 'runner');
  for (const sub of [bin, runner, ...['scripts', 'src', 'docs/specs', POOL_DIR].map((d) => join(dir, d))]) mkdirSync(sub, { recursive: true });
  for (const f of ['security-audit-canary.mjs', 'security-audit-report.mjs', 'security-audit-local.sh', 'clamp-issue-body.mjs']) {
    copyFileSync(join(repo, 'scripts', f), join(dir, 'scripts', f));
  }
  for (const e of readdirSync(join(repo, '.github/audit'), { withFileTypes: true }).filter((x) => x.isFile())) {
    copyFileSync(join(repo, '.github/audit', e.name), join(dir, '.github/audit', e.name));
  }
  for (const spec of readdirSync(join(repo, 'docs/specs')).filter((f) => /^security[a-z-]*\.md$/.test(f))) {
    copyFileSync(join(repo, 'docs/specs', spec), join(dir, 'docs/specs', spec));
  }
  writeFileSync(join(dir, 'src/gate.ts'), 'check();\n');
  writeFileSync(join(dir, 'src/room.ts'), 'forward();\n');
  for (const [id, text] of Object.entries(POOL)) writeFileSync(join(dir, POOL_DIR, `${id}.patch`), text);
  // The local runner's stand-in for the GitHub-state check `supply-chain` reads.
  writeFileSync(join(dir, 'scripts/github-state-check.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[process.argv.indexOf('--out') + 1], 'VERDICT: PASS\\n');");
  stub(bin, 'gh', "require('node:fs').appendFileSync(process.env.CALLS, 'gh ' + process.argv.slice(2).join(' ') + '\\n');");
  // A shell stub: every seed step runs git a handful of times.
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "git $*" >> "$CALLS"\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: join(base, 'calls'),
    RUNNER_TEMP: runner, GITHUB_RUN_ID: '4242', GITHUB_REPOSITORY: 'fixture/repo',
    GITHUB_STEP_SUMMARY: join(runner, 'summary.md'), GITHUB_OUTPUT: join(runner, 'output'),
    CANARY_SEEDS: '3', CANARY_FRAGMENTS: CANARY_DOMAINS.map((d) => fragmentOf[d]).join(' '),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', TMPDIR: runner };
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'real history']]) {
    execFileSync(realGit, args, { cwd: dir, env });
  }
  return { base, dir, bin, runner, env };
}

const calls = (base) => (existsSync(join(base, 'calls')) ? readFileSync(join(base, 'calls'), 'utf8').trim().split('\n') : []);

/** A fragment in the grammar `.github/audit/_preamble.md` fixes, finished unless told otherwise. */
const fragment = (lines, { finished = true } = {}) => ['VERDICT: FAIL', '', ...lines, '- QUALITATIVE: done — x', ...(finished ? ['', SENTINEL] : []), ''].join('\n');
const warning = (severity, location, extra = '') => [
  `- ${severity}: \`${location}\` \`cause\` — summary${extra}`,
  '  - Code: `x`', '  - Path: a → b', '  - Reproduction: c → d',
];
const FAIL_GATE = '- FAIL: `docs/specs/security-local.md` -> "Terminal output" #9 — the gate: src/gate.ts:1 skips its check';

// --- Seeding and scoring, as the workflow runs them -------------------------

test('the canary job seeds, hides the seeds, and scores, filing and pushing nothing', (t) => {
  const { base, dir, runner, env } = checkout(t);
  const seeded = spawnSync('bash', ['-c', canaryBlock('Seed the checkout')], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);

  // Two applied — one of the two `gate` seeds and `room` — and the third skipped.
  const seeds = JSON.parse(readFileSync(join(runner, 'canary-stash/seeds.json'), 'utf8'));
  assert.equal(seeds.length, 2);
  assert.ok(seeds.some((s) => s.id === 'room'));
  assert.match(readFileSync(join(dir, 'src/room.ts'), 'utf8'), /store\(\)/);
  // Nothing in the checkout says which changes are seeds: no pool, one root
  // commit with a fixed message, no other ref or reflog to diff against.
  assert.ok(!existsSync(join(dir, POOL_DIR)));
  const log = execFileSync(realGit, ['log', '--all', '--format=%s|%P'], { cwd: dir, env, encoding: 'utf8' }).trim();
  assert.equal(log, 'Audited tree|');
  assert.equal(execFileSync(realGit, ['status', '--porcelain'], { cwd: dir, env, encoding: 'utf8' }), '?? audit-ci-secrets.md\n?? audit-open-findings.txt\n');
  // The domains are handed an empty open-findings list, never the real ledger.
  assert.equal(readFileSync(join(dir, 'audit-open-findings.txt'), 'utf8'), '');
  // The public log names no seed.
  for (const id of Object.keys(POOL)) assert.ok(!seeded.stdout.includes(id), seeded.stdout);
  assert.match(seeded.stdout, /^Applied 2 seed\(s\); 1 did not apply over the others and were skipped\.$/m);
  // The domain the orchestrator would wait on is closed already.
  assert.equal(readFileSync(join(dir, 'audit-ci-secrets.md'), 'utf8').trim().split('\n').at(-1), SENTINEL);

  const gate = seeds.find((s) => s.id.startsWith('gate-'));
  writeFileSync(join(dir, fragmentOf['application-security']), fragment(gate.rule ? [FAIL_GATE] : warning('WARNING', 'src/gate.ts:1')));
  writeFileSync(join(dir, fragmentOf.hosted), fragment(warning('INFO', 'src/room.ts:1')));
  const scored = spawnSync('bash', ['-c', canaryBlock('Score the canary')], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(scored.status, 0, scored.stderr);
  const card = JSON.parse(readFileSync(join(runner, 'canary-stash/scorecard.json'), 'utf8'));
  assert.deepEqual([card.seeded, card.caught, card.unfinished], [2, 1, [fragmentOf['supply-chain']]]);
  const record = JSON.parse(readFileSync(join(runner, 'canary-recall/canary-recall.json'), 'utf8'));
  assert.deepEqual(record, { seeded: 2, caught: 1, unfinished: 1, run_url: 'https://github.com/fixture/repo/actions/runs/4242' });
  assert.equal(readFileSync(join(runner, 'summary.md'), 'utf8'),
    'canary: 1/2 seeds caught; 1 domain(s) left no finished report ([run](https://github.com/fixture/repo/actions/runs/4242))\n');

  assert.ok(!calls(base).some((c) => c.startsWith('gh ')), calls(base).join('\n'));
  assert.ok(!calls(base).some((c) => /^git (?:.* )?push\b/.test(c)), calls(base).join('\n'));
  const everything = execFileSync('find', ['.'], { cwd: base, encoding: 'utf8' });
  assert.doesNotMatch(everything, /audit-state/);
});

// --- The scorer -------------------------------------------------------------

const RULE = { spec: 'docs/specs/security-local.md', heading: 'Terminal output', n: 9, phrase: 'x' };
const seedOf = (id, domain, expect, rule = null, severity = 'WARNING') => ({ id, domain, rule, class: rule ? null : 'fixture', expect, files: expect, source: 'fixture', severity });

test('a seed is caught only by a FAIL or a BLOCKER or WARNING citing its file, and its rule when it has one', () => {
  const seeds = [
    seedOf('rule-by-fail', 'application-security', ['src/a.ts'], RULE),
    seedOf('rule-by-warning', 'application-security', ['src/b.ts'], RULE),
    seedOf('rule-wrong-rule', 'application-security', ['src/c.ts'], RULE),
    seedOf('rule-by-root-cause', 'application-security', ['src/g.ts'], RULE),
    seedOf('class-by-blocker', 'hosted', ['src/d.ts']),
    seedOf('class-by-info', 'hosted', ['src/e.ts']),
    seedOf('class-uncited', 'supply-chain', ['src/f.ts']),
  ];
  const card = score(seeds, {
    [fragmentOf['application-security']]: fragment([
      '- FAIL: `docs/specs/security-local.md` -> "Terminal output" #9.b — clause: src/a.ts:3',
      ...warning('WARNING', 'src/b.ts:4', ' (`docs/specs/security-local.md` -> "Terminal output")'),
      '- FAIL: `docs/specs/security-local.md` -> "Terminal output" #8 — clause: src/c.ts:5',
      ...warning('WARNING', 'src/c.ts:5'),
      // The preamble's spelling of a rule as a root cause.
      '- WARNING: `src/g.ts:2` `security-local.md "Terminal output" #9` — summary',
      '  - Code: `x`', '  - Path: a → b', '  - Reproduction: c → d',
    ]),
    [fragmentOf.hosted]: fragment([...warning('BLOCKER', 'src/d.ts:1'), '- INFO: `src/e.ts:1` `cause` — not a catch', ...warning('WARNING', 'src/z.ts:1'), '- INFO: `src/y.ts:1` `cause` — not counted']),
    [fragmentOf['supply-chain']]: fragment(['A paragraph naming src/f.ts is prose, not a catch.'], { finished: false }),
  });
  assert.deepEqual(card.seeds.filter((s) => s.caught).map((s) => s.id), ['rule-by-fail', 'rule-by-warning', 'rule-by-root-cause', 'class-by-blocker']);
  assert.deepEqual([card.seeded, card.caught], [7, 4]);
  assert.deepEqual(card.domains, {
    'supply-chain': { seeded: 1, caught: 0 },
    'application-security': { seeded: 4, caught: 3 },
    hosted: { seeded: 2, caught: 1 },
  });
  // The one line citing no file a seed touched.
  assert.equal(card.unseeded, 1);
  assert.deepEqual(card.unfinished, [fragmentOf['supply-chain']]);
  assert.match(card.seeds[0].by[0], /^audit-application\.md: - FAIL: /);
});

// Run 37720586893 found `recovery-created-at-nan` and rated it INFO, which it
// is: a seed's `Severity:` is the least finding severity that catches it.
test('a seed\'s Severity sets the least finding severity that catches it', () => {
  const header = (severity) => seedPatch(`Domain: hosted\nClass: fixture\nExpect: src/a.ts\n${severity}Source: fixture`, 'src/a.ts', 'a', 'b');
  assert.equal(parseSeed('default', header('')).severity, 'WARNING');
  assert.equal(parseSeed('low', header('Severity: INFO — hardening\n')).severity, 'INFO');
  assert.throws(() => parseSeed('bare', header('Severity: INFO\n')), /Severity must read/);
  assert.throws(() => parseSeed('unknown', header('Severity: LOW — why\n')), /Severity must read/);
  const seeds = [
    seedOf('info-by-info', 'hosted', ['src/a.ts'], null, 'INFO'),
    seedOf('info-by-loose-info', 'hosted', ['src/g.ts'], null, 'INFO'),
    seedOf('warning-by-info', 'hosted', ['src/b.ts']),
    seedOf('blocker-by-warning', 'hosted', ['src/c.ts'], null, 'BLOCKER'),
    seedOf('blocker-by-blocker', 'hosted', ['src/d.ts'], null, 'BLOCKER'),
    seedOf('rule-by-fail', 'application-security', ['src/e.ts'], RULE, 'BLOCKER'),
    // Written before `Severity:`, as a stash from an older run is.
    { ...seedOf('stashed-by-info', 'hosted', ['src/f.ts']), severity: undefined },
  ];
  const card = score(seeds, {
    [fragmentOf.hosted]: fragment([
      '- INFO: `src/a.ts:1` `cause` — hardening',
      '- INFO: `src/b.ts:1` `cause` — hardening',
      ...warning('WARNING', 'src/c.ts:1'),
      ...warning('BLOCKER', 'src/d.ts:1'),
      '- INFO: `src/f.ts:1` `cause` — hardening',
      // Off the grammar, as the audit lets an INFO be.
      '- INFO: src/g.ts:1 — hardening',
    ]),
    [fragmentOf['application-security']]: fragment(['- FAIL: `docs/specs/security-local.md` -> "Terminal output" #9 — clause: src/e.ts:1']),
  });
  assert.deepEqual(card.seeds.filter((r) => r.caught).map((r) => r.id), ['info-by-info', 'info-by-loose-info', 'blocker-by-blocker', 'rule-by-fail']);
  assert.deepEqual(Object.keys(publicRecord(card)).sort(), ['caught', 'run_url', 'seeded', 'unfinished']);
});

test('a domain with no fragment catches nothing and is unfinished', () => {
  const card = score([seedOf('s', 'hosted', ['src/d.ts'])], { [fragmentOf.hosted]: null });
  assert.deepEqual([card.seeded, card.caught, card.unseeded, card.unfinished], [1, 0, 0, [fragmentOf.hosted]]);
});

// --- What is public ---------------------------------------------------------

test('the public record and summary carry counts and the run link alone', () => {
  const card = score([seedOf('secret-seed-id', 'hosted', ['src/secret-file.ts'], RULE)], {
    [fragmentOf.hosted]: fragment(['- FAIL: `docs/specs/security-local.md` -> "Terminal output" #9 — clause: src/secret-file.ts:1']),
  });
  const runUrl = 'https://github.com/diffplug/dormouse/actions/runs/123';
  const record = publicRecord(card, runUrl);
  assert.deepEqual(Object.keys(record).sort(), ['caught', 'run_url', 'seeded', 'unfinished']);
  const published = JSON.stringify(record) + summaryLine(record);
  for (const detail of ['secret-seed-id', 'secret-file', 'Terminal output', 'security-local', 'hosted', 'FAIL']) {
    assert.ok(!published.includes(detail), detail);
  }
  assert.equal(summaryLine(record), `canary: 1/1 seeds caught ([run](${runUrl}))`);
  assert.throws(() => publicRecord(card, 'https://evil.example/actions/runs/1'), /not a run URL/);
  assert.throws(() => publicRecord(card, `${runUrl})\n- FAIL: x`), /not a run URL/);
});

test('the redactor replaces the token in every file it is handed', (t) => {
  const dir = tempDir(t, 'dormouse-canary-redact-');
  const token = 'sk-ant-oat01-fixture-token';
  for (const f of ['a', 'b']) writeFileSync(join(dir, f), `x ${token} y ${token}`);
  assert.equal(redact([join(dir, 'a'), join(dir, 'b'), join(dir, 'missing')], [token, '']), 4);
  for (const f of ['a', 'b']) assert.equal(readFileSync(join(dir, f), 'utf8'), 'x *** y ***');
});

// --- The workflow -----------------------------------------------------------

test('a canary runs alone, on main alone, with no credential to file or push', (t) => {
  assert.match(workflow, /^ {2}workflow_dispatch:\n {4}inputs:\n(?: {6}#.*\n)* {6}canary:\n(?: {8}.+\n)* {8}type: boolean\n {8}default: false\n/m);
  assert.match(audit, /^ {4}if: \$\{\{ !inputs\.canary \}\}$/m);
  assert.match(canary, /^ {4}if: \$\{\{ inputs\.canary \}\}$/m);
  // `contents: read` alone, and the agent on this job's token: with `id-token`
  // and no `github_token`, claude-code-action mints the Claude App's token.
  assert.match(canary, /^ {4}permissions:\n {6}contents: read\n {4}\S/m);
  assert.match(canary, /^ {10}github_token: \$\{\{ github\.token \}\}$/m);
  assert.match(canary, /^ {10}persist-credentials: false$/m);
  const code = canary.replace(/^\s*#.*$/gm, '');
  for (const banned of [/\bgh\s+\w/, /\bgit\s+push\b/, /audit-state/, /AUDIT_PAT/, /EMBARGO_TOKEN/, /contents:\s*write/, /issues:\s*write/]) {
    assert.doesNotMatch(code, banned, String(banned));
  }
  // The first step refuses every ref but main, the `v*` tags the environment also admits included.
  assert.match(canary, /^ {4}steps:\n {6}- name: Refuse any ref but main\n/m);
  const refuse = canaryBlock('Refuse any ref but main');
  for (const [ref, status] of [['refs/heads/main', 0], ['refs/tags/v1.2.3', 1], ['refs/heads/feature', 1]]) {
    assert.equal(spawnSync('bash', ['-c', refuse], { env: { ...process.env, GITHUB_REF: ref } }).status, status, ref);
  }
  // Every artifact is the ciphertext or the public counts.
  const uploads = [...canary.matchAll(/^ {10}path: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(uploads, ['${{ runner.temp }}/canary-transcript.tar.gz.age', '${{ runner.temp }}/canary-recall/canary-recall.json']);
  assert.match(canary, /- name: Archive the canary transcript\n {8}if: always\(\) && steps\.encrypt\.outcome == 'success'\n/);
  assert.match(canaryBlock('Encrypt the canary transcript'), /age -R \.github\/audit\/transcript-recipient\.txt/);
  // The redactor covers what the archive carries, and deletes it when it throws.
  const redactor = canaryBlock('Redact secrets from canary output');
  assert.match(redactor, /redact "\$TRANSCRIPT" audit-report\.md \$CANARY_FRAGMENTS \\\n\s+\|\| \{ rm -f "\$TRANSCRIPT" audit-report\.md \$CANARY_FRAGMENTS; exit 1; \}/);
  assert.equal(canary.match(/^ {6}CANARY_FRAGMENTS: (.+)$/m)[1], CANARY_DOMAINS.map((d) => fragmentOf[d]).join(' '));
  // The same agent as the audit's, less `ci-and-secrets`.
  const expected = agentsOf(audit);
  delete expected['ci-and-secrets'];
  assert.deepEqual(agentsOf(canary), expected);
  for (const line of ['--model sonnet', '--allowed-tools "Read,Write,Edit,Bash,Grep,Glob,Task,Agent"', '--disallowed-tools "Workflow"']) {
    assert.ok(canary.includes(`            ${line}\n`), line);
  }
  const deadline = Number(orchestrator.match(/\+ (\d+) \)\) > "\$DEADLINE_FILE"/)[1]);
  assert.ok(Number(canary.match(/^ {4}timeout-minutes: (\d+)$/m)[1]) * 60 > deadline);
  t.diagnostic(`canary job checked: ${canary.split('\n').length} lines`);
});

test('the release gate never waits on a canary', () => {
  const title = workflow.match(/^run-name: \$\{\{ inputs\.canary && '([^']+)' \|\| 'security-audit' \}\}$/m)[1];
  const prefix = release.match(/startswith\(\\"([^\\"]+)\\"\) \| not/)[1];
  assert.ok(title.startsWith(prefix) && !'security-audit'.startsWith(prefix), `${title} / ${prefix}`);
  const jq = spawnSync('jq', ['--version']);
  if (jq.status !== 0) return;
  const filter = release.match(/--jq "(.+)"\)"$/m)[1].replace(/\\"/g, '"').replace(/\$sha/g, 'abc').replace(/\$since/g, '2026-01-01');
  const runs = [
    { databaseId: 1, headSha: 'abc', createdAt: '2026-01-02', displayTitle: 'security-audit' },
    { databaseId: 2, headSha: 'abc', createdAt: '2026-01-03', displayTitle: title },
  ];
  assert.equal(execFileSync('jq', [filter], { input: JSON.stringify(runs), encoding: 'utf8' }).trim(), '1');
});

// --- The local runner -------------------------------------------------------

test('the local canary seeds a copy, runs the three code domains, scores, and files nothing', (t) => {
  const { base, dir, bin, env } = checkout(t);
  stub(bin, 'pnpm', '');
  // Every domain reports `room` as the hosted domain would; nothing else.
  stub(bin, 'claude', `
    const fs = require('node:fs');
    const output = process.argv[3].match(/\\*\\*Output file:\\*\\* \\x60([^\\x60]+)\\x60/)[1];
    fs.appendFileSync(process.env.CALLS, 'claude ' + output + '\\n');
    fs.writeFileSync(output, ${JSON.stringify(fragment(warning('WARNING', 'src/room.ts:1')))});
  `);
  const result = spawnSync('bash', ['scripts/security-audit-local.sh', 'canary', '3'], { cwd: dir, env: { ...env, CANARY_KEY: 'k' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^canary: 1\/2 seeds caught$/m);
  assert.deepEqual(calls(base).filter((c) => c.startsWith('claude ')).sort(), CANARY_DOMAINS.map((d) => `claude ${fragmentOf[d]}`).sort());
  assert.ok(!calls(base).some((c) => c.startsWith('gh ')), calls(base).join('\n'));
  // The operator's checkout is as it was.
  assert.equal(execFileSync(realGit, ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '');
  assert.ok(existsSync(join(dir, POOL_DIR, 'room.patch')));
});
