#!/usr/bin/env node
/**
 * Build the body of the public `security-audit-failure` issue: verdicts,
 * counts, and the names of failed spec sections — never a finding's text. The
 * detail goes to the private tracker; see docs/specs/security-audit.md ->
 * "Embargo".
 *
 * Every string this emits is fixed template text, a number, a validated
 * GitHub-supplied value, a fragment name from `AUDIT_FRAGMENTS`, or a spec
 * heading verified to exist in the checked-out `docs/specs/`. Nothing a domain
 * wrote reaches the output as text, so an agent cannot publish detail by
 * phrasing it as a heading or a verdict.
 *
 * Usage: node scripts/security-audit-public-body.mjs --status FAIL|MISSING
 *   --file-status PASS|FAIL|MISSING --date <YYYY-MM-DDTHH:MMZ> --run-url <url>
 *   --commit <sha> [--dissenting <list>] [--missing <list>] [--unreadable <list>]
 *   [--inconclusive <list>] [--unfinished <list>]
 * Each <list> is the reporting step's `a.md, b.md`. Fragments named by
 * $AUDIT_FRAGMENTS are read from the working directory; the body goes to stdout.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A check line a domain recorded as failed: `- FAIL: …`, after an optional heading or bullet marker. */
const FAIL_LINE = /^\s*(?:#+\s*)?(?:[-*]\s*)?(?:\*\*)?FAIL(?:\*\*)?:/;
/** A qualitative finding by severity: `- BLOCKER: …`, `- **WARNING** …`. */
const SEVERITY_LINE = /^\s*(?:#+\s*)?(?:[-*]\s*)?(?:\*\*|\[)?(BLOCKER|WARNING)\b/;
/** The section a check line names, per `.github/audit/_preamble.md`: `docs/specs/<spec>.md` -> "<heading>". */
const SECTION_REF = /`(docs\/specs\/security[a-z-]*\.md)`\s*(?:->|→)\s*"([^"\n]+)"/;

const headingCache = new Map();
/** Every `##`–`######` heading of a security spec, or none when the file does not exist. */
function specHeadings(root, spec) {
  if (!headingCache.has(spec)) {
    const path = join(root, spec);
    const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
    headingCache.set(spec, new Set(text.split('\n')
      .map((line) => line.match(/^#{2,6}\s+(.+?)\s*$/)?.[1])
      .filter(Boolean)));
  }
  return headingCache.get(spec);
}

/** Counts and verified section names from one fragment's text. */
export function tallyFragment(text, root = '.') {
  const tally = { failed: 0, blocker: 0, warning: 0, sections: [], unnamed: 0 };
  for (const line of text.split('\n')) {
    const severity = line.match(SEVERITY_LINE)?.[1];
    if (severity === 'BLOCKER') tally.blocker++;
    if (severity === 'WARNING') tally.warning++;
    if (!FAIL_LINE.test(line)) continue;
    tally.failed++;
    const [, spec, heading] = line.match(SECTION_REF) ?? [];
    if (spec && !spec.endsWith('.rationale.md') && specHeadings(root, spec).has(heading)) {
      tally.sections.push(`\`${spec}\` -> "${heading}"`);
    } else {
      tally.unnamed++;
    }
  }
  return tally;
}

const listOf = (value) => new Set((value ?? '').split(',').map((s) => s.trim()).filter(Boolean));

function valid(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`invalid ${name}: ${JSON.stringify(value)}`);
  return value;
}

/**
 * The public body. `fragments` maps each `AUDIT_FRAGMENTS` name to its text,
 * or null when it is absent or empty; the condition lists are the reporting
 * step's own.
 */
export function publicBody({ status, fileStatus, date, runUrl, commit, repo, fragments,
  dissenting, missing, unreadable, inconclusive, unfinished, root = '.' }) {
  valid(status, /^(FAIL|MISSING)$/, 'status');
  valid(fileStatus, /^(PASS|FAIL|MISSING)$/, 'file status');
  valid(date, /^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/, 'date');
  valid(repo, /^[\w.-]+\/[\w.-]+$/, 'repository');
  valid(runUrl, new RegExp(`^https://github\\.com/${repo.replace(/[.]/g, '\\.')}/actions/runs/\\d+$`), 'run URL');
  valid(commit, /^[0-9a-f]{40}$/, 'commit');
  const sets = { dissenting: listOf(dissenting), missing: listOf(missing), unreadable: listOf(unreadable),
    inconclusive: listOf(inconclusive), unfinished: listOf(unfinished) };

  const lines = [];
  lines.push(status === 'FAIL'
    ? `Audit failed at ${date}.`
    : `Audit reached no usable verdict at ${date}. This is not a security finding: the run ended without deciding.`);
  lines.push(`[Run](${runUrl}) · audited commit [\`${commit.slice(0, 7)}\`](https://github.com/${repo}/commit/${commit})`);
  lines.push('', '| Domain | Verdict | Failed checks | BLOCKER | WARNING |', '| --- | --- | --- | --- | --- |');
  const sections = new Map();
  let unnamed = 0;
  for (const [name, text] of Object.entries(fragments)) {
    valid(name, /^[\w.-]+\.md$/, 'fragment name');
    let verdict = 'PASS';
    if (sets.missing.has(name) || text === null) verdict = 'no report';
    else if (sets.dissenting.has(name)) verdict = 'FAIL';
    else if (sets.unreadable.has(name)) verdict = 'unreadable';
    else if (sets.inconclusive.has(name)) verdict = 'INCONCLUSIVE';
    if (sets.unfinished.has(name) && text !== null) verdict += ', cut off';
    if (text === null) {
      lines.push(`| \`${name}\` | ${verdict} | – | – | – |`);
      continue;
    }
    const tally = tallyFragment(text, root);
    lines.push(`| \`${name}\` | ${verdict} | ${tally.failed} | ${tally.blocker} | ${tally.warning} |`);
    for (const section of tally.sections) sections.set(section, (sections.get(section) ?? 0) + 1);
    unnamed += tally.unnamed;
  }
  if (sections.size > 0 || unnamed > 0) {
    lines.push('', '**Failed `FAIL IF` sections:**', '');
    for (const [section, n] of sections) lines.push(`- ${section}${n > 1 ? ` (${n} checks)` : ''}`);
    if (unnamed > 0) lines.push(`- ${unnamed} failed check${unnamed > 1 ? 's' : ''} named no section heading of a security spec.`);
  }
  if (fileStatus === 'MISSING') lines.push('', 'The orchestrator wrote no verdict.');
  lines.push('', 'Finding details — evidence, reproduction, and the qualitative findings — are triaged privately until fixed, so this issue carries verdicts and counts only. To report a vulnerability, use the [private advisory form](https://github.com/' + repo + '/security/advisories/new), never an issue.');
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument: ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1] ?? '';
  }
  const fragments = {};
  for (const name of (process.env.AUDIT_FRAGMENTS ?? '').split(/\s+/).filter(Boolean)) {
    const text = existsSync(name) ? readFileSync(name, 'utf8') : '';
    fragments[name] = text === '' ? null : text;
  }
  if (Object.keys(fragments).length === 0) throw new Error('AUDIT_FRAGMENTS names no fragment');
  process.stdout.write(publicBody({
    status: args.status, fileStatus: args['file-status'], date: args.date, runUrl: args['run-url'],
    commit: args.commit, repo: process.env.GITHUB_REPOSITORY, fragments,
    dissenting: args.dissenting, missing: args.missing, unreadable: args.unreadable,
    inconclusive: args.inconclusive, unfinished: args.unfinished,
  }));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
