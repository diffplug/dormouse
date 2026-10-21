/**
 * Snapshot of the security audit's canary recall, which /security shows
 * (docs/specs/security-audit.md -> "Canary recall").
 *
 *   node website/scripts/generate-canary-recall.js
 *
 * Through the local `gh` login: lists `security-audit.yaml`'s completed canary
 * runs on `main` created in the last `WINDOW_DAYS` days, downloads each one's
 * `canary-recall` artifact — never `canary-transcript`, which is ciphertext and
 * not ours to open here — validates it, and writes
 * website/src/data/canary-recall.json. The second-opinion audit's records ride
 * along: each successful `codex-audit-report.yaml` run's `codex-recall`,
 * paired with the canary run whose seeds it shares
 * (docs/specs/security-audit.md -> "Second-opinion audit"). Run by hand with the
 * dependency snapshots (docs/specs/deploy.md -> "Release checklist"), because
 * downloading an artifact needs a token even on a public repository, and the
 * site is built by Cloudflare Pages, which holds none.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANARY_DOMAINS } from '../../scripts/security-audit-canary.mjs';

export const REPO = 'diffplug/dormouse';
export const WORKFLOW = 'security-audit.yaml';
/** The canary's `run-name` in `.github/workflows/security-audit.yaml`. */
export const CANARY_TITLE = 'security-audit canary (recall measurement, not an audit)';
export const ARTIFACT = 'canary-recall';
/** The recall window; at most the `canary-recall` artifact's 90-day retention, past which no record is left to read. */
export const WINDOW_DAYS = 30;
/** Every field `publicRecord` in scripts/security-audit-canary.mjs writes, and no other. */
export const RECORD_FIELDS = ['caught', 'run_url', 'seeded', 'unfinished'];
export const CODEX_WORKFLOW = 'codex-audit-report.yaml';
/** `codex-audit-report.yaml`'s `run-name`. */
export const CODEX_TITLE = 'codex second-opinion audit report';
export const CODEX_ARTIFACT = 'codex-recall';
/** Every field `codexRecord` in scripts/security-audit-public-body.mjs writes, and no other. */
export const CODEX_FIELDS = ['caught', 'claude_run_url', 'commit', 'either', 'model', 'run_url', 'seeded', 'unfinished'];
const DAY = 86_400_000;

const runUrl = (id) => `https://github.com/${REPO}/actions/runs/${id}`;
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;

/**
 * One run's `canary-recall.json`, checked field by field: exactly the fields
 * the scorer writes, integer counts, caught no more than seeded, no more
 * unfinished domains than a canary runs, and the link to this very run.
 * Throws on anything else; a record is never repaired or skipped.
 */
export function validateRecord(record, id) {
  const where = `run ${id}'s ${ARTIFACT}`;
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`${where} is not an object`);
  const keys = Object.keys(record).sort();
  if (keys.join() !== RECORD_FIELDS.join()) throw new Error(`${where} has fields ${keys.join(', ')}, not ${RECORD_FIELDS.join(', ')}`);
  for (const field of ['seeded', 'caught', 'unfinished']) {
    if (!isCount(record[field])) throw new Error(`${where}: ${field} is not a non-negative integer`);
  }
  if (record.caught > record.seeded) throw new Error(`${where}: caught ${record.caught} exceeds seeded ${record.seeded}`);
  if (record.unfinished > CANARY_DOMAINS.length) throw new Error(`${where}: ${record.unfinished} unfinished domains of ${CANARY_DOMAINS.length}`);
  if (record.run_url !== runUrl(id)) throw new Error(`${where} links ${JSON.stringify(record.run_url)}, not ${runUrl(id)}`);
  return { seeded: record.seeded, caught: record.caught, unfinished: record.unfinished };
}

