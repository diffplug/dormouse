#!/usr/bin/env node
/**
 * Everything the security audit publishes in this public repository: the body
 * of the pinned status issue, rewritten by every run, and one disclosure issue
 * per ledger finding once it is fixed, dismissed, or past its deadline. See
 * docs/specs/security-audit.md -> "Embargo" and "Disclosure".
 *
 * Every string this emits is fixed template text, a number, a date, a
 * validated GitHub-supplied value, a fragment name from `AUDIT_FRAGMENTS`, a
 * spec and heading the checked-out specs carry, a file the checked-out tree holds,
 * or a maintainer's `## Public summary` comment. Nothing a domain wrote, and no
 * ledger title or body, reaches the output as text, so an agent cannot publish
 * detail by phrasing it as a heading, a verdict, or a path. The verdicts are
 * the ones `scripts/security-audit-report.mjs` computes, never a domain's own
 * line.
 *
 * Usage: node scripts/security-audit-public-body.mjs --status PASS|FAIL|MISSING
 *   --date <YYYY-MM-DDTHH:MMZ> --run-url <url> --commit <sha>
 *   [--embargo-result <result>] [--skipped true|false] [--full-run-at <iso>]
 *   [--ledger <snapshot.jsonl>] --outputs <file>
 * Fragments named by $AUDIT_FRAGMENTS and `audit-status.txt` are read from the
 * working directory; `gh` runs on the workflow token against
 * $GITHUB_REPOSITORY. Once everything is published it writes `passed=true` to
 * <file> only when the run passed, its findings were filed, and the ledger was
 * read; `passed=false` otherwise.
 *
 * Usage: node scripts/security-audit-public-body.mjs --engine codex
 *   --date <YYYY-MM-DDTHH:MMZ> --run-url <url> --commit <sha> --model <name>
 *   --verdicts <domain=VERDICT …> --canary-run <id> --canary-seeded <n>
 *   --canary-caught <n> [--canary-either <n>] --canary-unfinished <n>
 *   --record <file>
 * The second-opinion audit's report (docs/specs/security-audit.md -> "Second-opinion
 * audit"), from
 * `.github/workflows/codex-audit-report.yaml`'s inputs: one comment on the
 * status issue, and, for a canary, its recall record written to <file>. Every
 * input is checked against its pattern, the counts against the CI canary run
 * they share seeds with, and nothing else is published.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clampIssueBody } from './clamp-issue-body.mjs';
import { dedupFindings, domains, judgeFragment, readFileStatus, readFragments, ruleIndex } from './security-audit-report.mjs';

/** The label that finds the one status issue, and the one every disclosure carries. */
export const STATUS_LABEL = 'security-audit-status';
export const DISCLOSURE_LABEL = 'security-audit-finding';
/** A ledger finding is published at the latest this long after its ledger issue was opened. */
export const DISCLOSURE_DAYS = 7;
const DAY = 86_400_000;
/** How many issues one `gh issue list` reads; a list that fills it may be short. */
const LIST_LIMIT = 1000;
/** How many disclosures the status issue lists; the label search lists them all. */
const RECENT_DISCLOSURES = 10;

const STATUS_MARKER = /^<!-- security-audit-status outcome=(PASS|FAIL|INCONCLUSIVE) -->/;
/** `[audit-disclosure <key>/<ledger number>] …`: one per ledger issue, since a finding that recurs after its fix is filed again under its key. */
const DISCLOSURE_TITLE = /^\[audit-disclosure ([A-Za-z0-9._-]+)\/([1-9]\d*)\] (FAIL|BLOCKER|WARNING) (failed check|finding)$/;
const MINTED_KEY = /^[0-9a-f]{12}$/;
const KEY = /^(?:[0-9a-f]{12}|manual-[a-z0-9][a-z0-9-]{0,59})$/;
const SEVERITY = /^(FAIL|BLOCKER|WARNING)$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z$/;
const SPEC = /^docs\/specs\/security[a-z-]*\.md$/;
/** A repo-relative path with no `..` segment, in characters a path in this tree uses. */
const PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[\w@+.-]+(?:\/[\w@+.-]+)*$/;

function valid(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`invalid ${name}: ${JSON.stringify(value)}`);
  return value;
}

const day = (iso) => iso.slice(0, 10);
const outcomeOf = (status) => (status === 'MISSING' ? 'INCONCLUSIVE' : status);
const kindOf = (severity) => (severity === 'FAIL' ? 'failed check' : 'finding');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const disclosureDue = (createdAt) => new Date(Date.parse(createdAt) + DISCLOSURE_DAYS * DAY);

// --- The ledger snapshot -----------------------------------------------------

