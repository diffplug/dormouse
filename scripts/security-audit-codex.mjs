#!/usr/bin/env node
/**
 * The second-opinion audit's sessions (docs/specs/security-audit.md ->
 * "Second-opinion audit"). Codex has no subagents, so
 * `scripts/security-audit-local.sh --engine codex` runs a domain the way a
 * delegating domain would: it opens the fragment, runs each of the domain's
 * `## Work streams` as its own Codex session appending to it, and closes it
 * with the verdict its lines compute.
 *
 *   node scripts/security-audit-codex.mjs streams <domain>
 *     The domain's work streams, one name per line, in the order it lists them.
 *   node scripts/security-audit-codex.mjs prompt <domain> <stream>
 *     That stream's prompt: a header naming the stream, the preamble without
 *     its delegation sections, and the domain file without its stream list
 *     (and, for a rule stream, without its qualitative pass).
 *   node scripts/security-audit-codex.mjs open <fragment>
 *     Writes the fragment's opening `VERDICT: INCONCLUSIVE` line.
 *   node scripts/security-audit-codex.mjs settle <fragment> <before> <stream>
 *     After a session: exit 0 if it only appended to the fragment, which held
 *     <before> when it started. A rewritten first line is put back; any other
 *     rewrite restores <before>, dropping that session's lines, and exits 1.
 *   node scripts/security-audit-codex.mjs close <fragment>
 *     Rewrites the first line to the verdict the lines compute and appends the
 *     sentinel.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeFragment, SENTINEL } from './security-audit-report.mjs';
import { AUDIT_DIR, proseLines } from './spec-md.mjs';

/** The preamble's sections a Codex session never sees: it has no subagents to delegate to or wait for. */
export const DELEGATION_SECTIONS = ['Work streams', 'Waiting for delegates'];
const QUALITATIVE = 'qualitative';

/**
 * A markdown text cut at its headings of exactly `level` (`#` count), fenced
 * code aside: the text before the first one, then each heading with its body.
 */
function sections(text, level) {
  const lines = text.split('\n');
  const prose = proseLines(text);
  const marker = new RegExp(`^${'#'.repeat(level)} (.+)$`);
  const out = [{ heading: null, lines: [] }];
  lines.forEach((line, i) => {
    const m = prose[i].match(marker);
    if (m) out.push({ heading: m[1].trim(), lines: [] });
    out.at(-1).lines.push(line);
  });
  return out.map(({ heading, lines: l }) => ({ heading, text: l.join('\n') }));
}

const joinSections = (parts) => parts.map((p) => p.text.replace(/\n+$/, '')).join('\n\n') + '\n';

/**
 * `_preamble.md` without {@link DELEGATION_SECTIONS}. Throws when either is
 * gone or the rest still says to delegate, so a preamble edit cannot hand
 * Codex the wait loop again, or drop a section along with them, unnoticed.
 */
export function codexPreamble(root = '.') {
  const parts = sections(readFileSync(join(root, AUDIT_DIR, '_preamble.md'), 'utf8'), 3);
  for (const heading of DELEGATION_SECTIONS) {
    if (parts.filter((p) => p.heading === heading).length !== 1) throw new Error(`_preamble.md has no one \`### ${heading}\` section`);
  }
  const kept = parts.filter((p) => !DELEGATION_SECTIONS.includes(p.heading));
  const left = kept.find((p) => /delegat/i.test(p.text));
  if (left) throw new Error(`_preamble.md still says to delegate outside ${DELEGATION_SECTIONS.join(' and ')}: ${left.heading ?? 'its opening'}`);
  return joinSections(kept);
}

/** A domain file's `## ` sections, its fragment, and its work streams as `{ name, holds }`. */
function readDomain(root, domain) {
  const path = join(root, AUDIT_DIR, `${domain}.md`);
  if (!/^[\w-]+$/.test(domain) || !existsSync(path)) throw new Error(`no domain prompt ${domain}`);
  const text = readFileSync(path, 'utf8');
  const parts = sections(text, 2);
  const list = parts.filter((p) => p.heading === 'Work streams');
  if (list.length !== 1) throw new Error(`${domain}.md has no one \`## Work streams\` section`);
  const streams = [...list[0].text.matchAll(/^- `([\w-]+)` — (\S.*)$/gm)].map((m) => ({ name: m[1], holds: m[2] }));
  // What a stream holds, which the list's own lead-in says: every rule under its headings, subheadings or not.
  const scope = list[0].text.match(/Each holds (every rule under the headings it names[^:\n]*):/)?.[1];
  if (!scope) throw new Error(`${domain}.md does not say what its work streams hold`);
  if (streams.filter((s) => s.name === QUALITATIVE).length !== 1) throw new Error(`${domain}.md lists no one \`${QUALITATIVE}\` stream`);
  if (new Set(streams.map((s) => s.name)).size !== streams.length) throw new Error(`${domain}.md lists a stream twice`);
  const fragment = text.match(/^\*\*Output file:\*\* `([\w.-]+\.md)`/m)?.[1];
  if (!fragment) throw new Error(`${domain}.md names no output file`);
  return { parts, streams, scope, fragment };
}

