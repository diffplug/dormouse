/**
 * The one word count behind the spec budgets (`scripts/spec-lint.mjs`,
 * `scripts/prose-audit.mjs`): whitespace tokens, minus table plumbing. A
 * separator row (`|---|---|`) and the `|` cell delimiters are markup, not
 * prose, so a rule list rendered as a table — the house form — costs the same
 * words as the bullets it replaced.
 */
const SEPARATOR_ROW = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

export function countWords(text) {
  return text
    .split('\n')
    .filter((line) => !SEPARATOR_ROW.test(line))
    .map((line) => line.replace(/\|/g, ' '))
    .join('\n')
    .split(/\s+/)
    .filter(Boolean).length;
}