/**
 * `Read the findings ledger`'s snapshot: one JSON object per line, as its
 * filter shapes it. Returns the ledger entries, every field checked for shape;
 * a title the filter could not read leaves `key` and `severity` null, so the
 * issue still counts as open but is never disclosed.
 */
export function parseLedger(text) {
  return text.split('\n').filter((l) => l.trim() !== '').map((line) => {
    const raw = JSON.parse(line);
    const number = raw.number;
    if (!Number.isInteger(number) || number < 1) throw new Error(`ledger entry with no number: ${line.slice(0, 80)}`);
    const state = valid(raw.state, /^(OPEN|CLOSED)$/, `state of ledger #${number}`);
    const createdAt = valid(raw.createdAt, ISO, `createdAt of ledger #${number}`);
    const key = typeof raw.title?.key === 'string' && KEY.test(raw.title.key) ? raw.title.key : null;
    const severity = key && typeof raw.title?.severity === 'string' && SEVERITY.test(raw.title.severity) ? raw.title.severity : null;
    const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : null;
    const fixed = (Array.isArray(raw.fixed) ? raw.fixed : [])
      .filter((f) => f && typeof f.pr === 'string' && /^[1-9]\d{0,6}$/.test(f.pr))
      .map((f) => ({ repo: typeof f.repo === 'string' ? f.repo : null, pr: Number(f.pr) }));
    return {
      number, state, createdAt, key, severity, meta, fixed,
      stateReason: typeof raw.stateReason === 'string' ? raw.stateReason : '',
      closedAt: typeof raw.closedAt === 'string' && ISO.test(raw.closedAt) ? raw.closedAt : null,
      summary: typeof raw.summary === 'string' && raw.summary.trim() !== '' ? raw.summary.trim() : null,
    };
  });
}

/** A ledger issue's identity in the archive: its key and its number in the private tracker. */
export const archiveId = (key, ledgerNumber) => `${key}/${ledgerNumber}`;

/** Each disclosure issue a run filed, by the ledger issue its fixed-form title names; the lowest number wins. */
export function parseArchive(issues) {
  const byLedger = new Map();
  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    const m = typeof issue.title === 'string' ? issue.title.match(DISCLOSURE_TITLE) : null;
    if (!m || byLedger.has(archiveId(m[1], m[2])) || !Number.isInteger(issue.number)) continue;
    byLedger.set(archiveId(m[1], m[2]), { number: issue.number, key: m[1], severity: m[3], state: issue.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
      createdAt: typeof issue.createdAt === 'string' && ISO.test(issue.createdAt) ? issue.createdAt : null });
  }
  return byLedger;
}

// --- Validating what a disclosure names --------------------------------------

/** Every heading of a spec in the checked-out tree. */
function specHeadings(root, spec) {
  const path = join(root, spec);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').map((l) => l.match(/^#{1,6}\s+(.+?)\s*$/)?.[1]).filter(Boolean);
}

/**
 * Where a finding lives, as a disclosure may name it: a failed check's spec
 * and heading, where the checked-out specs carry its rule ID now or else as
 * filed when the checked-out spec has that heading, or a finding's file, found
 * in the checked-out tree. Anything the metadata says that the tree does not
 * confirm is withheld.
 */
export function disclosedLocation(entry, root = '.') {
  const meta = entry.meta;
  if (!meta) return { text: 'not recorded: the ledger issue predates disclosure metadata' };
  if (entry.severity === 'FAIL') {
    const live = typeof meta.rule === 'string' ? ruleIndex(root).get(meta.rule) : undefined;
    if (live) return { text: `\`${live.spec}\` -> "${live.heading}"`, spec: live.spec };
    if (typeof meta.spec === 'string' && SPEC.test(meta.spec) && typeof meta.heading === 'string'
        && specHeadings(root, meta.spec).includes(meta.heading)) {
      return { text: `\`${meta.spec}\` -> "${meta.heading}"`, spec: meta.spec };
    }
    return { text: 'withheld: the cited spec section is not in the checked-out specs' };
  }
  if (typeof meta.file === 'string' && PATH.test(meta.file) && !meta.file.startsWith('.git/')) {
    const path = join(root, meta.file);
    if (existsSync(path) && statSync(path).isFile()) return { text: `\`${meta.file}\``, file: meta.file };
  }
  return { text: 'path withheld: it is not a file in the checked-out tree' };
}

// --- Deciding disclosures -----------------------------------------------------

/**
 * Why a ledger entry is public, or null while it is still embargoed: closed as
 * not planned is dismissed, any other close is fixed (with the PR, when one is
 * cited and verified), and an open entry is due `DISCLOSURE_DAYS` after it was
 * filed.
 */
