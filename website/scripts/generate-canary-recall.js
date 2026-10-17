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
 * website/src/data/canary-recall.json. Run by hand with the dependency
 * snapshots (docs/specs/deploy.md -> "Release checklist"), because
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
/** The `canary-recall` artifact's retention: older runs have no record left to read. */
export const WINDOW_DAYS = 90;
/** Every field `publicRecord` in scripts/security-audit-canary.mjs writes, and no other. */
export const RECORD_FIELDS = ['caught', 'run_url', 'seeded', 'unfinished'];
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
 * The snapshot, from every canary run listed: `{ id, createdAt, record }`,
 * `record` null for a run that left no `canary-recall` artifact.
 *
 * Every run in the window counts as its record has it. A domain that left no
 * finished report caught only what its partial report cites, so the seeds
 * dealt to it stay in `seeded` and lower the figure; the run is never dropped,
 * and its `unfinished` count is carried so the page can say so. A run with no
 * record at all — its seeding failed, so nothing was scored — has no counts to
 * add and is listed under `unrecorded`.
 */
export function summarize(runs, { now, windowDays = WINDOW_DAYS }) {
  const since = now.getTime() - windowDays * DAY;
  const inWindow = runs
    .filter((r) => Date.parse(r.createdAt) >= since && Date.parse(r.createdAt) <= now.getTime())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id);
  const recorded = inWindow.filter((r) => r.record !== null)
    .map((r) => ({ at: r.createdAt, url: runUrl(r.id), ...validateRecord(r.record, r.id) }));
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

/** The run's `canary-recall.json`, or null when the run has no unexpired one. */
function readRecord(id) {
  const artifacts = JSON.parse(gh(['api', `repos/${REPO}/actions/runs/${id}/artifacts?per_page=100`])).artifacts ?? [];
  if (!artifacts.some((a) => a.name === ARTIFACT && !a.expired)) return null;
  const dir = mkdtempSync(join(tmpdir(), 'canary-recall-'));
  try {
    gh(['run', 'download', String(id), '-R', REPO, '-n', ARTIFACT, '-D', dir]);
    const files = readdirSync(dir);
    if (files.join() !== 'canary-recall.json') throw new Error(`run ${id}'s ${ARTIFACT} holds ${files.join(', ')}`);
    return JSON.parse(readFileSync(join(dir, 'canary-recall.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY).toISOString().slice(0, 10);
  const runs = listCanaryRuns(since).map((r) => ({ id: r.id, createdAt: r.created_at, record: readRecord(r.id) }));
  const snapshot = summarize(runs, { now });
  const out = resolve(dirname(fileURLToPath(import.meta.url)), '../src/data/canary-recall.json');
  writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`canary recall: ${snapshot.caught}/${snapshot.seeded} over ${snapshot.runs.length} run(s) since ${since}` +
    `${snapshot.unrecorded.length ? `; ${snapshot.unrecorded.length} run(s) left no record` : ''} -> ${out}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
