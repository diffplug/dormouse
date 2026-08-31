#!/usr/bin/env node
/** Advisory inventory for the spec + referenced-code prose review in docs/prose-audit.md. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const json = args.includes('--json');
const all = args.includes('--all');
const changedArg = args.find((arg) => arg === '--changed' || arg.startsWith('--changed='));
const unknown = args.filter((arg) => !['--all', '--json', '--help', '--changed'].includes(arg) && !arg.startsWith('--changed='));

if (args.includes('--help')) {
  console.log(`Usage: pnpm audit:prose [--changed[=<base>]] [--all] [--json]

Without --changed, audits every spec and the code files it references.
--changed audits specs or references changed from <base> (default: origin/main),
including staged, unstaged, and untracked files. --all expands the concise report.
Findings are advisory.`);
  process.exit(0);
}
if (unknown.length > 0) {
  console.error(`prose-audit: unknown argument(s): ${unknown.join(', ')}`);
  process.exit(2);
}

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' });
const tracked = git('ls-files').trim().split('\n').filter(Boolean);
const trackedSet = new Set(tracked);
const basenameIndex = new Map();
for (const rel of tracked) {
  const name = basename(rel);
  const paths = basenameIndex.get(name) ?? [];
  paths.push(rel);
  basenameIndex.set(name, paths);
}

const specFiles = readdirSync(join(ROOT, 'docs/specs'))
  .filter((name) => name.endsWith('.md') && !name.endsWith('.rationale.md'))
  .map((name) => `docs/specs/${name}`)
  .sort();
specFiles.push('SELF_HOST.md');
const budgets = JSON.parse(read('scripts/spec-word-budgets.json'));
const codeExtensions = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.jsx', '.mjs', '.ps1', '.rs',
  '.sh', '.toml', '.ts', '.tsx', '.yaml', '.yml',
]);
const extension = (rel) => /\.[^.\/]+$/.exec(rel)?.[0] ?? '';
const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;
const lineOf = (text, offset) => text.slice(0, offset).split('\n').length;

function resolveReference(token, spec) {
  const clean = token.split('#')[0].replace(/^\.\//, '').replace(/[,:;.)]+$/, '').replaceAll('\\', '/');
  if (!clean || /[*{}<>$%?\\]|\.\.\.|…/.test(clean)) return [];
  const repoPath = normalize(clean).replaceAll('\\', '/');
  if (trackedSet.has(repoPath)) return [repoPath];
  const relative = normalize(join(dirname(spec), clean)).replaceAll('\\', '/');
  if (trackedSet.has(relative)) return [relative];
  if (!clean.includes('/')) {
    const matches = basenameIndex.get(clean) ?? [];
    if (matches.length === 1) return matches;
  }
  return [];
}

function referencesOf(spec, text) {
  const refs = new Set();
  const unresolved = new Set();
  const tokens = [];
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (!/^(?:https?:|mailto:|#)/.test(match[1])) tokens.push(match[1]);
  }
  for (const match of text.matchAll(/`([^`\n]+)`/g)) tokens.push(match[1]);
  for (const token of tokens) {
    let resolved = resolveReference(token, spec);
    if (resolved.length === 0 && /\s/.test(token)) {
      resolved = token.split(/\s+/).flatMap((part) => resolveReference(part, spec));
    }
    for (const rel of resolved) refs.add(rel);
    const ext = extension(token.split('#')[0]);
    if (resolved.length === 0 && !/:\/\//.test(token) && codeExtensions.has(ext)) unresolved.add(token);
  }
  refs.delete(spec);
  return { refs: [...refs].sort(), unresolved: [...unresolved].sort() };
}

function proseOnly(text) {
  let inFence = false;
  return text.split('\n').map((line) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return ''; }
    return inFence ? '' : line;
  }).join('\n');
}

function proseCandidates(text) {
  const prose = proseOnly(text);
  const candidates = [];
  let offset = 0;
  for (const block of prose.split(/\n\s*\n/)) {
    const start = prose.indexOf(block, offset);
    offset = start + block.length;
    const words = wordCount(block);
    const lines = block.split('\n').filter(Boolean);
    const isTable = lines.length > 1 && lines.filter((line) => /^\s*\|/.test(line)).length / lines.length > 0.5;
    const isList = lines.length > 1 && lines.every((line) => /^\s*(?:[-*]|\d+\.)\s/.test(line));
    if (words >= 100 && !isTable && !isList) {
      candidates.push({ kind: 'LONG', line: lineOf(prose, start), words, detail: 'long prose block' });
    }
    if (words >= 70 && /\b(?:because|histor(?:y|ical)|measur(?:e|ed|ement)|workaround|replaced|regression|experiment|Safari|Chrome)\b/i.test(block)) {
      candidates.push({ kind: 'RATIONALE', line: lineOf(prose, start), words, detail: 'evidence/history cue' });
    }
  }
  const beforeFuture = text.split(/^##(?:\s+\d+\.)?\s+Future\s*$/m)[0];
  for (const match of beforeFuture.matchAll(/```(?:ts|tsx|typescript)\s*\n([\s\S]*?)```/g)) {
    if (/\b(?:interface|type|enum)\b/.test(match[1])) {
      candidates.push({ kind: 'CANONICAL', line: lineOf(text, match.index), words: wordCount(match[1]), detail: 'current TypeScript shape' });
    }
  }
  text.split('\n').forEach((line, index) => {
    const tests = line.match(/[\w./-]+\.test\.[cm]?[jt]sx?/g) ?? [];
    if (tests.length >= 2) candidates.push({ kind: 'CUT', line: index + 1, words: wordCount(line), detail: `${tests.length}-file test inventory` });
    if (/^Source of truth:/.test(line) && line.length >= 220) {
      candidates.push({ kind: 'POINTER', line: index + 1, words: wordCount(line), detail: `${line.length}-character source pointer` });
    }
  });
  const lines = prose.split('\n');
  for (let start = 0; start < lines.length;) {
    if (!/^\s*[-*]\s/.test(lines[start])) { start += 1; continue; }
    let end = start;
    let words = 0;
    while (end < lines.length && /^\s*[-*]\s/.test(lines[end])) { words += wordCount(lines[end]); end += 1; }
    if (end - start >= 6 && words >= 150) {
      candidates.push({ kind: 'MATRIX', line: start + 1, words, detail: `${end - start}-item parallel list` });
    }
    start = end;
  }
  return candidates.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
}

function commentBlocks(rel, text) {
  const lines = text.split('\n');
  const blocks = [];
  let current = null;
  let inBlock = false;
  const flush = () => {
    if (current) blocks.push({ ...current, text: current.parts.join(' ') });
    current = null;
  };
  const add = (line, value) => {
    if (!current) current = { line, parts: [] };
    current.parts.push(value.replace(/^\s*(?:\/[/!*]+|\*+|#|<!--|-->)[ ]?/, '').trim());
  };
  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (inBlock) {
      add(index + 1, trimmed);
      if (trimmed.includes('*/') || trimmed.includes('-->')) { inBlock = false; flush(); }
      return;
    }
    if (/^(?:\/\*|\{?\/\*|<!--)/.test(trimmed)) {
      flush(); add(index + 1, trimmed);
      if (!trimmed.includes('*/') && !trimmed.includes('-->')) inBlock = true;
      else flush();
      return;
    }
    const shellLike = /\.(?:sh|ps1|ya?ml)$/.test(rel);
    if (/^\/\//.test(trimmed) || (shellLike && /^#(?!\!)/.test(trimmed))) {
      add(index + 1, trimmed);
      return;
    }
    flush();
  });
  flush();
  return blocks.map((block) => ({ ...block, words: wordCount(block.text) })).filter((block) => block.words > 0);
}