export function disclosureReason(entry, now, fixPr) {
  if (entry.state === 'CLOSED') {
    if (entry.stateReason === 'NOT_PLANNED') return { kind: 'dismissed' };
    return fixPr ? { kind: 'fixed', pr: fixPr } : { kind: 'closed' };
  }
  return now.getTime() >= disclosureDue(entry.createdAt).getTime() ? { kind: 'deadline' } : null;
}

/** The PR a maintainer's last `Fixed in` comment cites, when it names this repository. */
export const citedPr = (entry, repo) => {
  const last = entry.fixed.at(-1);
  return last && (last.repo === null || last.repo === repo) ? last.pr : null;
};

const REASON_TEXT = {
  fixed: (r, repo) => `fixed in [#${r.pr}](https://github.com/${repo}/pull/${r.pr})`,
  closed: () => 'closed, no fix PR cited',
  dismissed: () => 'dismissed: closed as not planned',
  deadline: () => `${DISCLOSURE_DAYS} days after it was filed, not yet fixed`,
};

/** The archive issue's title: fixed text, the key and ledger number, and the severity. */
export const disclosureTitle = (entry) => `[audit-disclosure ${archiveId(entry.key, entry.number)}] ${entry.severity} ${kindOf(entry.severity)}`;

/** One disclosure issue's body, from validated fields and a maintainer's summary only. */
export function disclosureBody({ entry, reason, disclosedAt, repo, root = '.' }) {
  valid(repo, /^[\w.-]+\/[\w.-]+$/, 'repository');
  valid(disclosedAt, ISO, 'disclosure date');
  const where = disclosedLocation(entry, root);
  const lines = [
    `A ${kindOf(entry.severity)} from the nightly security audit, published under its disclosure rule: when it is fixed, or ${DISCLOSURE_DAYS} days after it was filed, whichever comes first ([how the audit works](https://github.com/${repo}/blob/main/docs/specs/security.md#how-the-guarantees-are-checked)).`,
    '',
    '| | |',
    '| --- | --- |',
    `| Key | \`${entry.key}\` |`,
    `| Severity | ${entry.severity} |`,
    `| Kind | ${entry.severity === 'FAIL' ? 'a failed `FAIL IF` check' : 'a finding'} |`,
    `| Filed | ${day(entry.createdAt)} |`,
    `| Disclosed | ${day(disclosedAt)} |`,
    `| Why disclosed | ${REASON_TEXT[reason.kind](reason, repo)} |`,
    `| Where | ${where.text} |`,
  ];
  if (entry.summary) lines.push('', '### Public summary', '', '_Written by a maintainer._', '', entry.summary);
  lines.push('', `The evidence and reproduction stay in the private tracker${reason.kind === 'fixed' ? '; the fix PR describes the change' : ''}. To report a vulnerability, use the [private advisory form](https://github.com/${repo}/security/advisories/new), never an issue.`);
  return clampIssueBody(`${lines.join('\n')}\n`);
}

/**
 * The disclosure work a run does: create an issue for each ledger issue newly due
 * (closed already when its ledger issue is), and close an open one whose
 * ledger issue has since closed. `verify(pr)` says whether a cited PR merged
 * here. Re-running over the archive it produced plans nothing.
 */
export function planDisclosures({ ledger, archive, now, repo, verify, root = '.' }) {
  const actions = [];
  for (const entry of ledger) {
    if (!entry.key || !entry.severity) continue;
    const existing = archive.get(archiveId(entry.key, entry.number));
    if (existing?.state === 'CLOSED') continue;
    if (existing && entry.state === 'OPEN') continue;
    const cited = entry.state === 'CLOSED' ? citedPr(entry, repo) : null;
    const reason = disclosureReason(entry, now, cited && verify(cited) ? cited : null);
    if (!reason) continue;
    const disclosedAt = existing?.createdAt ?? now.toISOString();
    const body = disclosureBody({ entry, reason, disclosedAt, repo, root });
    const close = entry.state === 'CLOSED' ? (reason.kind === 'dismissed' ? 'not planned' : 'completed') : null;
    actions.push(existing
      ? { type: 'update', number: existing.number, entry, body, close }
      : { type: 'create', entry, title: disclosureTitle(entry), body, close });
  }
  return actions;
}

// --- The status issue ---------------------------------------------------------

