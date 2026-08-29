#!/usr/bin/env node
/**
 * Proves `clamp-issue-body.mjs` actually produces a body GitHub will accept.
 *
 * The regression this locks down is run 33249330988: the security audit
 * reached `VERDICT: FAIL`, composed a 68 KB comment, and `gh issue create`
 * rejected it with `GraphQL: Body is too long (maximum is 65536 characters)`.
 * The step died on `set -e`, so the finding reached no issue and no comment.
 * The first case below reproduces that body shape and asserts the clamp
 * returns something under the limit — it fails against an unclamped body,
 * which is the whole point.
 *
 * Everything else here guards a way the clamp could be *technically* under the
 * limit and still useless: dropping the head (which carries the verdict and
 * the links), emitting half a code point, or leaving a fence open so the
 * truncation note renders inside a code block instead of as prose.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GITHUB_BODY_LIMIT, clampIssueBody } from './clamp-issue-body.mjs';

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
    '## Report',
    '',
  ].join('\n');
  const filler = `${'finding detail line that is long enough to be representative'.padEnd(72, '.')}\n`;
  return head + filler.repeat(Math.ceil((totalLength - head.length) / filler.length));
}

// 1. The actual regression: a 68 KB audit body must come back postable.
{
  const body = auditShapedBody(68_424);
  check('the unclamped fixture is over the limit', body.length > GITHUB_BODY_LIMIT, `got ${body.length}`);

  const { body: clamped, clamped: didClamp, originalLength } = clampIssueBody(body, {
    note: 'The full report is in the run artifact.',
  });
  check('an over-long body is reported as clamped', didClamp);
  check('originalLength reports the input length', originalLength === body.length);
  check(
    'a clamped body fits GitHub\'s limit',
    clamped.length <= GITHUB_BODY_LIMIT,
    `got ${clamped.length}, limit ${GITHUB_BODY_LIMIT}`,
  );
  check('the head survives', clamped.startsWith('Audit failed at 2026-08-29.'));
  check('the dissent note survives', clamped.includes('**A domain returned `FAIL`.**'));
  check('the reader is told it was truncated', clamped.includes('Truncated here'));
  check('the caller-supplied pointer survives', clamped.includes('The full report is in the run artifact.'));
}

// 2. A body already under the limit is left exactly alone, so the workflow can
//    run this unconditionally and a normal-sized report is unaffected.
{
  const body = auditShapedBody(1_000);
  const result = clampIssueBody(body, { note: 'ignored' });
  check('a short body is not reported as clamped', result.clamped === false);
  check('a short body is returned byte-identical', result.body === body);
}

// 3. Clamping is idempotent: a second pass over an already-clamped body must
//    not re-truncate or stack a second footer.
{
  const once = clampIssueBody(auditShapedBody(68_424), { note: 'n.' }).body;
  const twice = clampIssueBody(once, { note: 'n.' });
  check('re-clamping an already-clamped body is a no-op', twice.clamped === false && twice.body === once);
}

// 4. No lone surrogate at the cut. An emoji-dense body puts a surrogate pair
//    astride every candidate offset; half of one is invalid UTF-8 on the way
//    out, which is a different rejection from the one we are fixing.
{
  const body = 'head\n' + '🔒'.repeat(60_000);
  const { body: clamped } = clampIssueBody(body, { note: 'n.' });
  check(
    'a clamped body is valid UTF-8 (no lone surrogate)',
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(clamped),
  );
  check('the emoji body still fits', clamped.length <= GITHUB_BODY_LIMIT);
}

// 5. A fence left open by the cut is closed, so the truncation note renders as
//    prose rather than disappearing into a code block.
{
  const body = `head\n\n\`\`\`\n${'code line in a fence\n'.repeat(6_000)}`;
  const { body: clamped } = clampIssueBody(body, { note: 'n.' });
  const fences = clamped.split('\n').filter((line) => /^\s{0,3}(```+|~~~+)/.test(line)).length;
  check('an open fence is closed before the footer', fences % 2 === 0, `counted ${fences} fence lines`);
  check(
    'the footer is outside the fence',
    clamped.lastIndexOf('```') < clamped.indexOf('Truncated here'),
  );
}

// 6. The CLI rewrites the file in place — what the workflow actually calls.
{
  const dir = mkdtempSync(join(tmpdir(), 'clamp-issue-body-'));
  try {
    const file = join(dir, 'audit-comment.md');
    writeFileSync(file, auditShapedBody(68_424));
    const cli = fileURLToPath(new URL('./clamp-issue-body.mjs', import.meta.url));
    execFileSync('node', [cli, file, '--note', 'See the artifact.'], { stdio: 'pipe' });
    const written = readFileSync(file, 'utf8');
    check('the CLI rewrites the file under the limit', written.length <= GITHUB_BODY_LIMIT, `got ${written.length}`);
    check('the CLI passes --note through', written.includes('See the artifact.'));
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
