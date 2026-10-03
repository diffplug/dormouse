#!/usr/bin/env node
/**
 * One-shot: spec front-matter blockquotes -> one `> - ` bullet per entry.
 * Dry-run prints each spec's entries and any line it joined that started like a
 * new entry (`??`); review those, then rerun with --write. Run from the repo
 * root, before `node scripts/md-unwrap.mjs --fix` (it splits entries on the
 * wrapped source lines).
 *
 * Regenerating the reflow on a fresh main:
 *   1. node scripts/oneshot/front-matter-bullets.mjs            # review
 *   2. node scripts/oneshot/front-matter-bullets.mjs --write
 *      node scripts/spec-lint.mjs   # ratchet any spec the `-` markers push over
 *   3. node scripts/md-unwrap.mjs --fix
 *      node scripts/oneshot/md-equivalence.mjs                 # vs the commit before 3
 *      git diff --word-diff=porcelain | grep -E '^[-+][^-+]'   # expect only `>`
 *   4. add the step-3 commit SHA to .git-blame-ignore-revs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const write = process.argv.includes('--write');
const files = [
  ...readdirSync('docs/specs').filter((f) => f.endsWith('.md')).map((f) => `docs/specs/${f}`),
  'SELF_HOST.md', 'SELF_HOST.rationale.md', 'docs/compatible-agents.md', 'docs/compatible-agents.rationale.md',
];
const isBullet = /^\s*[-*] /;
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const h1 = lines.findIndex((l) => /^# /.test(l));
  let i = h1 + 1;
  while (lines[i]?.trim() === '') i++;
  if (!lines[i]?.startsWith('>')) { console.log(`-- ${file}: no front matter`); continue; }
  const start = i;
  // Paragraphs of the leading blockquote run; a non-blank line after a `>` line is a lazy continuation.
  const paras = [[]];
  let end = i;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' || /^>\s*$/.test(l)) {
      let k = i; while (k < lines.length && (lines[k].trim() === '' || /^>\s*$/.test(lines[k]))) k++;
      if (!lines[k]?.startsWith('>')) break;
      if (paras.at(-1).length) paras.push([]);
      i = k - 1; continue;
    }
    if (!l.startsWith('>') && paras.at(-1).length === 0) break;
    paras.at(-1).push(l.replace(/^>\s?/, '').trimEnd());
    end = i;
  }
  const entries = [];
  const suspicious = [];
  for (const para of paras.filter((p) => p.length)) {
    if (para.some((l) => isBullet.test(l))) { console.log(`!! ${file}: already has bullets`); }
    let cur = para[0];
    for (let k = 1; k < para.length; k++) {
      const prev = para[k - 1], next = para[k].trim();
      const startsEntry = /^(\*\*|[A-Z])/.test(next);
      if (/\.(\)|\*\*|\*)?$/.test(prev) && startsEntry) { entries.push(cur); cur = next; }
      else { if (startsEntry) suspicious.push(`${prev.slice(-30)} | ${next.slice(0, 30)}`); cur += ' ' + next; }
    }
    entries.push(cur);
  }
  const split = entries.flatMap((e) => e.split(/(?<=\.) (?=(?:\*\*)?(?:Owns|Defers)\b)/));
  const before = entries.length; entries.length = 0; entries.push(...split);
  if (entries.length !== before) console.log(`   ++ mid-line split ${before} -> ${entries.length}`);
  const out = entries.length === 1 ? [`> ${entries[0]}`] : entries.map((e) => `> - ${e}`);
  console.log(`== ${file} (${entries.length})`);
  for (const e of entries) console.log(`   • ${e.slice(0, 90)}`);
  for (const s of suspicious) console.log(`   ?? joined: ${s}`);
  if (write) {
    lines.splice(start, end - start + 1, ...out);
    writeFileSync(file, lines.join('\n'));
  }
}