/** This run's verdicts per domain: computed verdicts and counts, and the failed sections the specs carry. */
function runSection({ fragments, root }) {
  const lines = ['| Domain | Verdict | Failed checks | Rules with no result | Malformed lines | BLOCKER | WARNING |', '| --- | --- | --- | --- | --- | --- | --- |'];
  const sections = new Map();
  let unnamed = 0;
  let disagreements = 0;
  for (const [name, text] of Object.entries(fragments)) {
    valid(name, /^[\w.-]+\.md$/, 'fragment name');
    if (text === null) {
      lines.push(`| \`${name}\` | no report | – | – | – | – | – |`);
      continue;
    }
    const d = judgeFragment(root, name, text);
    const failed = d.results.filter((r) => r.status === 'FAIL');
    const merged = dedupFindings(d.findings.map((finding) => ({ fragment: name, finding })));
    const count = (severity) => merged.filter((m) => m.severity === severity).length;
    if (d.anomalies.length) disagreements++;
    lines.push(`| \`${name}\` | ${d.verdict}${d.finished ? '' : ', cut off'} | ${failed.length} | ${d.missing.length} | ${d.malformed.length + d.stray.length} | ${count('BLOCKER')} | ${count('WARNING')} |`);
    // Only a rule the manifest owes is named, by its spec and heading in the
    // checked-out specs; `domainVerdict` sorted every other one into `stray`,
    // and those are counted, never quoted.
    for (const r of failed) {
      if (d.stray.includes(r)) { unnamed++; continue; }
      const { spec, heading } = ruleIndex(root).get(r.id);
      const section = `\`${spec}\` -> "${heading}"`;
      sections.set(section, (sections.get(section) ?? 0) + 1);
    }
  }
  if (sections.size > 0 || unnamed > 0) {
    lines.push('', '**Failed `FAIL IF` sections:**', '');
    for (const [section, n] of sections) lines.push(`- ${section}${n > 1 ? ` (${n} checks)` : ''}`);
    if (unnamed > 0) lines.push(`- ${plural(unnamed, 'failed check')} named no rule its domain owes.`);
  }
  if (disagreements > 0) lines.push('', `${disagreements} domain${disagreements > 1 ? 's\'' : '\'s'} own verdict line disagreed with the verdict its lines compute; the computed one is reported.`);
  return lines;
}

const EMBARGO_NOTES = {
  filed: null,
  'missing-token': '**The private filing failed: `EMBARGO_TOKEN` is not set.** This run\'s details are only in its encrypted transcript.',
  'no-report': '**The private filing failed: no private report was composed.** Read the run\'s log.',
};

/**
 * The status issue's body. `ledger` is the parsed snapshot, or null when it
 * could not be read; `archive` the disclosure issues by ledger issue.
 */
