#!/usr/bin/env node
/**
 * Proves `clamp-issue-body.mjs` produces a body GitHub will accept.
 *
 * The regression is run 33249330988: the security audit reached `VERDICT:
 * FAIL`, composed a 68 KB comment, and `gh issue create` rejected it as too
 * long, so the finding reached no issue and no comment.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BODY_LIMIT, MAX_PARTS, clampIssueBody, splitIssueBody } from './clamp-issue-body.mjs';

const failures = [];

function check(name, condition, detail = '') {
  if (condition) return;
  failures.push(detail ? `${name}\n    ${detail}` : name);
}

/** A body shaped like the audit comment that was rejected: head, then bulk. */
function auditShapedBody(totalLength) {
  const head = [
    'Audit failed at 2026-08-29. [Run](https://example.invalid/run) · [Transcript](https://example.invalid/art)',
    '',
    '- **A domain returned `FAIL`.** audit-application.md opened with `VERDICT: FAIL`.',
    '',
  ].join('\n');
  const filler = `${'finding detail line'.padEnd(72, '.')}\n`;
  return head + filler.repeat(Math.ceil((totalLength - head.length) / filler.length));
}

// The regression: a 68 KB audit body comes back postable, head intact.
{
  const body = auditShapedBody(68_424);
  const clamped = clampIssueBody(body, 'The full report is in the run artifact.');
  check('a clamped body fits the limit', clamped.length <= BODY_LIMIT, `got ${clamped.length}`);
  check('the head survives', clamped.startsWith('Audit failed at 2026-08-29.'));
  check('the dissent note survives', clamped.includes('**A domain returned `FAIL`.**'));
  check('the reader is told it was truncated', clamped.includes('Truncated to fit'));
  check('the caller-supplied pointer survives', clamped.includes('The full report is in the run artifact.'));
  check('re-clamping is a no-op', clampIssueBody(clamped, 'n.') === clamped);
}

// A body under the limit is left byte-identical, so the workflow can run this
// unconditionally.
{
  const body = auditShapedBody(1_000);
  check('a short body is untouched', clampIssueBody(body, 'ignored') === body);
}

// A `--note` long enough to blow the budget by itself must still fit.
{
  const clamped = clampIssueBody('x'.repeat(70_000), 'n'.repeat(BODY_LIMIT));
  check('an over-long note still fits', clamped.length <= BODY_LIMIT, `got ${clamped.length}`);
}

// The CLI rewrites the file in place — what the workflows actually call.
{
  const dir = mkdtempSync(join(tmpdir(), 'clamp-issue-body-'));
  try {
    const file = join(dir, 'audit-comment.md');
    writeFileSync(file, auditShapedBody(68_424));
    const cli = fileURLToPath(new URL('./clamp-issue-body.mjs', import.meta.url));
    execFileSync('node', [cli, file, '--note', 'See the artifact.'], { stdio: 'pipe' });
    const written = readFileSync(file, 'utf8');
    check('the CLI rewrites the file under the limit', written.length <= BODY_LIMIT, `got ${written.length}`);
    check('the CLI passes --note through', written.includes('See the artifact.'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The private audit issue splits rather than truncates: the 2026-08-29 and
// 08-30 runs lost a FAIL past the cut. Every part fits, and stripping the part
// headers gives back the body exactly.
{
  const body = auditShapedBody(226_302);
  const parts = splitIssueBody(body, 'See the artifact.');
  check('a long body splits into several parts', parts.length > 1, `got ${parts.length}`);
  check('every part fits the limit', parts.every((p) => p.length <= BODY_LIMIT),
    parts.map((p) => p.length).join(', '));
  check('parts are labelled in order', parts.every((p, i) => p.startsWith(`_Part ${i + 1} of ${parts.length}._\n\n`)));
  const rejoined = parts.map((p) => p.replace(/^_Part \d+ of \d+\._\n\n/, '')).join('');
  check('the split loses nothing', rejoined === body, `rejoined ${rejoined.length} of ${body.length}`);
  check('the head stays in part 1', parts[0].includes('**A domain returned `FAIL`.**'));
  check('a split cuts at line boundaries', parts.slice(0, -1).every((p) => p.endsWith('\n')));
}

// A body that fits is its own single part, byte-identical.
{
  const body = auditShapedBody(1_000);
  const parts = splitIssueBody(body, 'ignored');
  check('a short body is one untouched part', parts.length === 1 && parts[0] === body);
}

// A runaway body stops at MAX_PARTS and says so, every part still postable.
{
  const parts = splitIssueBody('y'.repeat(BODY_LIMIT * (MAX_PARTS + 3)), 'See the artifact.');
  check('a runaway body stops at MAX_PARTS', parts.length === MAX_PARTS, `got ${parts.length}`);
  check('every capped part fits', parts.every((p) => p.length <= BODY_LIMIT));
  check('the last part says where the split stopped',
    parts.at(-1).includes(`Split stopped at ${MAX_PARTS} parts`) && parts.at(-1).includes('See the artifact.'));
}

// `--split` writes numbered part files beside the body, which it leaves alone.
{
  const dir = mkdtempSync(join(tmpdir(), 'clamp-issue-body-'));
  try {
    const file = join(dir, 'audit-private.md');
    const body = auditShapedBody(68_424);
    writeFileSync(file, body);
    const cli = fileURLToPath(new URL('./clamp-issue-body.mjs', import.meta.url));
    execFileSync('node', [cli, file, '--split', '--note', 'See the artifact.'], { stdio: 'pipe' });
    const names = readdirSync(dir).filter((n) => n.startsWith('audit-private-part-')).sort();
    check('the CLI writes zero-padded part files', names.length === 3 && names[0] === 'audit-private-part-01.md', names.join(', '));
    check('the CLI leaves the body itself alone', readFileSync(file, 'utf8') === body);
    check('every written part fits', names.every((n) => readFileSync(join(dir, n), 'utf8').length <= BODY_LIMIT));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(`clamp-issue-body-selftest: ${failures.length} failure(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('clamp-issue-body-selftest: OK');