/**
 * One second-opinion run's `codex-recall.json`, checked as `validateRecord`
 * checks a canary's: exactly the fields the builder writes, counts with
 * caught no more than seeded and either between them, and links to this very
 * run and to a run on this repository. A null `either` was not computed and
 * stays null, never zero. Returns the counts and the paired run's URL.
 */
export function validateCodexRecord(record, id) {
  const where = `run ${id}'s ${CODEX_ARTIFACT}`;
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`${where} is not an object`);
  const keys = Object.keys(record).sort();
  if (keys.join() !== CODEX_FIELDS.join()) throw new Error(`${where} has fields ${keys.join(', ')}, not ${CODEX_FIELDS.join(', ')}`);
  for (const field of ['seeded', 'caught', 'either', 'unfinished']) {
    if (!isCount(record[field]) && !(field === 'either' && record.either === null)) throw new Error(`${where}: ${field} is not a non-negative integer`);
  }
  if (record.caught > (record.either ?? record.seeded) || (record.either ?? record.caught) > record.seeded) {
    throw new Error(`${where}: caught ${record.caught}, either ${record.either ?? 'not computed'}, seeded ${record.seeded}`);
  }
  if (record.unfinished > CANARY_DOMAINS.length) throw new Error(`${where}: ${record.unfinished} unfinished domains of ${CANARY_DOMAINS.length}`);
  if (record.run_url !== runUrl(id)) throw new Error(`${where} links ${JSON.stringify(record.run_url)}, not ${runUrl(id)}`);
  const paired = /^https:\/\/github\.com\/diffplug\/dormouse\/actions\/runs\/([1-9]\d*)$/.exec(record.claude_run_url);
  if (!paired || record.claude_run_url !== runUrl(paired[1])) throw new Error(`${where} pairs with ${JSON.stringify(record.claude_run_url)}, not a run on ${REPO}`);
  return { url: record.run_url, claudeUrl: record.claude_run_url, seeded: record.seeded, caught: record.caught, either: record.either, unfinished: record.unfinished };
}

/**
 * Each recorded canary run's second-opinion counts, by the canary run's URL:
 * the newest second-opinion run paired with it. Throws on a pairing that
 * cannot follow from the canary's own record — other seeds, or a computed
 * `either` below Claude's count or above the two engines' sum.
 */
function pairCodex(recorded, codex) {
  const byUrl = new Map();
  for (const c of [...codex].sort((a, b) => a.id - b.id)) {
    const counts = validateCodexRecord(c.record, c.id);
    const claude = recorded.find((r) => r.url === counts.claudeUrl);
    if (!claude) continue;
    if (counts.seeded !== claude.seeded
      || (counts.either !== null && (counts.either < claude.caught || counts.either > claude.caught + counts.caught))) {
      throw new Error(`run ${c.id}'s ${CODEX_ARTIFACT} cannot pair with ${claude.url}: seeded ${counts.seeded} of ${claude.seeded}, either ${counts.either ?? 'not computed'} beside Claude's ${claude.caught}`);
    }
    const { claudeUrl: _claudeUrl, seeded: _seeded, ...kept } = counts;
    byUrl.set(claude.url, kept);
  }
  return byUrl;
}

/**
 * The snapshot, from every canary run listed: `{ id, createdAt, record }`,
 * `record` null for a run that left no `canary-recall` artifact; and every
 * second-opinion run listed, `{ id, record }`, each record a `codex-recall`.
 *
 * Every run in the window counts as its record has it. A domain that left no
 * finished report caught only what its partial report cites, so the seeds
 * dealt to it stay in `seeded` and lower the figure; the run is never dropped,
 * and its `unfinished` count is carried so the page can say so. A run with no
 * record at all — its seeding failed, so nothing was scored — has no counts to
 * add and is listed under `unrecorded`.
 */
