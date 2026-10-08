#!/usr/bin/env node
/**
 * The security audit's verdicts, computed from what the domains recorded rather
 * than read from what they concluded. See docs/specs/security-audit.md ->
 * "Outcomes and reporting" for the contract and `.github/audit/_preamble.md`
 * for the line grammar the domains write.
 *
 *   node scripts/security-audit-report.mjs manifest <fragment>
 *     The result lines that domain owes: one per `FAIL IF` rule in its specs.
 *   node scripts/security-audit-report.mjs check <fragment>
 *     The local runner's verdict on one fragment; exit 0 only on PASS.
 *   node scripts/security-audit-report.mjs compose --run-url <url> [--transcript-url <url>] --outputs <file>
 *     The reporting step: writes `audit-private.md`, the findings ledger under
 *     `audit-ledger/`, and the step outputs to <file>. Fragments named by
 *     $AUDIT_FRAGMENTS, `audit-status.txt`, the domain prompts, and the specs
 *     are read from the working directory.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clampIssueBody } from './clamp-issue-body.mjs';

export const SENTINEL = '<!-- END OF REPORT -->';
const AUDIT_DIR = '.github/audit';

/** A rule line in a spec, the same match `scripts/spec-lint.mjs` uses: the bold leads the line. */
const FAIL_IF_RE = /^\s*(?:[-*]\s+)?\*\*FAIL IF\b/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/** `- PASS: `docs/specs/security-ci.md` -> "GitHub Actions Policies" #2.b — <clause>: <evidence>` */
const RESULT_RE = /^- (PASS|FAIL|UNVERIFIABLE): `(docs\/specs\/security[a-z-]*\.md)` -> "([^"\n]+)" #([1-9]\d*)(?:\.([a-z]))? — (\S.*)$/;
/** `- WARNING: `path/to/file.ts:88` `rootCause` — <summary>` */
const FINDING_RE = /^- (BLOCKER|WARNING|INFO): `([^`\s:]+):([1-9]\d*)(?:-\d+)?` `([^`\n]+)` — (\S.*)$/;
/** `- QUALITATIVE: done — <what the pass covered>` */
const QUALITATIVE_RE = /^- QUALITATIVE: done — \S/;
/** Anything that starts the way a result, finding, or marker line does, written or not to the grammar. */
const LOOSE_RE = /^\s*(?:[-*+]\s+)?(?:\*\*|__|\[)?\s*(PASS|FAIL|UNVERIFIABLE|BLOCKER|WARNING|INFO|QUALITATIVE)\b/;
/** The evidence a BLOCKER or WARNING carries, one indented sub-bullet each. */
const EVIDENCE = ['Code', 'Path', 'Reproduction'];

const RANK = { PASS: 0, INCONCLUSIVE: 1, FAIL: 2 };
const SEVERITY_RANK = { INFO: 0, WARNING: 1, BLOCKER: 2 };
const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);
const clip = (s, n = 500) => (s.length > n ? `${s.slice(0, n)}…` : s);

// --- Manifest: what each domain owes ---------------------------------------

const domainCache = new Map();
/** Each domain prompt's fragment and the security specs its `**Scope` list claims. */
export function domains(root = '.') {
  if (!domainCache.has(root)) domainCache.set(root, readDomains(root));
  return domainCache.get(root);
}

function readDomains(root) {
  const dir = join(root, AUDIT_DIR);
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'orchestrator.md').sort()) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n');
    const fragment = lines.map((l) => l.match(/^\*\*Output file:\*\* `([\w.-]+\.md)`/)?.[1]).find(Boolean);
    const at = lines.findIndex((l) => /^\*\*Scope\b/.test(l));
    if (!fragment || at < 0) continue;
    let j = at + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    const specs = [];
    for (; j < lines.length && /^[-*]\s/.test(lines[j]); j++) {
      for (const m of lines[j].matchAll(/`([^`]+)`/g)) specs.push(m[1]);
    }
    out.push({ domain: file.replace(/\.md$/, ''), fragment, specs });
  }
  return out;
}

/**
 * Every heading of one spec that carries `FAIL IF` rules, with how many, in
 * source order — the rule's number under its heading is its position. Fenced
 * code is skipped, and nothing under `## Future` is a rule.
 */
function specManifest(root, spec) {
  const path = join(root, spec);
  // Fail closed: a moved spec must not shrink what its domain owes to nothing.
  if (!existsSync(path)) throw new Error(`a domain claims ${spec}, which does not exist`);
  const counts = new Map();
  let heading = null;
  let fenced = false;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (FENCE_RE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h = line.match(HEADING_RE);
    if (h) {
      if (h[1] === '##' && /^Future\b/.test(h[2])) break;
      heading = h[2];
      continue;
    }
    if (heading !== null && FAIL_IF_RE.test(line)) counts.set(heading, (counts.get(heading) ?? 0) + 1);
  }
  return [...counts].map(([title, count]) => ({ heading: title, count }));
}

/**
 * The rules a fragment's domain owes a result for, as `spec\0heading` -> rule
 * count. Throws for a fragment no domain writes: an empty manifest would let
 * any fragment pass.
 */
export function fragmentManifest(root, fragment) {
  const domain = domains(root).find((d) => d.fragment === fragment);
  if (!domain) throw new Error(`no domain prompt writes ${fragment}`);
  const owed = new Map();
  for (const spec of domain.specs) {
    for (const { heading, count } of specManifest(root, spec)) owed.set(`${spec}\0${heading}`, count);
  }
  return owed;
}

// --- Parsing one fragment --------------------------------------------------

/** The verdict a fragment's first line states, by the grammar the reporting step has always read. */
function statedVerdict(firstLine) {
  if (firstLine === 'VERDICT: PASS') return 'PASS';
  if (firstLine === 'VERDICT: INCONCLUSIVE') return 'INCONCLUSIVE';
  if (firstLine.startsWith('VERDICT: FAIL')) return 'FAIL';
  return null;
}

/** Every structured line of a fragment, and every line that tried to be one and is not. */
function parseFragment(text) {
  const lines = text.split('\n');
  const parsed = {
    stated: statedVerdict(lines[0] ?? ''),
    finished: lines.filter((l) => l.trim() !== '').at(-1) === SENTINEL,
    results: [], findings: [], malformed: [], qualitative: 0,
  };
  let fenced = false;
  let finding = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // A finding's evidence is its indented continuation, fenced code included.
    if (finding && (line.trim() === '' || /^\s/.test(line))) {
      finding.block.push(line);
      if (FENCE_RE.test(line)) fenced = !fenced;
      continue;
    }
    if (FENCE_RE.test(line)) { fenced = !fenced; finding = null; continue; }
    if (fenced) continue;
    if (finding) closeFinding(parsed, finding);
    finding = null;
    let m;
    if ((m = line.match(RESULT_RE))) {
      parsed.results.push({ status: m[1], spec: m[2], heading: m[3], rule: Number(m[4]), clause: m[5] ?? null, line });
    } else if ((m = line.match(FINDING_RE))) {
      finding = { severity: m[1], path: m[2], line: Number(m[3]), cause: m[4], summary: m[5], header: line, block: [line] };
    } else if (QUALITATIVE_RE.test(line)) {
      parsed.qualitative++;
    } else if (LOOSE_RE.test(line)) {
      parsed.malformed.push({ line, why: 'not in the grammar `.github/audit/_preamble.md` fixes' });
    }
  }
  if (finding) closeFinding(parsed, finding);
  return parsed;
}

/** A BLOCKER or WARNING without its evidence is a claim, not a finding: it cannot pass and is not filed as one. */
function closeFinding(parsed, finding) {
  while (finding.block.length > 1 && finding.block.at(-1).trim() === '') finding.block.pop();
  if (finding.severity !== 'INFO') {
    const missing = EVIDENCE.filter((field) => !finding.block.some((l) => new RegExp(`^\\s+[-*] ${field}: \\S`).test(l)));
    if (missing.length > 0) {
      parsed.malformed.push({ line: finding.header, why: `${finding.severity} without its ${missing.join(', ')} evidence` });
      // Still counted at its severity: a malformed BLOCKER is a claimed BLOCKER.
    }
  }
  parsed.findings.push(finding);
}

/** A rule's id in the result-line grammar: `` `spec` -> "heading" #n[.c] ``. */
export const ruleId = (spec, heading, n, clause) => `\`${spec}\` -> "${heading}" #${n}${clause ? `.${clause}` : ''}`;

/** Every rule id a manifest owes, in order. */
export const owedIds = (owed) => [...owed].flatMap(([key, count]) => {
  const [spec, heading] = key.split('\0');
  return Array.from({ length: count }, (_, i) => ruleId(spec, heading, i + 1));
});

// --- The computed verdict --------------------------------------------------

/**
 * One domain's verdict from its own lines. `text` is null for a fragment that
 * is absent or empty.
 */
export function domainVerdict(text, owed) {
  if (text === null) {
    return { verdict: 'INCONCLUSIVE', stated: null, absent: true, finished: false, doubts: ['it left no report'],
      results: [], findings: [], malformed: [], missing: owedIds(owed), stray: [], anomalies: [] };
  }
  const p = parseFragment(text);
  const missing = [];
  const stray = [];
  const byRule = new Map();
  for (const r of p.results) {
    const key = `${r.spec}\0${r.heading}`;
    if (!owed.has(key) || r.rule > owed.get(key)) { stray.push(r); continue; }
    const id = `${key}\0${r.rule}`;
    if (!byRule.has(id)) byRule.set(id, []);
    byRule.get(id).push(r);
  }
  for (const [key, count] of owed) {
    const [spec, heading] = key.split('\0');
    for (let n = 1; n <= count; n++) {
      const name = ruleId(spec, heading, n);
      const lines = byRule.get(`${key}\0${n}`);
      if (!lines) { missing.push(name); continue; }
      // Clauses are lettered from `a` with no gap: a gap is a clause skipped.
      const letters = [...new Set(lines.map((r) => r.clause).filter(Boolean))].sort();
      letters.forEach((letter, i) => {
        if (letter !== String.fromCharCode(97 + i)) missing.push(`${name}.${String.fromCharCode(97 + i)}`);
      });
    }
  }
  const failed = p.results.some((r) => r.status === 'FAIL') || p.findings.some((f) => f.severity === 'BLOCKER');
  const doubts = [];
  if (p.results.some((r) => r.status === 'UNVERIFIABLE')) doubts.push('a check is `UNVERIFIABLE`');
  if (missing.length) doubts.push(`${missing.length} rule${missing.length > 1 ? 's have' : ' has'} no result line`);
  if (p.malformed.length) doubts.push(`${p.malformed.length} line${p.malformed.length > 1 ? 's are' : ' is'} malformed`);
  if (stray.length) doubts.push(`${stray.length} result line${stray.length > 1 ? 's name' : ' names'} no rule this domain owes`);
  if (p.qualitative !== 1) doubts.push(p.qualitative ? 'it recorded more than one qualitative pass' : 'it recorded no finished qualitative pass');
  if (!p.finished) doubts.push('it never wrote its sentinel');
  if (p.stated === null) doubts.push('its first line is not a verdict');
  const computed = failed ? 'FAIL' : doubts.length ? 'INCONCLUSIVE' : 'PASS';
  const anomalies = [];
  if (p.stated !== null && p.stated !== computed) {
    anomalies.push(`its first line says \`VERDICT: ${p.stated}\`, its lines compute ${computed}`);
  }
  // The computed verdict decides. A domain more doubtful than its lines is not
  // overruled into a PASS, and is not taken at its word either.
  let verdict = computed;
  if (computed === 'PASS' && p.stated !== 'PASS') {
    verdict = 'INCONCLUSIVE';
    doubts.push('its own line is more doubtful than its lines');
  }
  return { verdict, stated: p.stated, absent: false, finished: p.finished, doubts,
    results: p.results, findings: p.findings, malformed: p.malformed, missing, stray, anomalies };
}

/** The run's verdict: the worst domain, and never PASS unless the orchestrator wrote exactly `PASS`. */
function runVerdict(domainsByFragment, fileStatus) {
  let overall = 'PASS';
  for (const d of Object.values(domainsByFragment)) overall = worst(overall, d.verdict);
  const anomalies = [];
  if (fileStatus !== 'MISSING' && fileStatus !== overall) {
    anomalies.push(`\`audit-status.txt\` says \`${fileStatus}\`, the domains' lines compute ${overall}`);
  }
  if (overall === 'PASS' && fileStatus !== 'PASS') overall = 'INCONCLUSIVE';
  return { overall, anomalies };
}

// --- Duplicates and the ledger ---------------------------------------------

const normPath = (p) => p.replace(/^\.\//, '').replace(/^\/+/, '');
const normCause = (c) => c.trim().toLowerCase().replace(/\(\)$/, '').replace(/\s+/g, ' ');

/**
 * Findings that name the same root cause in the same file within five lines are
 * one finding. Each merged finding keeps its worst severity, the block of the
 * first report at that severity, and every reporting fragment.
 */
export function dedupFindings(entries) {
  const sorted = entries
    .map((e) => ({ ...e, key: `${normPath(e.finding.path)}\0${normCause(e.finding.cause)}` }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.finding.line - b.finding.line));
  const merged = [];
  for (const e of sorted) {
    const last = merged.at(-1);
    if (last && last.key === e.key && e.finding.line - last.lastLine <= 5) {
      last.reports.push(e);
      last.lastLine = e.finding.line;
      continue;
    }
    merged.push({ key: e.key, lastLine: e.finding.line, reports: [e] });
  }
  return merged.map(({ key, reports }) => {
    const best = reports.reduce((a, b) => (SEVERITY_RANK[b.finding.severity] > SEVERITY_RANK[a.finding.severity] ? b : a));
    return { key, severity: best.finding.severity, finding: best.finding,
      fragments: [...new Set(reports.map((r) => r.fragment))], others: reports.filter((r) => r !== best) };
  }).sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/** A ledger key: stable across runs, so line drift does not open a second issue for one finding. */
export const ledgerKey = (...parts) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 12);

// --- Compose ---------------------------------------------------------------

/** The orchestrator's `audit-status.txt`: exactly `PASS` or `FAIL`, or MISSING. */
export function readFileStatus() {
  const text = existsSync('audit-status.txt') ? readFileSync('audit-status.txt', 'utf8') : '';
  return text === 'PASS' || text === 'PASS\n' ? 'PASS' : text === 'FAIL' || text === 'FAIL\n' ? 'FAIL' : 'MISSING';
}

/** Everything the reporting step decides, from the working directory. */
function compose({ fragments, root = '.', fileStatus, runUrl, transcriptUrl = '', commit, date }) {
  const byFragment = {};
  for (const [name, text] of Object.entries(fragments)) byFragment[name] = domainVerdict(text, fragmentManifest(root, name));
  const run = runVerdict(byFragment, fileStatus);
  const status = run.overall === 'INCONCLUSIVE' ? 'MISSING' : run.overall;

  const entries = Object.entries(byFragment).flatMap(([fragment, d]) => d.findings.map((finding) => ({ fragment, finding })));
  const merged = dedupFindings(entries);

  // The ledger: one entry per failed rule clause, and per file and root
  // cause among the merged BLOCKERs and WARNINGs.
  const ledger = new Map();
  for (const [fragment, d] of Object.entries(byFragment)) {
    for (const r of d.results.filter((x) => x.status === 'FAIL')) {
      const key = ledgerKey('check', r.spec, r.heading, r.rule, r.clause ?? '');
      if (!ledger.has(key)) ledger.set(key, { key, severity: 'FAIL', title: `FAIL: ${ruleId(r.spec, r.heading, r.rule, r.clause)}`, body: `Reported by \`${fragment}\`:\n\n${r.line}\n` });
    }
  }
  for (const m of merged.filter((x) => x.severity !== 'INFO')) {
    const key = ledgerKey('finding', m.key);
    const f = m.finding;
    if (ledger.has(key)) { ledger.get(key).body += `\n---\n\n${f.block.join('\n')}\n`; continue; }
    ledger.set(key, { key, severity: m.severity, title: `${m.severity}: ${f.path}:${f.line} ${f.cause} — ${f.summary}`,
      body: `Reported by ${m.fragments.map((x) => `\`${x}\``).join(', ')}:\n\n${f.block.join('\n')}\n` });
  }
  const note = `First filed from [this run](${runUrl}) at commit \`${commit}\`. The audit never closes this issue: close it when the fix lands, citing the PR.`;
  for (const e of ledger.values()) {
    e.title = clip(`[audit-finding ${e.key}] ${e.title}`, 240);
    e.body = clampIssueBody(`${e.body}\n${note}\n`, 'The rest is in the run\'s encrypted `audit-transcript` artifact.');
  }

  const lines = [];
  const links = `[Run](${runUrl})${transcriptUrl ? ` · [Transcript](${transcriptUrl})` : ''} · audited commit \`${commit}\``;
  const headline = status === 'FAIL' ? `Audit failed at ${date}.`
    : status === 'PASS' ? `Audit passed at ${date}.`
      : `Audit reached no usable verdict at ${date}. ${run.anomalies.length || Object.values(byFragment).some((d) => d.anomalies.length || d.malformed.length)
        ? 'A domain claimed more than its result lines record; read the anomalies before treating this as no finding.'
        : 'This is not a security finding: the run ended without deciding.'}`;
  lines.push(`${headline} ${links}`, '');
  lines.push(...notes(byFragment, fileStatus));
  lines.push('### Computed verdicts', '', '| Domain | Computed | Its own line | Missing rules | Malformed lines |', '| --- | --- | --- | --- | --- |');
  for (const [name, d] of Object.entries(byFragment)) {
    lines.push(`| \`${name}\` | ${d.absent ? 'no report' : d.verdict}${d.absent || d.finished ? '' : ', cut off'} | ${d.stated ?? (d.absent ? '–' : 'unreadable')} | ${d.missing.length} | ${d.malformed.length + d.stray.length} |`);
  }
  lines.push('', `Orchestrator's \`audit-status.txt\`: ${fileStatus === 'MISSING' ? 'absent or unreadable' : `\`${fileStatus}\``}.`, '');

  const anomalies = [...run.anomalies.map((a) => `- ${a}.`),
    ...Object.entries(byFragment).flatMap(([name, d]) => d.anomalies.map((a) => `- \`${name}\`: ${a}.`))];
  if (anomalies.length) lines.push('### Anomalies', '', '_Where a verdict line disagrees with the lines under it, the computed verdict is the one this run reports._', '', ...anomalies, '');

  const nonPass = Object.entries(byFragment).flatMap(([name, d]) =>
    d.results.filter((r) => r.status !== 'PASS').map((r) => `- \`${name}\`: ${clip(r.line)}`));
  if (nonPass.length) lines.push('### Checks that did not pass', '', ...nonPass, '');

  const missing = Object.entries(byFragment).flatMap(([name, d]) =>
    (d.absent ? [] : d.missing).map((m) => `- \`${name}\`: ${m}`));
  if (missing.length) lines.push('### Rules with no result line', '', '_Each counts as undetermined: the domain skipped it, or wrote its line outside the grammar._', '', ...missing, '');

  const malformed = Object.entries(byFragment).flatMap(([name, d]) => [
    ...d.malformed.map((m) => `- \`${name}\` (${m.why}): ${clip(m.line)}`),
    ...d.stray.map((r) => `- \`${name}\` (names no rule this domain owes): ${clip(r.line)}`)]);
  if (malformed.length) lines.push('### Malformed lines', '', ...malformed, '');

  if (merged.length) {
    lines.push('### Findings', '', `_${entries.length} reported, ${merged.length} after merging duplicates (same file and root cause within five lines)._`, '');
    for (const m of merged) {
      lines.push(...m.finding.block);
      const also = m.others.map((o) => `\`${o.fragment}\` ${o.finding.severity} at line ${o.finding.line}`);
      if (also.length) lines.push(`  - _Also reported by ${also.join('; ')}._`);
      lines.push(`  - _From ${m.fragments.map((x) => `\`${x}\``).join(', ')}._`);
    }
    lines.push('');
  }
  lines.push(`_\`PASS\` lines, each domain's prose, and the orchestrator's merged report are in the encrypted \`audit-transcript\` artifact${transcriptUrl ? ` ([download](${transcriptUrl}))` : ''}._`);

  return { status, ledger: [...ledger.values()], privateReport: `${lines.join('\n')}\n` };
}

