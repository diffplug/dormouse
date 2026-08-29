#!/usr/bin/env node
/**
 * Clamp a composed issue/comment body to GitHub's maximum length, in place.
 *
 * Why this exists: GitHub rejects a body over 65536 characters with
 * `GraphQL: Body is too long (maximum is 65536 characters)`. In
 * `.github/workflows/security-audit.yaml` that rejection lands on a `set -e`
 * step *after* the verdict is decided, so an audit that trips the limit is
 * reported nowhere at all — not as an issue, not as a comment, only as a red
 * run and a 14-day artifact. Run 33249330988 did exactly that: `VERDICT: FAIL`
 * with a BLOCKER finding, a 68 KB `audit-report.md`, and no issue filed.
 *
 * A too-long body is the *normal* shape of a bad audit, not an edge case: the
 * report grows with the number of findings, so the runs most worth reporting
 * are the ones most likely to be silenced. Clamping is therefore the fix, not
 * a nicety — a truncated report that reaches a human beats a whole one that
 * does not.
 *
 * The head is what survives. Everything the reporting step puts first — the
 * headline, the run and transcript links, the per-condition notes naming which
 * domain dissented — is the part a reader needs to act, and the report body
 * that follows is the part the artifact still holds in full.
 *
 * Usage:
 *   node scripts/clamp-issue-body.mjs <file> [--note "<markdown sentence>"]
 *
 * Rewrites `<file>` only when it is over the limit, so it is safe to run
 * unconditionally and running it twice changes nothing the second time.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * GitHub's documented ceiling, quoted from the rejection message. Counted in
 * UTF-16 code units (JavaScript's `String.length`), which is never *less* than
 * the number of characters GitHub counts, so clamping to it cannot overshoot.
 */
export const GITHUB_BODY_LIMIT = 65536;

/**
 * Headroom below the ceiling. Costs a paragraph of a report nobody can read in
 * full anyway, and covers any disagreement between our count and GitHub's — a
 * body rejected for being 12 characters over is the same total failure as one
 * rejected for being 3000 over.
 */
const SAFETY_MARGIN = 512;

/** Lines that open or close a fenced block; an odd count leaves one open. */
const FENCE = /^\s{0,3}(```+|~~~+)/;

/**
 * Truncate `body` so the result fits in `limit`, keeping the head.
 *
 * Returns the body unchanged when it already fits, so the caller can treat
 * "clamped" as a real event rather than diffing.
 */
export function clampIssueBody(body, { limit = GITHUB_BODY_LIMIT, note = '' } = {}) {
  const budget = limit - SAFETY_MARGIN;
  if (body.length <= budget) return { body, clamped: false, originalLength: body.length };

  // Reserve the footer before cutting: it is appended after the cut, so a
  // footer sized against the *original* body would push the result back over.
  // `originalLength` is known now, so the footer's own length is exact.
  const footer = buildFooter(body.length, note);
  // A fence left open by the cut would swallow the footer into a code block.
  // Reserve for closing one whether or not it turns out to be needed — four
  // characters is not worth a second pass to reclaim.
  const room = budget - footer.length - 4;
  if (room <= 0) {
    // Pathological: the note alone does not fit. Ship the footer rather than
    // an over-long body — the links in it are the part that still works. Cut
    // it to budget too: a footer long enough to reach this branch is itself
    // over the limit, and shipping that is the same total failure as shipping
    // the original.
    return { body: footer.trimStart().slice(0, budget), clamped: true, originalLength: body.length };
  }

  let kept = body.slice(0, room);
  // Never end on a lone high surrogate: half a code point is invalid UTF-8 on
  // the way out and can be rejected or mangled rather than merely truncated.
  if (kept.length > 0 && isHighSurrogate(kept.charCodeAt(kept.length - 1))) {
    kept = kept.slice(0, -1);
  }
  // Prefer a line boundary so the cut does not land mid-sentence, mid-link, or
  // mid-table-row. Only when one is reasonably close: on a body that is one
  // enormous line, a hard cut beats discarding everything.
  const lastNewline = kept.lastIndexOf('\n');
  if (lastNewline > room * 0.8) kept = kept.slice(0, lastNewline);

  const fenceClose = unclosedFence(kept);
  return {
    body: `${kept.replace(/\s+$/, '')}${fenceClose}${footer}`,
    clamped: true,
    originalLength: body.length,
  };
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * The closing fence `kept` needs, or `''`. Counts fence lines rather than
 * tracking nesting: a report is machine-merged from several agents' markdown,
 * so a mismatched ``` / ~~~ pair is likelier than a nested one, and an
 * unnecessary closing fence renders as an empty code block while a missing
 * one hides the footer entirely. The marker is taken from the unmatched
 * opener, since ``` and ~~~ do not close each other.
 */
function unclosedFence(kept) {
  const fences = kept.split('\n').filter((line) => FENCE.test(line));
  if (fences.length % 2 === 0) return '';
  // Close with the same marker the opener used: a backtick fence does not
  // close a tilde-fenced block, so a mismatched closer leaves the footer
  // inside the code block rather than below it. With an odd count the last
  // fence line is the unmatched opener.
  return `\n${FENCE.exec(fences[fences.length - 1])[1]}`;
}

function buildFooter(originalLength, note) {
  const suffix = note ? ` ${note}` : '';
  return `\n\n---\n\n_Truncated here: the full body is ${originalLength} characters, over GitHub's ${GITHUB_BODY_LIMIT}-character limit for an issue or comment.${suffix}_\n`;
}

function main(argv) {
  const args = argv.slice(2);
  let file = '';
  let note = '';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--note') {
      note = args[i + 1] ?? '';
      i += 1;
    } else if (!file) {
      file = args[i];
    }
  }
  if (!file) {
    console.error('usage: clamp-issue-body.mjs <file> [--note "<markdown>"]');
    process.exit(2);
  }

  const original = readFileSync(file, 'utf8');
  const { body, clamped, originalLength } = clampIssueBody(original, { note });
  if (!clamped) {
    console.log(`${file}: ${originalLength} characters, within the ${GITHUB_BODY_LIMIT} limit.`);
    return;
  }
  writeFileSync(file, body);
  console.log(
    `${file}: clamped ${originalLength} -> ${body.length} characters to fit GitHub's ${GITHUB_BODY_LIMIT} limit.`,
  );
}

// Only when run as the CLI, so the self-test can import the pure function.
// `pathToFileURL` rather than string-building a `file://` URL: the latter is
// wrong for any path holding a space or a `#`, and CI checkout paths are not
// ours to promise.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv);
}
