#!/usr/bin/env node
/**
 * The release-time red-team note (docs/specs/security-audit.md -> "Red team"):
 * finds the most recently completed `red-team` issue and lists the commits on
 * the release's first-parent history since it closed that touch remote control
 * or Hosted. It writes the job summary and a `::warning::` annotation, and
 * always exits 0: the note informs a release, it never gates one.
 *
 * Run by the `red-team-note` job in `.github/workflows/release.yml`, from a
 * full-history checkout, with `GH_TOKEN` able to read issues.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * What the `remote` and `hosted` audit domains own (`.github/audit/remote.md`
 * and `.github/audit/hosted.md`, "You own"): the surfaces an attacker reaches
 * without local access.
 */
export const SURFACES = [
  'remote-lib-common/',
  'relay/',
  'hosted/',
  'deploy/local/',
  'SELF_HOST.md',
  'lib/src/remote/',
  'lib/src/host/remote/',
  'lib/src/host/relay-origin.ts',
  'lib/pocket/',
  'lib/one-time/',
  'vscode-ext/src/burrow*.ts',
];

/**
 * The red-team issue closed as completed most recently, or `null`. An issue
 * closed as not planned recorded no pass.
 * @param {{ number: number, closedAt: string | null, stateReason?: string }[]} issues
 */
export function lastPass(issues) {
  const passes = issues.filter((i) => i.closedAt && (i.stateReason ?? 'COMPLETED').toUpperCase() === 'COMPLETED');
  passes.sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));
  return passes[0] ? { number: passes[0].number, closedAt: passes[0].closedAt } : null;
}

/**
 * First-parent commits of `head` committed after `since` whose diff against
 * their first parent touches `paths`, newest first. First-parent, so a merged
 * branch counts once, dated when it landed rather than when it was written.
 * @returns {{ sha: string, subject: string }[]}
 */
export function changedSince({ since, head = 'HEAD', paths = SURFACES, cwd }) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const shas = git('rev-list', '--first-parent', `--since=${since}`, head).split('\n').filter(Boolean);
  const out = [];
  for (const sha of shas) {
    const [subject, parents = ''] = git('show', '-s', '--format=%s%n%P', sha).trim().split('\n');
    const parent = parents.split(' ')[0];
    const diffArgs = parent ? ['diff', '--name-only', parent, sha] : ['show', '--format=', '--name-only', sha];
    if (git(...diffArgs, '--', ...paths).trim()) out.push({ sha, subject });
  }
  return out;
}

/**
 * The summary Markdown, and the warning annotation when there is one.
 * @param {{ pass: { number: number, closedAt: string } | null, commits?: { sha: string, subject: string }[] }} result
 */
export function report({ pass, commits = [] }) {
  if (!pass) {
    const text = 'No closed `red-team` issue yet, so there is no red-team pass to compare this release against.';
    return { summary: `### Red team\n\n${text}\n`, warning: text };
  }
  const date = pass.closedAt.slice(0, 10);
  if (!commits.length) {
    return { summary: `### Red team\n\nRemote control and Hosted are unchanged since the last red-team pass, #${pass.number} closed ${date}.\n`, warning: null };
  }
  const warning = `Remote control or Hosted changed since the last red-team pass, #${pass.number} closed ${date}: ${commits.length} commit${commits.length === 1 ? '' : 's'}.`;
  const list = commits.map((c) => `- ${c.sha.slice(0, 9)} ${c.subject}`).join('\n');
  return { summary: `### Red team\n\n**${warning}**\n\n${list}\n`, warning };
}

function main() {
  let result;
  try {
    const repo = process.env.GITHUB_REPOSITORY;
    const issues = JSON.parse(execFileSync('gh', ['issue', 'list', ...(repo ? ['-R', repo] : []), '--label', 'red-team', '--state', 'closed', '--limit', '100', '--json', 'number,closedAt,stateReason'], { encoding: 'utf8' }));
    const pass = lastPass(issues);
    result = report({ pass, commits: pass ? changedSince({ since: pass.closedAt }) : [] });
  } catch (error) {
    const text = `Could not check for remote control or Hosted changes since the last red-team pass: ${error.message.split('\n')[0]}`;
    result = { summary: `### Red team\n\n${text}\n`, warning: text };
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.summary);
  console.log(result.summary);
  if (result.warning) console.log(`::warning::${result.warning}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
