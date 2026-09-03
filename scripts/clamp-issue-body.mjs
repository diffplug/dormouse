#!/usr/bin/env node
/**
 * Truncate an issue/comment body in place so GitHub cannot reject it as too
 * long. See docs/specs/security-audit.md -> "Outcomes and reporting" for why a rejection loses
 * the whole finding.
 *
 * Usage: node scripts/clamp-issue-body.mjs <file> [--note "<markdown>"]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Well under GitHub's 65536-character ceiling, and past what anyone reads. */
export const BODY_LIMIT = 32_000;

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

function main(argv) {
  const args = argv.slice(2);
  const noteAt = args.indexOf('--note');
  const note = noteAt === -1 ? '' : (args.splice(noteAt, 2)[1] ?? '');
  const file = args[0];
  if (!file) {
    console.error('usage: clamp-issue-body.mjs <file> [--note "<markdown>"]');
    process.exit(2);
  }

  const original = readFileSync(file, 'utf8');
  const clamped = clampIssueBody(original, note);
  if (clamped === original) {
    console.log(`${file}: ${original.length} characters, within ${BODY_LIMIT}.`);
    return;
  }
  writeFileSync(file, clamped);
  console.log(`${file}: truncated ${original.length} -> ${clamped.length} characters.`);
}

// Only when run as the CLI, so the self-test can import the pure function.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