export function statusBody({ status, fileStatus, date, runUrl, commit, repo, fragments, embargoResult = '', skipped = '', fullRunAt = '', ledger, archive, now, root = '.' }) {
  valid(status, /^(PASS|FAIL|MISSING)$/, 'status');
  valid(fileStatus, /^(PASS|FAIL|MISSING)$/, 'file status');
  valid(date, /^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/, 'date');
  valid(repo, /^[\w.-]+\/[\w.-]+$/, 'repository');
  valid(runUrl, new RegExp(`^https://github\\.com/${repo.replace(/[.]/g, '\\.')}/actions/runs/\\d+$`), 'run URL');
  valid(commit, /^[0-9a-f]{40}$/, 'commit');

  const open = ledger ? ledger.filter((e) => e.state === 'OPEN').sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : null;
  const outcome = outcomeOf(status);
  const lines = [`<!-- security-audit-status outcome=${outcome} -->`, '', '## Latest run', ''];
  if (status === 'PASS') {
    lines.push(open === null ? '**PASS**, but the private findings ledger could not be read, so whether findings remain open is unknown.'
      : embargoResult !== 'filed' ? '**PASS**, but the private filing failed, so this run\'s findings may be missing from the ledger.'
        : open.length ? `**PASS** — no check failed this run, but ${plural(open.length, 'finding')} ${open.length === 1 ? 'is' : 'are'} still open (below).`
          : '**PASS** — no check failed, and no finding is open.');
  } else {
    lines.push(status === 'FAIL' ? '**FAIL** — the audit failed.' : '**INCONCLUSIVE** — the audit reached no usable verdict.');
  }
  lines.push('', `Run at ${date} · [run](${runUrl}) · audited commit [\`${commit.slice(0, 7)}\`](https://github.com/${repo}/commit/${commit})`);
  if (skipped === 'true') {
    lines.push('', `The audit domains were skipped: the commit and GitHub settings are unchanged since a passing run. ${ISO.test(fullRunAt) ? `They last ran in full at ${fullRunAt}` : 'When they last ran in full is unknown'}; the GitHub-settings check runs every night.`);
  }
  lines.push('', ...runSection({ fragments, root }));
  if (fileStatus === 'MISSING' && status !== 'PASS') lines.push('', 'The orchestrator wrote no verdict.');
  if (embargoResult !== 'filed') lines.push('', EMBARGO_NOTES[embargoResult] ?? '**The private filing failed.** This run\'s details are only in its encrypted transcript; read the run\'s log for why.');

  lines.push('', '## Open findings', '');
  if (open === null) {
    lines.push('The private findings ledger could not be read this run.');
  } else if (open.length === 0) {
    lines.push('None.');
  } else {
    lines.push(`${plural(open.length, 'finding is', 'findings are')} open in the private ledger. Each is published when it is fixed, or on its disclosure date, whichever comes first.`, '',
      '| Key | Severity | Kind | Filed | Disclosure |', '| --- | --- | --- | --- | --- |');
    for (const e of open) {
      // A minted key is a hash; a hand-filed one is a name, held back until disclosure.
      const shown = e.key && archive.get(archiveId(e.key, e.number));
      const key = !e.key ? 'unidentified' : MINTED_KEY.test(e.key) || shown ? `\`${e.key}\`` : 'hand-filed';
      lines.push(`| ${key} | ${e.severity ?? '–'} | ${e.severity ? kindOf(e.severity) : '–'} | ${day(e.createdAt)} | ${shown ? `disclosed: #${shown.number}` : e.key ? day(disclosureDue(e.createdAt).toISOString()) : 'when identified'} |`);
    }
  }

  lines.push('', '## Disclosed', '');
  const recent = [...archive.values()].sort((a, b) => b.number - a.number).slice(0, RECENT_DISCLOSURES);
  if (recent.length === 0) lines.push('None yet.');
  for (const a of recent) {
    lines.push(`- #${a.number} — \`${a.key}\`, ${a.severity} ${kindOf(a.severity)}${a.createdAt ? `, disclosed ${day(a.createdAt)}` : ''}${a.state === 'OPEN' ? ', not yet fixed' : ''}`);
  }
  const search = `https://github.com/${repo}/issues?q=is%3Aissue+label%3A${DISCLOSURE_LABEL}`;
  lines.push('', `Every disclosed finding: [\`${DISCLOSURE_LABEL}\`](${search}).`);

  lines.push('', '---', '',
    `Every run of the nightly security audit rewrites this issue. What the audit checks, and how: [dormouse.sh/security](https://dormouse.sh/security) ([source](https://github.com/${repo}/blob/main/docs/specs/security.md#how-the-guarantees-are-checked)). Finding detail stays private until the finding is fixed, or ${DISCLOSURE_DAYS} days after it is filed, whichever comes first; then it is published under [\`${DISCLOSURE_LABEL}\`](${search}). Subscribe to be notified when the outcome changes or a finding is disclosed. To report a vulnerability, use the [private advisory form](https://github.com/${repo}/security/advisories/new), never an issue.`);
  return clampIssueBody(`${lines.join('\n')}\n`);
}

/** The outcome an earlier run recorded in the status issue's first line, or null. */
export const previousOutcome = (body) => (typeof body === 'string' ? body.match(STATUS_MARKER)?.[1] ?? null : null);

// --- The second-opinion audit ------------------------------------------------------

/** The marker opening every second-opinion comment on the status issue. */
export const CODEX_MARKER = '<!-- codex-audit-report -->';
const MODEL = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const COUNT = /^(?:0|[1-9]\d{0,5})$/;

/** `domain=VERDICT …` read into pairs, every domain one the prompts name, each at most once. */
export function parseVerdicts(text, root = '.') {
  const known = domains(root).map((d) => d.domain);
  const out = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const [, domain, verdict] = valid(word, /^([a-z-]+)=(PASS|FAIL|INCONCLUSIVE)$/, 'verdict').match(/^([a-z-]+)=(\w+)$/);
    if (!known.includes(domain)) throw new Error(`invalid verdict: no domain ${JSON.stringify(domain)}`);
    if (out.some((v) => v.domain === domain)) throw new Error(`invalid verdict: ${domain} twice`);
    out.push({ domain, verdict });
  }
  return out;
}

/**
 * The second-opinion audit's canary counts, or null when none were given; throws
 * unless all are but `either`, each a count, caught no more than seeded and
 * either between them, and no more unfinished domains than the `domains` a
 * canary runs. An empty `either` was not computed: null, never zero.
 */
