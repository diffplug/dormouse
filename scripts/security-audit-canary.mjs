#!/usr/bin/env node
/**
 * The security audit's canary: how many known vulnerabilities, re-introduced in
 * a throwaway checkout, its code domains catch. See docs/specs/security-audit.md
 * -> "Canary recall" for the contract.
 *
 *   node scripts/security-audit-canary.mjs seed --key <key> --count <n> --stash <dir>
 *     In the working directory: apply up to <n> seeds from `.github/audit/canaries/`,
 *     in an order <key> fixes, skipping one that does not apply over those
 *     before it; delete that directory; and replace the git history with one
 *     root commit, so nothing in the checkout says which changes are seeds.
 *     Writes the seeds applied to <dir>/seeds.json, outside the checkout.
 *   node scripts/security-audit-canary.mjs score --stash <dir> --scorecard <file> --public <file>
 *       [--run-url <url>] [--summary <file>]
 *     Score the code domains' fragments in the working directory against
 *     <dir>/seeds.json: the scorecard, with seed detail, for the encrypted
 *     archive; the public record, counts alone; and one summary line appended
 *     to <file>.
 *   node scripts/security-audit-canary.mjs domains
 *     The domains a canary runs, space-separated.
 *   node scripts/security-audit-canary.mjs redact <file>...
 *     Replace `CLAUDE_CODE_OAUTH_TOKEN`'s value in each file; exits non-zero if
 *     any file could not be rewritten.
 *
 * A seed is one patch: a header of `Key: value` lines, a blank line, then the
 * diff. `Domain:` is the domain that owns what it breaks; `Rule:` names the
 * `FAIL IF` it violates as a result line names one, then ` — ` and a phrase
 * from that rule, or `Class:` the qualitative class; `Expect:` lists the files
 * a catch must cite; `Source:` says where it came from.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULE_ID, domains, parseFragment, readFragment, ruleId } from './security-audit-report.mjs';

export const POOL_DIR = '.github/audit/canaries';
/** The domains a canary runs: the code-reading ones. `ci-and-secrets` reads live GitHub state, which a checkout cannot seed. */
export const CANARY_DOMAINS = ['supply-chain', 'application-security', 'hosted'];
/** What the replacement history says, the same on every run. */
const COMMIT_MESSAGE = 'Audited tree';
const HEADER_RE = /^(Domain|Rule|Class|Expect|Source): (\S.*)$/;
const RULE_RE = new RegExp(`^${RULE_ID} — (\\S.*)$`);
const RUN_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/;

// --- The pool ---------------------------------------------------------------