const terms = (text) => text.toLowerCase().match(/[a-z0-9][a-z0-9_-]+/g) ?? [];
function shingles(text, size = 7) {
  const words = terms(text);
  const out = new Set();
  for (let index = 0; index <= words.length - size; index += 1) out.add(words.slice(index, index + size).join(' '));
  return out;
}

function codeCandidates(specText, refs) {
  const specShingles = shingles(proseOnly(specText));
  const files = [];
  for (const rel of refs.filter((path) => codeExtensions.has(extension(path)) && existsSync(join(ROOT, path)))) {
    const text = read(rel);
    const blocks = commentBlocks(rel, text);
    const totalWords = wordCount(text);
    const commentWords = blocks.reduce((sum, block) => sum + block.words, 0);
    const findings = [];
    for (const block of blocks) {
      const blockShingles = shingles(block.text);
      const overlap = blockShingles.size === 0 ? 0 : [...blockShingles].filter((item) => specShingles.has(item)).length / blockShingles.size;
      if (block.words >= 80) findings.push({ kind: 'LONG', line: block.line, words: block.words, detail: 'long comment block' });
      if (block.words >= 35 && overlap >= 0.35) findings.push({ kind: 'POINTER', line: block.line, words: block.words, detail: `${Math.round(overlap * 100)}% spec overlap` });
    }
    const density = totalWords === 0 ? 0 : commentWords / totalWords;
    if (commentWords >= 120 && density >= 0.18) findings.push({ kind: 'CUT', line: 1, words: commentWords, detail: `${Math.round(density * 100)}% comment density` });
    if (findings.length > 0) files.push({ path: rel, findings });
  }
  return files;
}

