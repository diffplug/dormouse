#!/usr/bin/env node
/**
 * Build the body of the public `security-audit-failure` issue: verdicts,
 * counts, and the names of failed spec sections — never a finding's text. The
 * detail goes to the private tracker; see docs/specs/security-audit.md ->
 * "Embargo".
 *
 * Every string this emits is fixed template text, a number, a validated
 * GitHub-supplied value, a fragment name from `AUDIT_FRAGMENTS`, or a spec
 * heading the checked-out specs owe that domain a rule under. Nothing a domain
 * wrote reaches the output as text, so an agent cannot publish detail by
 * phrasing it as a heading or a verdict. The verdicts are the ones
 * `scripts/security-audit-report.mjs` computes, never a domain's own line.
 *
 * Usage: node scripts/security-audit-public-body.mjs --status FAIL|MISSING
 *   --date <YYYY-MM-DDTHH:MMZ> --run-url <url> --commit <sha> [--open-findings <n>]
 * Fragments named by $AUDIT_FRAGMENTS and `audit-status.txt` are read from the
 * working directory; the body goes to stdout.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dedupFindings, domainVerdict, fragmentManifest, readFileStatus, readFragments } from './security-audit-report.mjs';

function valid(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`invalid ${name}: ${JSON.stringify(value)}`);
  return value;
}

/**
 * The public body. `fragments` maps each `AUDIT_FRAGMENTS` name to its text,
 * or null when it is absent or empty.
 */
export function publicBody({ status, fileStatus, date, runUrl, commit, repo, fragments, openFindings = '', root = '.' }) {
  valid(status, /^(FAIL|MISSING)$/, 'status');
  valid(fileStatus, /^(PASS|FAIL|MISSING)$/, 'file status');
  valid(date, /^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/, 'date');
  valid(repo, /^[\w.-]+\/[\w.-]+$/, 'repository');
  valid(runUrl, new RegExp(`^https://github\\.com/${repo.replace(/[.]/g, '\\.')}/actions/runs/\\d+$`), 'run URL');
  valid(commit, /^[0-9a-f]{40}$/, 'commit');
  valid(openFindings, /^(\d+)?$/, 'open findings');

  const lines = [];
  lines.push(status === 'FAIL'
    ? `Audit failed at ${date}.`
    : `Audit reached no usable verdict at ${date}.`);
  lines.push(`[Run](${runUrl}) · audited commit [\`${commit.slice(0, 7)}\`](https://github.com/${repo}/commit/${commit})`);
  lines.push('', '| Domain | Verdict | Failed checks | Rules with no result | Malformed lines | BLOCKER | WARNING |', '| --- | --- | --- | --- | --- | --- | --- |');
  const sections = new Map();
  let unnamed = 0;
  let disagreements = 0;
  for (const [name, text] of Object.entries(fragments)) {
    valid(name, /^[\w.-]+\.md$/, 'fragment name');
    if (text === null) {
      lines.push(`| \`${name}\` | no report | – | – | – | – | – |`);
      continue;
    }
    const d = domainVerdict(text, fragmentManifest(root, name));
    const failed = d.results.filter((r) => r.status === 'FAIL');
    const merged = dedupFindings(d.findings.map((finding) => ({ fragment: name, finding })));
    const count = (severity) => merged.filter((m) => m.severity === severity).length;
    if (d.anomalies.length) disagreements++;
    lines.push(`| \`${name}\` | ${d.verdict}${d.finished ? '' : ', cut off'} | ${failed.length} | ${d.missing.length} | ${d.malformed.length + d.stray.length} | ${count('BLOCKER')} | ${count('WARNING')} |`);
    // Only a heading the manifest owes is named; `domainVerdict` sorted every
    // other one into `stray`, and those are counted, never quoted.
    for (const r of failed) {
      if (d.stray.includes(r)) { unnamed++; continue; }
      const section = `\`${r.spec}\` -> "${r.heading}"`;
      sections.set(section, (sections.get(section) ?? 0) + 1);
    }
  }
  if (sections.size > 0 || unnamed > 0) {
    lines.push('', '**Failed `FAIL IF` sections:**', '');
    for (const [section, n] of sections) lines.push(`- ${section}${n > 1 ? ` (${n} checks)` : ''}`);
    if (unnamed > 0) lines.push(`- ${unnamed} failed check${unnamed > 1 ? 's' : ''} named no section heading of a security spec.`);
  }
  if (disagreements > 0) lines.push('', `${disagreements} domain${disagreements > 1 ? 's\'' : '\'s'} own verdict line disagreed with the verdict its lines compute; the computed one is reported.`);
  if (fileStatus === 'MISSING') lines.push('', 'The orchestrator wrote no verdict.');
  if (openFindings !== '') lines.push('', `${openFindings} finding${openFindings === '1' ? '' : 's'} from earlier runs ${openFindings === '1' ? 'is' : 'are'} still open in the private ledger.`);
  lines.push('', 'Finding details — evidence, reproduction, and the qualitative findings — are triaged privately until fixed, so this issue carries verdicts and counts only. To report a vulnerability, use the [private advisory form](https://github.com/' + repo + '/security/advisories/new), never an issue.');
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument: ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1] ?? '';
  }
  process.stdout.write(publicBody({
    status: args.status, fileStatus: readFileStatus(), date: args.date, runUrl: args['run-url'],
    commit: args.commit, repo: process.env.GITHUB_REPOSITORY, fragments: readFragments(),
    openFindings: args['open-findings'] ?? '',
  }));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