/** One seed's header and the files its diff touches; throws on a header out of form. */
export function parseSeed(id, text) {
  const blank = text.indexOf('\n\n');
  if (blank < 0) throw new Error(`${id}: no blank line after the header`);
  const header = {};
  for (const line of text.slice(0, blank).split('\n')) {
    const m = line.match(HEADER_RE);
    if (!m || m[1] in header) throw new Error(`${id}: header line out of form: ${JSON.stringify(line)}`);
    header[m[1]] = m[2];
  }
  if (!CANARY_DOMAINS.includes(header.Domain)) throw new Error(`${id}: Domain must be one of ${CANARY_DOMAINS.join(', ')}`);
  if (('Rule' in header) === ('Class' in header)) throw new Error(`${id}: exactly one of Rule and Class`);
  let rule = null;
  if (header.Rule) {
    const m = header.Rule.match(RULE_RE);
    if (!m) throw new Error(`${id}: Rule must read \`spec\` -> "heading" #n — <phrase from the rule>`);
    rule = { spec: m[1], heading: m[2], n: Number(m[3]), phrase: m[4] };
  }
  const files = [...text.slice(blank).matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map((m) => m[1]);
  if (files.length === 0) throw new Error(`${id}: no diff`);
  const expect = (header.Expect ?? '').split(/\s+/).filter(Boolean);
  if (expect.length === 0 || expect.some((f) => !files.includes(f))) throw new Error(`${id}: Expect must name files its diff touches`);
  if (!header.Source) throw new Error(`${id}: no Source`);
  return { id, domain: header.Domain, rule, class: header.Class ?? null, expect, files, source: header.Source };
}

/** Every seed in the pool, by id. */
export function readPool(root = '.') {
  const dir = join(root, POOL_DIR);
  return readdirSync(dir).filter((f) => f.endsWith('.patch')).sort()
    .map((f) => parseSeed(f.slice(0, -'.patch'.length), readFileSync(join(dir, f), 'utf8')));
}

/** The pool in the order `key` fixes: each seed ranked by a hash of the key and its id. */
export function shuffle(pool, key) {
  const rank = (s) => createHash('sha256').update(`${key}\0${s.id}`).digest('hex');
  return [...pool].sort((a, b) => (rank(a) < rank(b) ? -1 : 1));
}

// --- Seed --------------------------------------------------------------------

function git(root, args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'audit', GIT_AUTHOR_EMAIL: 'audit@localhost',
      GIT_COMMITTER_NAME: 'audit', GIT_COMMITTER_EMAIL: 'audit@localhost',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' } });
  if (run.error) throw run.error;
  return run;
}

/**
 * Apply up to `count` seeds, delete the pool, and leave one root commit. Prints
 * counts only: the step log is public, and which seeds ran is the detail the
 * encrypted archive alone carries.
 */
export function seed({ root = '.', key, count, stash }) {
  if (!key) throw new Error('--key is required');
  if (!Number.isInteger(count) || count < 1) throw new Error('--count must be a positive integer');
  const pool = readPool(root);
  const applied = [];
  let skipped = 0;
  for (const s of shuffle(pool, key)) {
    if (applied.length === count) break;
    // One patch per call, so a seed that does not apply over the others leaves
    // nothing behind: `git apply` writes all of a patch or none of it.
    const run = git(root, ['apply', '--whitespace=nowarn', join(POOL_DIR, `${s.id}.patch`)]);
    if (run.status === 0) applied.push(s);
    else skipped++;
  }
  if (applied.length === 0) throw new Error('no seed applied');
  mkdirSync(stash, { recursive: true });
  writeFileSync(join(stash, 'seeds.json'), `${JSON.stringify(applied, null, 2)}\n`);
  rmSync(join(root, POOL_DIR), { recursive: true, force: true });
  // A fresh repository rather than a commit on top: the original commit, its
  // refs, and its reflog would each diff the seeds out.
  rmSync(join(root, '.git'), { recursive: true, force: true });
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', COMMIT_MESSAGE]]) {
    const run = git(root, args);
    if (run.status !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr}`);
  }
  console.log(`Applied ${applied.length} seed(s)${skipped ? `; ${skipped} did not apply over the others and were skipped` : ''}.`);
  return applied;
}

// --- Score -------------------------------------------------------------------

/**
 * The lines that can catch a seed: each `FAIL` result and each BLOCKER or
 * WARNING finding, with the text a citation is looked for in.
 */
function candidates(name, p) {
  return [
    ...p.results.filter((r) => r.status === 'FAIL').map((r) => ({ fragment: name, kind: 'FAIL', text: r.line,
      rule: ruleId(r.spec, r.heading, r.rule) })),
    ...p.findings.filter((f) => f.severity !== 'INFO').map((f) => ({ fragment: name, kind: f.severity, text: f.block.join('\n') })),
  ];
}

/**
 * Whether one line catches one seed: it cites an expected file, and for a
 * `FAIL IF` seed its rule — a `FAIL` result on that rule, or a finding naming
 * the rule's spec file and quoted heading, as the preamble's root-cause
 * spelling (`security-ci.md "GitHub Actions Policies" #2`) and a result id both do.
 */
function catches(line, s) {
  if (!s.expect.some((file) => line.text.includes(file))) return false;
  if (!s.rule) return true;
  return line.kind === 'FAIL'
    ? line.rule === ruleId(s.rule.spec, s.rule.heading, s.rule.n)
    : line.text.includes(basename(s.rule.spec)) && line.text.includes(`"${s.rule.heading}"`);
}

/**
 * The scorecard, from the seeds applied and each canary domain's fragment text
 * (null when absent or empty). `unseeded` counts the lines that could catch a
 * seed and cite no file a seed touched: findings on code no seed changed,
 * which a canary does not file anywhere.
 */
export function score(seeds, fragments) {
  const parsed = Object.entries(fragments).map(([name, text]) => [name, text === null ? null : parseFragment(text)]);
  const lines = parsed.flatMap(([name, p]) => (p ? candidates(name, p) : []));
  const touched = [...new Set(seeds.flatMap((s) => s.files))];
  const results = seeds.map((s) => {
    const by = lines.filter((l) => catches(l, s));
    return { id: s.id, domain: s.domain, rule: s.rule, class: s.class, expect: s.expect, caught: by.length > 0,
      by: by.map((l) => `${l.fragment}: ${l.text.split('\n')[0]}`) };
  });
  const perDomain = Object.fromEntries(CANARY_DOMAINS.map((d) => {
    const mine = results.filter((r) => r.domain === d);
    return [d, { seeded: mine.length, caught: mine.filter((r) => r.caught).length }];
  }));
  const unfinished = parsed.filter(([, p]) => !p?.finished).map(([n]) => n);
  return {
    seeded: results.length,
    caught: results.filter((r) => r.caught).length,
    domains: perDomain,
    unseeded: lines.filter((l) => !touched.some((file) => l.text.includes(file))).length,
    unfinished,
    seeds: results,
  };
}

/** What the canary publishes: counts and the run link, nothing a seed's detail could be read from. */
export function publicRecord(scorecard, runUrl = '') {
  if (runUrl && !RUN_URL_RE.test(runUrl)) throw new Error(`not a run URL: ${JSON.stringify(runUrl)}`);
  return { seeded: scorecard.seeded, caught: scorecard.caught, unfinished: scorecard.unfinished.length, run_url: runUrl };
}

/** The one public line: `canary: 4/6 seeds caught (run)`. */
export function summaryLine(record) {
  const run = record.run_url ? ` ([run](${record.run_url}))` : '';
  const unfinished = record.unfinished ? `; ${record.unfinished} domain(s) left no finished report` : '';
  return `canary: ${record.caught}/${record.seeded} seeds caught${unfinished}${run}`;
}

/** Each canary domain's fragment in the working directory, or null. */
function readFragments() {
  const named = domains('.').filter((d) => CANARY_DOMAINS.includes(d.domain));
  if (named.length !== CANARY_DOMAINS.length) throw new Error('a canary domain has no prompt naming its fragment');
  return Object.fromEntries(named.map((d) => [d.fragment, readFragment(d.fragment)]));
}

// --- Redact ------------------------------------------------------------------

/** Replace each named secret's value in each file that exists; the number replaced. */
export function redact(paths, secrets) {
  let hits = 0;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    let s = readFileSync(p, 'utf8');
    for (const v of secrets) {
      // A short or empty value would turn into a global replace of something innocuous.
      if (!v || v.length < 8) continue;
      const parts = s.split(v);
      hits += parts.length - 1;
      s = parts.join('***');
    }
    writeFileSync(p, s);
  }
  return hits;
}

// --- CLI ---------------------------------------------------------------------

function main(argv) {
  const [command, ...rest] = argv.slice(2);
  const args = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) args[rest[i].slice(2)] = rest[++i] ?? '';
    else args._.push(rest[i]);
  }
  if (command === 'seed') {
    seed({ key: args.key, count: Number(args.count), stash: args.stash });
    return;
  }
  if (command === 'score') {
    const seeds = JSON.parse(readFileSync(join(args.stash, 'seeds.json'), 'utf8'));
    const scorecard = score(seeds, readFragments());
    const record = publicRecord(scorecard, args['run-url'] ?? '');
    for (const [file, value] of [[args.scorecard, scorecard], [args.public, record]]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    }
    if (args.summary) appendFileSync(args.summary, `${summaryLine(record)}\n`);
    console.log(summaryLine(record));
    return;
  }
  if (command === 'redact') {
    const hits = redact(args._, [process.env.CLAUDE_CODE_OAUTH_TOKEN]);
    console.log(hits ? `::warning::Redacted ${hits} literal secret occurrence(s); rotate CLAUDE_CODE_OAUTH_TOKEN.` : 'No literal secret occurrences found.');
    return;
  }
  if (command === 'domains') {
    console.log(CANARY_DOMAINS.join(' '));
    return;
  }
  throw new Error('usage: security-audit-canary.mjs seed|score|redact|domains …');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
