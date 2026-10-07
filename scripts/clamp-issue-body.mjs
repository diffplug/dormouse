#!/usr/bin/env node
/**
 * Make an issue/comment body postable: truncate it in place, or split it into
 * parts an issue and its comments can carry. See docs/specs/security-audit.md
 * -> "Outcomes and reporting" for why a rejection loses the whole finding.
 *
 * Usage: node scripts/clamp-issue-body.mjs <file> [--note "<markdown>"]
 *        node scripts/clamp-issue-body.mjs <file> --split [--note "<markdown>"]
 *
 * `--split` leaves <file> alone and writes <stem>-part-01.md, -part-02.md, …
 * beside it, numbered so a shell glob lists them in order.
 */

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Well under GitHub's 65536-character ceiling, and past what anyone reads. */
export const BODY_LIMIT = 32_000;

/** The most parts a split files: one issue and its comments, bounded so a runaway report cannot flood the tracker. */
export const MAX_PARTS = 20;

/** Truncate `body` to `BODY_LIMIT`, keeping the head. Unchanged if it fits. */
export function clampIssueBody(body, note = '') {
  if (body.length <= BODY_LIMIT) return body;
  const footer = `\n\n---\n\n_Truncated to fit: the full body is ${body.length} characters.${note ? ` ${note}` : ''}_\n`;
  let kept = body.slice(0, Math.max(0, BODY_LIMIT - footer.length));
  // Cut at a line boundary, unless that would throw away most of what we kept.
  const lastNewline = kept.lastIndexOf('\n');
  if (lastNewline > kept.length * 0.8) kept = kept.slice(0, lastNewline);
  // Final slice covers a `--note` long enough to blow the budget by itself.
  return `${kept.trimEnd()}${footer}`.slice(0, BODY_LIMIT);
}

/**
 * Split `body` into parts that each fit `BODY_LIMIT`, losing nothing up to
 * `MAX_PARTS`. A body that fits comes back as its only part, unchanged. Each
 * part of a split body opens with `_Part i of n._`; past `MAX_PARTS` the last
 * part ends by saying where the split stopped.
 */
export function splitIssueBody(body, note = '') {
  if (body.length <= BODY_LIMIT) return [body];
  // Room for the `_Part i of n._` header, whose width depends on n.
  const budget = BODY_LIMIT - 40;
  const chunks = [];
  for (let at = 0; at < body.length;) {
    let end = Math.min(body.length, at + budget);
    if (end < body.length) {
      // Cut after a newline, unless that would throw away most of the chunk.
      const lastNewline = body.lastIndexOf('\n', end - 1);
      if (lastNewline >= at + budget * 0.5) end = lastNewline + 1;
    }
    chunks.push(body.slice(at, end));
    at = end;
  }
  if (chunks.length > MAX_PARTS) {
    chunks.length = MAX_PARTS;
    const footer = `\n\n---\n\n_Split stopped at ${MAX_PARTS} parts: the full body is ${body.length} characters.${note ? ` ${note}` : ''}_\n`;
    const last = chunks[MAX_PARTS - 1];
    chunks[MAX_PARTS - 1] = `${last.slice(0, Math.max(0, budget - footer.length)).trimEnd()}${footer}`.slice(0, budget);
  }
  return chunks.map((chunk, i) => `_Part ${i + 1} of ${chunks.length}._\n\n${chunk}`);
}

function main(argv) {
  const args = argv.slice(2);
  const noteAt = args.indexOf('--note');
  const note = noteAt === -1 ? '' : (args.splice(noteAt, 2)[1] ?? '');
  const splitAt = args.indexOf('--split');
  const split = splitAt !== -1;
  if (split) args.splice(splitAt, 1);
  const file = args[0];
  if (!file) {
    console.error('usage: clamp-issue-body.mjs <file> [--split] [--note "<markdown>"]');
    process.exit(2);
  }

  const original = readFileSync(file, 'utf8');
  if (split) {
    const stem = file.replace(/\.md$/, '');
    const parts = splitIssueBody(original, note);
    parts.forEach((part, i) => writeFileSync(`${stem}-part-${String(i + 1).padStart(2, '0')}.md`, part));
    console.log(`${file}: ${original.length} characters in ${parts.length} part(s).`);
    return;
  }
  const clamped = clampIssueBody(original, note);
  if (clamped === original) {
    console.log(`${file}: ${original.length} characters, within ${BODY_LIMIT}.`);
    return;
  }
  writeFileSync(file, clamped);
  console.log(`${file}: truncated ${original.length} -> ${clamped.length} characters.`);
}

// Only when run as the CLI, so the self-test can import the pure function.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