export function parseCanary({ run = '', seeded = '', caught = '', either = '', unfinished = '' }, domains) {
  const given = [run, seeded, caught, either, unfinished];
  if (given.every((v) => v === '')) return null;
  valid(run, /^[1-9]\d{0,19}$/, 'canary run');
  const [s, c, u] = [seeded, caught, unfinished].map((v, i) => Number(valid(v, COUNT, ['canary seeded', 'canary caught', 'canary unfinished'][i])));
  const e = either === '' ? null : Number(valid(either, COUNT, 'canary either'));
  if (c > (e ?? s) || (e ?? c) > s) throw new Error(`invalid canary counts: caught ${c}, either ${e ?? 'not computed'}, seeded ${s}`);
  if (u > domains) throw new Error(`invalid canary counts: ${u} unfinished domains of ${domains}`);
  return { run, seeded: s, caught: c, either: e, unfinished: u };
}

/**
 * Checks the second-opinion audit's canary against the CI canary run it shares
 * seeds with — `claudeRun`, the API's view of it, and `claude`, its
 * `canary-recall` record, read by `validateRecord` — and returns that
 * record's counts: a run
 * titled `canaryTitle` of `security-audit.yaml` on `main` at the same commit,
 * as many seeds, and an `either`, when computed, that neither engine's own
 * count exceeds nor their sum falls short of.
 */
export function checkAgainstClaude(canary, { commit, repo, claudeRun, claude, canaryTitle, validateRecord }) {
  const where = `canary run ${canary.run}`;
  if (claudeRun?.display_title !== canaryTitle || claudeRun.head_branch !== 'main' || claudeRun.path !== '.github/workflows/security-audit.yaml'
    || claudeRun.head_repository?.full_name !== repo) throw new Error(`${where} is not a canary run of security-audit.yaml on main`);
  if (claudeRun.head_sha !== commit) throw new Error(`${where} seeded ${claudeRun.head_sha}, not ${commit}: the same key seeds the same seeds only over the same commit`);
  const counts = validateRecord(claude, Number(canary.run));
  if (counts.seeded !== canary.seeded) throw new Error(`${where} seeded ${counts.seeded}, not ${canary.seeded}`);
  if (canary.either !== null && (canary.either < counts.caught || canary.either > counts.caught + canary.caught)) {
    throw new Error(`either ${canary.either} cannot follow from Claude's ${counts.caught} and Codex's ${canary.caught} of ${canary.seeded}`);
  }
  return counts;
}

const percent = (n, of) => `${Math.round((n / of) * 100)}%`;

/** The comment the second-opinion audit's report posts on the status issue. */
export function codexComment({ date, runUrl, commit, model, repo, verdicts, canary, claude }) {
  valid(date, /^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/, 'date');
  valid(repo, /^[\w.-]+\/[\w.-]+$/, 'repository');
  valid(runUrl, new RegExp(`^https://github\\.com/${repo.replace(/[.]/g, '\\.')}/actions/runs/\\d+$`), 'run URL');
  valid(commit, /^[0-9a-f]{40}$/, 'commit');
  valid(model, MODEL, 'model');
  const lines = [CODEX_MARKER, '', '## Second-opinion audit: Codex', '',
    `Reported at ${date} · model \`${model}\` · audited commit [\`${commit.slice(0, 7)}\`](https://github.com/${repo}/commit/${commit}) · [report run](${runUrl})`, '',
    'A maintainer ran these prompts on Codex. Its verdicts never gate a release; the nightly Claude audit does.'];
  if (verdicts.length > 0) {
    lines.push('', '| Domain | Verdict |', '| --- | --- |', ...verdicts.map((v) => `| \`${v.domain}\` | ${v.verdict} |`));
  }
  if (canary) {
    const claudeUrl = `https://github.com/${repo}/actions/runs/${canary.run}`;
    const together = canary.either === null ? '; how many the two caught together was not computed' : `, and the two together ${canary.either} (${percent(canary.either, canary.seeded)})`;
    lines.push('', `**Canary**, on the seeds of [canary run ${canary.run}](${claudeUrl}): Claude caught ${claude.caught} of ${canary.seeded} (${percent(claude.caught, canary.seeded)}), Codex ${canary.caught} (${percent(canary.caught, canary.seeded)})${together}.`);
    if (canary.unfinished > 0) lines.push('', `${plural(canary.unfinished, 'Codex domain')} left no finished report; ${canary.unfinished === 1 ? 'its' : 'their'} seeds count as missed.`);
  }
  return clampIssueBody(`${lines.join('\n')}\n`);
}

/** The second-opinion audit's recall record, which website/scripts/generate-canary-recall.js reads; `either` null when not computed. */
export function codexRecord({ runUrl, commit, model, repo, canary }) {
  return { claude_run_url: `https://github.com/${repo}/actions/runs/${canary.run}`, commit, model,
    seeded: canary.seeded, caught: canary.caught, either: canary.either, unfinished: canary.unfinished, run_url: runUrl };
}

