/**
 * The spec-markdown kit `scripts/spec-lint.mjs` and `scripts/prose-audit.mjs`
 * share: one word count, one fence blanker, one list of source extensions.
 */

/** Extensions of the files specs point at and code comments cite specs from. */
export const SOURCE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'rs', 'json', 'css', 'html', 'md',
  'sh', 'ps1', 'yaml', 'yml', 'toml',
];

/** A markdown table's separator row: nothing but rule characters. */
const isSeparatorRow = (line) => /^[|\s:-]+$/.test(line) && line.includes('---');

/**
 * The word count behind the spec budgets: whitespace tokens, minus table
 * plumbing. A separator row and the `|` cell delimiters are markup, not prose,
 * so a rule list rendered as a table — the house form — costs the same words
 * as the bullets it replaced. Applied to source text too (the prose audit
 * measures comment density with it), where a divider line is not prose either.
 */
export function countWords(text) {
  return text
    .split('\n')
    .filter((line) => !isSeparatorRow(line))
    .map((line) => line.replace(/\|/g, ' '))
    .join('\n')
    .split(/\s+/)
    .filter(Boolean).length;
}

/** The lines of a markdown text with fenced code blocks blanked, for prose-only checks. */
export function proseLines(text) {
  let inFence = false;
  return text.split('\n').map((line) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return ''; }
    return inFence ? '' : line;
  });
}