function changedFiles(base) {
  const files = new Set();
  const add = (output) => output.split('\n').filter(Boolean).forEach((file) => files.add(file));
  try { add(git('diff', '--name-only', `${base}...HEAD`)); }
  catch { console.error(`prose-audit: cannot compare with ${base}`); process.exit(2); }
  add(git('diff', '--name-only'));
  add(git('diff', '--name-only', '--cached'));
  add(git('ls-files', '--others', '--exclude-standard'));
  return files;
}

let reports = specFiles.map((spec) => {
  const text = read(spec);
  const rationale = spec === 'SELF_HOST.md' ? null : spec.replace(/\.md$/, '.rationale.md');
  const { refs, unresolved } = referencesOf(spec, text);
  const prose = proseCandidates(text);
  const code = codeCandidates(text, refs);
  return {
    spec,
    words: wordCount(text),
    budget: budgets[spec],
    rationale: rationale && existsSync(join(ROOT, rationale)) ? { path: rationale, words: wordCount(read(rationale)) } : null,
    references: refs,
    unresolved,
    prose,
    code,
    score: prose.length + code.reduce((sum, file) => sum + file.findings.length, 0),
  };
});

if (changedArg) {
  const base = changedArg.includes('=') ? changedArg.slice(changedArg.indexOf('=') + 1) : 'origin/main';
  const changed = changedFiles(base);
  reports = reports.filter((report) => changed.has(report.spec) || changed.has(report.rationale?.path) || report.references.some((ref) => changed.has(ref)));
}

if (json) {
  console.log(JSON.stringify({ specs: reports }, null, 2));
  process.exit(0);
}

console.log(`prose-audit: ${reports.length} spec(s); advisory candidates only\n`);
for (const report of reports) {
  const budget = report.budget === undefined ? '?' : report.budget;
  const rationale = report.rationale ? `; rationale ${report.rationale.words}w` : '';
  console.log(`${report.spec} — ${report.words}/${budget}w; ${report.references.length} refs${rationale}; ${report.score} hit(s)`);
  const hits = report.prose.map((hit) => ({ ...hit, path: report.spec }));
  for (const file of report.code) {
    for (const hit of file.findings) hits.push({ ...hit, path: file.path });
  }
  const priority = (hit) => {
    if (hit.detail.includes('spec overlap')) return 0;
    if (hit.kind === 'CANONICAL') return 1;
    if (hit.detail.includes('test inventory') || hit.kind === 'POINTER') return 2;
    if (hit.kind === 'RATIONALE') return 3;
    if (hit.kind === 'MATRIX') return 4;
    if (hit.kind === 'LONG') return 5;
    return 6; // aggregate comment-density hints follow specific locations
  };
  hits.sort((a, b) => priority(a) - priority(b) || b.words - a.words || a.path.localeCompare(b.path) || a.line - b.line);
  const visible = all ? hits : hits.slice(0, 12);
  for (const hit of visible) console.log(`  ${hit.kind.padEnd(9)} ${hit.path}:${hit.line} (${hit.words}w) ${hit.detail}`);
  if (!all && hits.length > visible.length) console.log(`  … ${hits.length - visible.length} more; rerun with --all or --json`);
  if (report.unresolved.length > 0) console.log(`  REVIEW    unresolved file-like refs: ${report.unresolved.join(', ')}`);
}
console.log('\nDisposition each hit as KEEP, CUT, POINTER, RATIONALE, MATRIX, or CANONICAL; see docs/prose-audit.md.');
