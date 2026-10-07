#!/usr/bin/env node
/**
 * Decides whether a security-audit run needs its four model-run domains, and
 * records what this run audited for the next one to compare against. See
 * docs/specs/security-audit.md -> "Skipping an unchanged audit".
 *
 * A scheduled run skips the domains only when the last completed run on `main`
 * succeeded, audited this same commit, observed this same GitHub-state hash,
 * and descends from a full run under `MAX_SKIP_DAYS` old. Everything else —
 * every `workflow_dispatch`, the release gate's included — audits in full. A
 * skipped run still runs the deterministic checks: `scripts/github-state-check.mjs`
 * judges live state every night, so a skip can never pass over a drifted
 * setting, only over a repeat of a model pass on unchanged inputs.
 *
 * Reads `GITHUB_EVENT_NAME`, `GITHUB_SHA`, `GITHUB_RUN_ID`,
 * `GITHUB_REPOSITORY`, `RUNNER_TEMP`, and `STATE_HASH` (the check's output);
 * `gh` runs on the workflow token. Writes `skip=`, `reason=` to
 * `GITHUB_OUTPUT` (and `fragments=`, the one fragment a skipped run reports), `$RUNNER_TEMP/audit-state/audit-state.json` for the
 * `audit-state` artifact, and — when skipping — the `audit-report.md` and
 * `audit-status.txt` the orchestrator would otherwise write. The reporting
 * step still holds that status to the GitHub-state fragment's own verdict.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAGMENT } from './github-state-check.mjs';

export const MAX_SKIP_DAYS = 7;
export const ARTIFACT = 'audit-state';
const DAY = 86_400_000;

/**
 * The decision, from what the previous run left. `previous` is
 * `{ id, conclusion, state }` for the last completed run on `main`, its
 * `state` the recorded `audit-state.json` or null; absent when there is none.
 */
export function decide({ event, sha, hash, previous, now = new Date() }) {
  const full = (reason) => ({ skip: false, reason, fullRunAt: now.toISOString() });
  if (event !== 'schedule') return full(`a \`${event}\` run always audits in full`);
  if (!/^[0-9a-f]{64}$/.test(hash ?? '')) return full('the GitHub-state check produced no hash');
  if (!previous) return full('no earlier completed run on `main`');
  if (previous.conclusion !== 'success') return full(`run ${previous.id} concluded \`${previous.conclusion}\``);
  const state = previous.state;
  if (!state) return full(`run ${previous.id} left no \`${ARTIFACT}\` artifact`);
  if (state.commit !== sha) return full(`the commit changed since run ${previous.id}`);
  if (state.state_hash !== hash) return full(`the GitHub-state hash changed since run ${previous.id}`);
  const since = Date.parse(state.full_run_at);
  if (!(now.getTime() - since < MAX_SKIP_DAYS * DAY)) return full(`the last full audit is ${MAX_SKIP_DAYS} or more days old`);
  return { skip: true, reason: `commit and GitHub-state hash unchanged since run ${previous.id}, which passed; last full audit ${state.full_run_at}`, fullRunAt: state.full_run_at };
}

function gh(args) {
  const run = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return run.status === 0 ? run.stdout : null;
}

/** The last completed run on `main` other than this one, with its recorded state. */
function previousRun({ repo, runId }) {
  const listed = gh(['api', `repos/${repo}/actions/workflows/security-audit.yaml/runs?branch=main&status=completed&per_page=20`]);
  if (listed === null) return undefined;
  const run = (JSON.parse(listed).workflow_runs ?? [])
    .filter((r) => String(r.id) !== String(runId) && r.head_branch === 'main')
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!run) return undefined;
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? '/tmp', 'previous-audit-state-'));
  gh(['run', 'download', String(run.id), '-R', repo, '-n', ARTIFACT, '-D', dir]);
  let state = null;
  try { state = JSON.parse(readFileSync(join(dir, 'audit-state.json'), 'utf8')); } catch { /* no artifact: audit in full */ }
  return { id: run.id, conclusion: run.conclusion, state };
}

function main() {
  const env = process.env;
  const now = new Date();
  const event = env.GITHUB_EVENT_NAME;
  const previous = event === 'schedule' ? previousRun({ repo: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID }) : undefined;
  const decision = decide({ event, sha: env.GITHUB_SHA, hash: env.STATE_HASH, previous, now });

  const stateDir = join(env.RUNNER_TEMP, ARTIFACT);
  mkdirSync(stateDir, { recursive: true });
  // `mode` and `run_id` are for a reader of the artifact; `decide` reads the rest.
  writeFileSync(join(stateDir, 'audit-state.json'), `${JSON.stringify({
    commit: env.GITHUB_SHA, state_hash: env.STATE_HASH ?? '', full_run_at: decision.fullRunAt,
    mode: decision.skip ? 'skipped' : 'full', run_id: env.GITHUB_RUN_ID,
  }, null, 2)}\n`);

  if (decision.skip) {
    writeFileSync('audit-report.md', `# Security audit\n\nThe four domains were skipped: ${decision.reason}. Only the deterministic checks ran; their fragment follows in the reporting step.\n`);
    writeFileSync('audit-status.txt', 'PASS\n');
  }
  // A skipped run's reporting steps read only the deterministic fragment.
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `skip=${decision.skip}\nreason=${decision.reason.replace(/\n/g, ' ')}\n${decision.skip ? `fragments=${FRAGMENT}\n` : ''}`);
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `**Domains ${decision.skip ? 'skipped' : 'run in full'}:** ${decision.reason}.\n`);
  console.log(`${decision.skip ? 'Skipping' : 'Running'} the domains: ${decision.reason}.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