/** The domain's work stream names, in the order its file lists them. */
export const streams = (root, domain) => readDomain(root, domain).streams.map((s) => s.name);

/** One stream's whole prompt. */
export function streamPrompt(root, domain, stream) {
  const { parts, streams: all, scope, fragment } = readDomain(root, domain);
  const s = all.find((x) => x.name === stream);
  if (!s) throw new Error(`${domain}.md lists no \`${stream}\` stream`);
  const qualitative = stream === QUALITATIVE;
  const own = qualitative
    ? 'Run the qualitative pass below and write its one `QUALITATIVE` line; re-verify there the open findings that cite no rule. Record no result line: the other streams own the rules.'
    : 'Record a result line for every rule under those headings and no other, and re-verify the open findings that cite them. A check this session has not yet traced is not one it ran out of room for: trace it, and end the turn only when every rule has its result line. Run no qualitative pass and write no `QUALITATIVE` line: the `qualitative` stream owns it.';
  const header = [
    `# Work stream \`${stream}\` of the \`${domain}\` domain`,
    `This session runs one work stream of the domain below and nothing else. ${qualitative ? `It is ${s.holds}` : `It holds ${scope}: ${s.holds}`} ${own}`,
    `Each of the domain's work streams runs as its own session, one at a time, into the same fragment. The script that runs them opened \`${fragment}\` and closes it, so this session never creates, truncates, or rewrites it: skip the \`printf 'VERDICT: INCONCLUSIVE\\n\\n' >\` that opens it, append each line with its own \`printf … >>\`, a finding's evidence lines in the same call, and write no verdict line and no sentinel. The script writes the verdict the lines compute once every stream has run. When the stream is done, end your turn with one line saying so.`,
  ].join('\n\n');
  const domainParts = parts.filter((p) => p.heading !== 'Work streams' && (qualitative || p.heading !== 'Qualitative pass'));
  return `${header}\n\n${codexPreamble(root)}\n${joinSections(domainParts)}`;
}

const firstLineEnd = (text) => (text.includes('\n') ? text.indexOf('\n') : text.length);

/** Whether a session left the fragment as it found it plus what it appended; puts back a rewritten first line. */
export function settle(fragment, before) {
  const now = existsSync(fragment) ? readFileSync(fragment, 'utf8') : '';
  if (now.startsWith(before)) return true;
  const rest = (t) => t.slice(firstLineEnd(t));
  if (now.includes('\n') && rest(now).startsWith(rest(before))) {
    writeFileSync(fragment, before.slice(0, firstLineEnd(before)) + rest(now));
    return true;
  }
  writeFileSync(fragment, before);
  return false;
}

/** The fragment closed: its first line the verdict its lines compute, stray sentinels dropped, one at the end. */
export function closeFragment(root, fragment, text) {
  const body = text.split('\n').slice(1).filter((l) => l.trim() !== SENTINEL).join('\n').replace(/\n+$/, '');
  const closed = (verdict) => `VERDICT: ${verdict}\n${body}\n\n${SENTINEL}\n`;
  // Stated as PASS, the lines' own verdict decides.
  return closed(judgeFragment(root, fragment, closed('PASS')).verdict);
}

function main([command, ...args]) {
  if (command === 'streams') return void console.log(streams('.', args[0]).join('\n'));
  if (command === 'prompt') return void process.stdout.write(streamPrompt('.', args[0], args[1]));
  if (command === 'open') return void writeFileSync(args[0], 'VERDICT: INCONCLUSIVE\n\n');
  if (command === 'settle') {
    if (settle(args[0], readFileSync(args[1], 'utf8'))) return;
    console.error(`==> the ${args[2]} session rewrote ${args[0]} instead of appending to it; its lines are dropped`);
    process.exit(1);
  }
  if (command === 'close') return void writeFileSync(args[0], closeFragment('.', args[0], readFileSync(args[0], 'utf8')));
  throw new Error('usage: security-audit-codex.mjs streams|prompt|open|settle|close …');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