/** One note per condition that holds, each claiming nothing about the others. */
function notes(byFragment, fileStatus) {
  const of = (pick) => Object.entries(byFragment).filter(([, d]) => pick(d)).map(([n]) => n).join(', ');
  const out = [];
  const failing = of((d) => d.verdict === 'FAIL');
  if (failing) out.push(`- **A domain's lines record a failure.** ${failing} carries a \`FAIL\` result or a \`BLOCKER\` — read its lines below first.`);
  const absent = of((d) => d.absent);
  if (absent) out.push(`- **A domain left no report.** No nonempty fragment remains for: ${absent}. Those domains are unaudited. The redactor deletes every fragment and the report when it throws; check that step's result as well as the audit transcript.`);
  const unreadable = of((d) => !d.absent && d.stated === null);
  if (unreadable) out.push(`- **A domain's verdict could not be read.** The first line of ${unreadable} is not an exact \`VERDICT: PASS\`, \`VERDICT: FAIL\`, or \`VERDICT: INCONCLUSIVE\`.`);
  const cut = of((d) => !d.absent && !d.finished);
  if (cut) out.push(`- **A domain was cut off mid-report.** ${cut} never wrote its \`${SENTINEL}\` sentinel, so its lines are what it had recorded when it stopped. The findings it did write are still findings.`);
  const doubtful = Object.entries(byFragment).filter(([, d]) => !d.absent && d.verdict === 'INCONCLUSIVE');
  if (doubtful.length) out.push(`- **A domain could not determine every check.** ${doubtful.map(([n]) => n).join(', ')}: ${doubtful.map(([n, d]) => `\`${n}\` — ${d.doubts.join('; ')}`).join('. ')}.`);
  if (fileStatus === 'MISSING') out.push('- **The orchestrator wrote no verdict.** `audit-status.txt` was absent, empty, or not `PASS`/`FAIL`. The domains\' computed verdicts above still stand; an expired wait deadline looks like a domain with no report or one cut off.');
  if (out.length) out.push('');
  return out;
}

// --- CLI -------------------------------------------------------------------

/** One fragment's text, or null when it is absent or empty. */
function readFragment(name) {
  const text = existsSync(name) ? readFileSync(name, 'utf8') : '';
  return text === '' ? null : text;
}

/** Each fragment `$AUDIT_FRAGMENTS` names, read from the working directory. */
export function readFragments() {
  const fragments = {};
  for (const name of (process.env.AUDIT_FRAGMENTS ?? '').split(/\s+/).filter(Boolean)) {
    if (!/^[\w.-]+\.md$/.test(name)) throw new Error(`invalid fragment name: ${JSON.stringify(name)}`);
    fragments[name] = readFragment(name);
  }
  if (Object.keys(fragments).length === 0) throw new Error('AUDIT_FRAGMENTS names no fragment');
  return fragments;
}

function main(argv) {
  const [command, ...rest] = argv.slice(2);
  const args = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) args[rest[i].slice(2)] = rest[++i] ?? '';
    else args._ = rest[i];
  }
  if (command === 'manifest') {
    for (const id of owedIds(fragmentManifest('.', args._))) console.log(`- PASS: ${id} — <clause>: <evidence>`);
    return;
  }
  if (command === 'check') {
    const d = domainVerdict(readFragment(args._), fragmentManifest('.', args._));
    console.log(`${args._}: ${d.verdict}${d.doubts.length ? ` (${d.doubts.join('; ')})` : ''}`);
    for (const a of d.anomalies) console.log(`  anomaly: ${a}`);
    for (const m of d.missing) console.log(`  no result line: ${m}`);
    for (const m of d.malformed) console.log(`  malformed (${m.why}): ${clip(m.line, 200)}`);
    process.exit(d.verdict === 'PASS' ? 0 : 1);
  }
  if (command === 'compose') {
    const commit = process.env.GITHUB_SHA ?? '';
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('GITHUB_SHA is not a commit');
    const date = new Date().toISOString().slice(0, 16) + 'Z';
    const report = compose({ fragments: readFragments(), fileStatus: readFileStatus(), runUrl: args['run-url'],
      transcriptUrl: args['transcript-url'] ?? '', commit, date });
    writeFileSync('audit-private.md', report.privateReport);
    // The ledger, as files the token-holding step reads with shell builtins
    // alone: `audit-ledger/index.tsv` holds `key<TAB>severity`, and row i's
    // title and body are `audit-ledger/<i>.title` and `audit-ledger/<i>.md`.
    rmSync('audit-ledger', { recursive: true, force: true });
    mkdirSync('audit-ledger');
    report.ledger.forEach((e, i) => {
      writeFileSync(`audit-ledger/${i + 1}.title`, e.title.replace(/[\r\n]+/g, ' '));
      writeFileSync(`audit-ledger/${i + 1}.md`, e.body);
    });
    writeFileSync('audit-ledger/index.tsv', report.ledger.map((e) => `${e.key}\t${e.severity}\n`).join(''));
    writeFileSync(args.outputs, `status=${report.status}\ndate=${date}\n`);
    console.log(`Computed ${report.status}; ${report.ledger.length} ledger entr${report.ledger.length === 1 ? 'y' : 'ies'}.`);
    return;
  }
  throw new Error(`usage: security-audit-report.mjs manifest|check|compose …`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