export function summarize(runs, { now, windowDays = WINDOW_DAYS, codex = [] }) {
  const since = now.getTime() - windowDays * DAY;
  const inWindow = runs
    .filter((r) => Date.parse(r.createdAt) >= since && Date.parse(r.createdAt) <= now.getTime())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
  const recorded = inWindow.filter((r) => r.record !== null)
    .map((r) => ({ at: r.createdAt, url: runUrl(r.id), ...validateRecord(r.record, r.id) }));
  const paired = pairCodex(recorded, codex);
  for (const run of recorded) if (paired.has(run.url)) run.codex = paired.get(run.url);
  return {
    asOf: now.toISOString().slice(0, 10),
    windowDays,
    runsUrl: `https://github.com/${REPO}/actions/workflows/${WORKFLOW}?query=branch%3Amain`,
    seeded: recorded.reduce((n, r) => n + r.seeded, 0),
    caught: recorded.reduce((n, r) => n + r.caught, 0),
    runs: recorded,
    unrecorded: inWindow.filter((r) => r.record === null).map((r) => ({ at: r.createdAt, url: runUrl(r.id) })),
  };
}

// --- `gh` ---------------------------------------------------------------------

function gh(args) {
  const run = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`gh ${args.join(' ')} failed: ${run.stderr.trim()}`);
  return run.stdout;
}

/** The completed canary runs on `main` created since `since`, from every page. */
function listCanaryRuns(since) {
  const query = `repos/${REPO}/actions/workflows/${WORKFLOW}/runs?branch=main&status=completed&created=%3E%3D${since}&per_page=100`;
  const pages = gh(['api', '--paginate', '--jq', '.workflow_runs[]', query]).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return pages.filter((r) => r.display_title === CANARY_TITLE && r.head_branch === 'main'
    && r.head_repository?.full_name === REPO && ['schedule', 'workflow_dispatch'].includes(r.event));
}

/**
 * The successful second-opinion runs on `main` created since `since`.
 * Success alone is an admin's dispatch: `codex-audit-report.yaml` fails any
 * other.
 */
function listCodexRuns(since) {
  const query = `repos/${REPO}/actions/workflows/${CODEX_WORKFLOW}/runs?branch=main&status=success&created=%3E%3D${since}&per_page=100`;
  return gh(['api', '--paginate', '--jq', '.workflow_runs[]', query]).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.display_title === CODEX_TITLE && r.head_branch === 'main' && r.head_repository?.full_name === REPO && r.event === 'workflow_dispatch');
}

/** The run's one-file artifact `name`, parsed, or null when the run has no unexpired one. */
function readRecord(id, name = ARTIFACT) {
  const artifacts = JSON.parse(gh(['api', `repos/${REPO}/actions/runs/${id}/artifacts?per_page=100`])).artifacts ?? [];
  if (!artifacts.some((a) => a.name === name && !a.expired)) return null;
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  try {
    gh(['run', 'download', String(id), '-R', REPO, '-n', name, '-D', dir]);
    const files = readdirSync(dir);
    if (files.join() !== `${name}.json`) throw new Error(`run ${id}'s ${name} holds ${files.join(', ')}`);
    return JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY).toISOString().slice(0, 10);
  const runs = listCanaryRuns(since).map((r) => ({ id: r.id, createdAt: r.created_at, record: readRecord(r.id) }));
  const codex = listCodexRuns(since).map((r) => ({ id: r.id, record: readRecord(r.id, CODEX_ARTIFACT) })).filter((r) => r.record !== null);
  const snapshot = summarize(runs, { now, codex });
  const out = resolve(dirname(fileURLToPath(import.meta.url)), '../src/data/canary-recall.json');
  writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`canary recall: ${snapshot.caught}/${snapshot.seeded} over ${snapshot.runs.length} run(s) since ${since}` +
    `${snapshot.unrecorded.length ? `; ${snapshot.unrecorded.length} run(s) left no record` : ''}` +
    `; ${snapshot.runs.filter((r) => r.codex).length} paired with the second-opinion audit -> ${out}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
