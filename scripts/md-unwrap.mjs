#!/usr/bin/env node
/**
 * One source line per markdown paragraph, for every tracked `*.md` and `*.mdx`: a newline
 * in markdown is always a block boundary (paragraph, list item, heading, table
 * row, fence), never a wrap. AGENTS.md -> "Markdown" states the rule. Runs from
 * the repo root via `pnpm test`; exits non-zero with a per-violation report.
 *
 *   node scripts/md-unwrap.mjs [--fix] [file.md | file.mdx ...]
 *
 * Findings:
 *   1. A paragraph spanning more than one source line. `--fix` joins its lines
 *      with one space, which renders identically (a soft break is a space).
 *   2. A hard line break (two trailing spaces or a trailing `\`): a newline
 *      that is not a block boundary. Reported, never fixed.
 *   3. A setext heading (text underlined by `===` / `---`). Reported; use ATX.
 *
 * Parses with the micromark/mdast family the Markdown editor in
 * dor-tools-builtin ships, plus GFM tables (so a table is not a paragraph) and
 * YAML front matter (so it is not a setext heading); `*.mdx` adds MDX's ESM and
 * JSX, whose own lines are never joined. `--fix` edits the source
 * text, never re-serializes, so nothing else in a file moves.
 * Symlinks are skipped (`vscode-ext/CHANGELOG.md` -> `../CHANGELOG.md`).
 */
import { readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { frontmatter } from 'micromark-extension-frontmatter';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { mdxjs } from 'micromark-extension-mdxjs';
import { mdxFromMarkdown } from 'mdast-util-mdx';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The tree every tool here reads: GFM tables and front matter, plus MDX when `mdx`. */
export function parseMarkdown(text, mdx = false) {
  return fromMarkdown(text, {
    extensions: [gfmTable(), frontmatter(), ...(mdx ? [mdxjs()] : [])],
    mdastExtensions: [gfmTableFromMarkdown(), frontmatterFromMarkdown(), ...(mdx ? [mdxFromMarkdown()] : [])],
  });
}

const isMdx = (file) => file.endsWith('.mdx');

const spans = (node) => node.position.end.line > node.position.start.line;

/**
 * Every violation in `text`, in source order. A wrapped paragraph carries its
 * line range and blockquote depth so `unwrap` can join it; a paragraph holding
 * a hard break is reported as the break alone and left for a human. `mdx`
 * parses `text` as MDX.
 */
export function findings(text, { mdx = false } = {}) {
  const out = [];
  const walk = (node, quoteDepth) => {
    if (node.type === 'paragraph' && spans(node)) {
      const breakNode = node.children.find((child) => child.type === 'break');
      if (breakNode) {
        out.push({ line: breakNode.position.start.line, message: 'hard line break; split into paragraphs or list items' });
      } else {
        const { start, end } = node.position;
        out.push({ line: start.line, endLine: end.line, quoteDepth, message: `paragraph wrapped across ${end.line - start.line + 1} lines` });
      }
      return;
    }
    if (node.type === 'heading' && spans(node)) {
      out.push({ line: node.position.start.line, message: 'setext heading; use an ATX `#` heading on one line' });
      return;
    }
    const depth = quoteDepth + (node.type === 'blockquote' ? 1 : 0);
    for (const child of node.children ?? []) walk(child, depth);
  };
  walk(parseMarkdown(text, mdx), 0);
  return out;
}

/**
 * `text` with every wrapped paragraph joined onto its first line. The first
 * line keeps its container prefix (indent, `>` markers, list marker); each
 * continuation line loses its indent and up to `quoteDepth` `>` markers (a lazy
 * continuation carries fewer), then joins with one space.
 */
export function unwrap(text, options) {
  const lines = text.split('\n');
  const wrapped = findings(text, options).filter((finding) => finding.endLine);
  for (const { line, endLine, quoteDepth } of wrapped.reverse()) {
    const parts = [lines[line - 1].trimEnd()];
    for (let i = line; i < endLine; i++) {
      let rest = lines[i].trimStart();
      for (let q = 0; q < quoteDepth && rest.startsWith('>'); q++) rest = rest.slice(1).trimStart();
      parts.push(rest.trimEnd());
    }
    lines.splice(line - 1, endLine - line + 1, parts.join(' '));
  }
  return lines.join('\n');
}

function trackedMarkdown() {
  return execFileSync('git', ['ls-files', '-z', '*.md', '*.mdx'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((file) => !lstatSync(new URL(file, pathToFileURL(ROOT))).isSymbolicLink());
}

function main(argv) {
  const fix = argv.includes('--fix');
  const named = argv.filter((arg) => !arg.startsWith('--'));
  const files = named.length ? named : trackedMarkdown();
  let total = 0;
  let fixed = 0;
  for (const file of files) {
    const path = named.length ? file : fileURLToPath(new URL(file, pathToFileURL(ROOT)));
    const before = readFileSync(path, 'utf8');
    const options = { mdx: isMdx(file) };
    const after = fix ? unwrap(before, options) : before;
    if (after !== before) {
      writeFileSync(path, after);
      fixed++;
    }
    for (const finding of findings(after, options)) {
      console.error(`${file}:${finding.line}: ${finding.message}`);
      total++;
    }
  }
  if (fix && fixed) console.error(`md-unwrap: rewrote ${fixed} file(s)`);
  if (total) {
    console.error(`md-unwrap: ${total} violation(s).${fix ? '' : ' Run `node scripts/md-unwrap.mjs --fix` to join wrapped paragraphs.'}`);
    process.exit(1);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