// --- Publishing ---------------------------------------------------------------

/** `gh` on the workflow token; throws on failure, so nothing is published half-checked. */
function gh(args, { allowFail = false } = {}) {
  const run = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0 && !allowFail) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(run.stderr ?? '').trim().slice(0, 300)}`);
  return run.status === 0 ? run.stdout : null;
}

function bodyFile(dir, name, text) {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

/** Whether PR `pr` of `repo` merged, by the API, never by what a comment claims. */
function prMerged(repo, pr) {
  const out = gh(['api', `repos/${repo}/pulls/${pr}`], { allowFail: true });
  try {
    return out !== null && JSON.parse(out).merged_at != null;
  } catch { return false; }
}

const issueNumber = (url) => Number(valid(url.trim(), /\/issues\/\d+$/, 'created issue URL').match(/(\d+)$/)[1]);

function publish(args) {
  const repo = valid(process.env.GITHUB_REPOSITORY, /^[\w.-]+\/[\w.-]+$/, 'repository');
  const now = new Date();
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'audit-public-'));
  const R = ['--repo', repo];

  for (const [label, color, description] of [[STATUS_LABEL, '0E8A16', 'Security audit status'], [DISCLOSURE_LABEL, 'B60205', 'Disclosed security audit finding']]) {
    gh(['label', 'create', label, ...R, '--color', color, '--description', description], { allowFail: true });
  }
  const ledgerPath = args.ledger ?? '';
  const ledger = ledgerPath && existsSync(ledgerPath) ? parseLedger(readFileSync(ledgerPath, 'utf8')) : null;
  // Every disclosure, not `gh`'s default 30: a title missed here is published a
  // second time, so a list that fills the limit, and may have left one out, fails.
  const disclosures = JSON.parse(gh(['issue', 'list', ...R, '--label', DISCLOSURE_LABEL, '--state', 'all', '--limit', String(LIST_LIMIT), '--json', 'number,title,state,createdAt']));
  if (disclosures.length >= LIST_LIMIT) throw new Error(`The disclosure list filled its ${LIST_LIMIT}-issue read; raise the limit before publishing.`);
  const archive = parseArchive(disclosures);

  // Disclosures first, so the status body lists what this run published.
  const disclosed = [];
  for (const action of ledger ? planDisclosures({ ledger, archive, now, repo, verify: (pr) => prMerged(repo, pr) }) : []) {
    const file = bodyFile(dir, `disclosure-${action.entry.number}.md`, action.body);
    let number = action.number;
    if (action.type === 'create') {
      number = issueNumber(gh(['issue', 'create', ...R, '--title', action.title, '--label', DISCLOSURE_LABEL, '--body-file', file]));
      disclosed.push({ number, entry: action.entry });
      archive.set(archiveId(action.entry.key, action.entry.number), { number, key: action.entry.key, severity: action.entry.severity, state: action.close ? 'CLOSED' : 'OPEN', createdAt: now.toISOString() });
    } else {
      gh(['issue', 'edit', String(number), ...R, '--body-file', file]);
      archive.get(archiveId(action.entry.key, action.entry.number)).state = 'CLOSED';
    }
    if (action.close) gh(['issue', 'close', String(number), ...R, '--reason', action.close]);
  }

  const statuses = JSON.parse(gh(['issue', 'list', ...R, '--label', STATUS_LABEL, '--state', 'open', '--limit', '100', '--json', 'number,body']))
    .sort((a, b) => a.number - b.number);
  const status = args.status;
  const body = statusBody({
    status, fileStatus: readFileStatus(), date: args.date, runUrl: args['run-url'], commit: args.commit, repo,
    fragments: readFragments(), embargoResult: args['embargo-result'] ?? '', skipped: args.skipped ?? '',
    fullRunAt: args['full-run-at'] ?? '', ledger, archive, now,
  });
  const file = bodyFile(dir, 'status.md', body);
  let issue = statuses[0]?.number;
  const before = previousOutcome(statuses[0]?.body);
  if (issue) {
    gh(['issue', 'edit', String(issue), ...R, '--body-file', file]);
  } else {
    issue = issueNumber(gh(['issue', 'create', ...R, '--title', 'Security audit status', '--label', STATUS_LABEL, '--body-file', file]));
  }
  // Comments notify subscribers, so only on a change.
  const outcome = outcomeOf(status);
  if (before && before !== outcome) {
    gh(['issue', 'comment', String(issue), ...R, '--body', `The audit's outcome changed from ${before} to ${outcome} at ${args.date}. [Run](${args['run-url']})`]);
  }
  for (const { number, entry } of disclosed) {
    gh(['issue', 'comment', String(issue), ...R, '--body', `Disclosed: #${number}, \`${entry.key}\` (${entry.severity} ${kindOf(entry.severity)}).`]);
  }
  console.log(`Status issue #${issue}: ${outcome}; ${plural(disclosed.length, 'finding')} newly disclosed.`);

  // Only a PASS whose findings were filed and whose ledger was read succeeds.
  const ok = status === 'PASS' && ledger !== null && (args['embargo-result'] ?? '') === 'filed';
  if (status === 'PASS' && !ok) console.log('::error::The audit passed, but its findings could not be filed or the ledger read; the run fails so the release gate stays shut.');
  return ok;
}

/**
 * The second-opinion audit's report: every input checked before anything is
 * posted. The canary's contract is imported here alone, so the nightly's own
 * publishing never loads the recall generator.
 */
async function publishCodex(args) {
  const { CANARY_DOMAINS } = await import('./security-audit-canary.mjs');
  const { CANARY_TITLE, validateRecord } = await import('../website/scripts/generate-canary-recall.js');
  const repo = valid(process.env.GITHUB_REPOSITORY, /^[\w.-]+\/[\w.-]+$/, 'repository');
  const R = ['--repo', repo];
  const commit = valid(args.commit, /^[0-9a-f]{40}$/, 'commit');
  valid(args.model, MODEL, 'model');
  const verdicts = parseVerdicts(args.verdicts ?? '');
  const canary = parseCanary({ run: args['canary-run'], seeded: args['canary-seeded'], caught: args['canary-caught'],
    either: args['canary-either'], unfinished: args['canary-unfinished'] }, CANARY_DOMAINS.length);
  if (verdicts.length === 0 && canary === null) throw new Error('nothing to report: give verdicts, canary counts, or both');
  // An admin's dispatch alone: the bot's `push` can dispatch a workflow too.
  const actor = valid(process.env.GITHUB_TRIGGERING_ACTOR, /^[A-Za-z0-9-]+(?:\[bot\])?$/, 'triggering actor');
  const role = gh(['api', `repos/${repo}/collaborators/${actor}/permission`, '--jq', '.role_name']).trim();
  if (role !== 'admin') throw new Error(`${actor} holds ${role || 'no role'} here; only an admin publishes a second-opinion report`);
  // Only a commit on this repository's `main`, so a report names code that shipped there.
  const compare = JSON.parse(gh(['api', `repos/${repo}/compare/${commit}...main`, '--jq', '{status}']));
  if (!['identical', 'ahead'].includes(compare.status)) throw new Error(`${commit} is not on main`);
  let claude = null;
  if (canary) {
    const claudeRun = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${canary.run}`]));
    const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'canary-recall-'));
    gh(['run', 'download', canary.run, ...R, '-n', 'canary-recall', '-D', dir]);
    claude = checkAgainstClaude(canary, { commit, repo, claudeRun, claude: JSON.parse(readFileSync(join(dir, 'canary-recall.json'), 'utf8')),
      canaryTitle: CANARY_TITLE, validateRecord });
  }
  const fields = { date: args.date, runUrl: args['run-url'], commit, model: args.model, repo, verdicts, canary, claude };
  const body = codexComment(fields);
  const record = canary ? codexRecord(fields) : null;
  const statuses = JSON.parse(gh(['issue', 'list', ...R, '--label', STATUS_LABEL, '--state', 'open', '--limit', '100', '--json', 'number']))
    .sort((a, b) => a.number - b.number);
  // The nightly audit owns the status issue: with none, there is nothing to comment on.
  if (statuses.length === 0) throw new Error(`no open issue labeled ${STATUS_LABEL}`);
  if (record) writeFileSync(valid(args.record, /\S/, 'record file'), `${JSON.stringify(record, null, 2)}\n`);
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'codex-public-'));
  gh(['issue', 'comment', String(statuses[0].number), ...R, '--body-file', bodyFile(dir, 'codex.md', body)]);
  console.log(`Status issue #${statuses[0].number}: second-opinion report posted${record ? ', recall record written' : ''}.`);
}

async function main(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument: ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1] ?? '';
  }
  if (args.engine !== undefined) {
    valid(args.engine, /^codex$/, 'engine');
    await publishCodex(args);
    return;
  }
  const ok = publish(args);
  // Written last: a builder that throws hands on nothing, which the step reads as a failure.
  writeFileSync(valid(args.outputs, /\S/, 'outputs file'), `passed=${ok}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
