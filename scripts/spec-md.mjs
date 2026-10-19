/**
 * The spec-markdown kit `scripts/spec-lint.mjs`, `scripts/prose-audit.mjs`,
 * and `website/scripts/generate-docs.js` share: one word count, one fence
 * blanker, one list of source extensions, one anchor slug, one reading of
 * what the audit's domain prompts claim, and one reading of its rules.
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

/** GitHub-style anchor slug for a heading title. */
export function githubSlug(title) {
  let t = title.trim().replace(/`/g, '');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // unwrap md links
  return t
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-');
}

/** A line an audited rule leads: the bold opens the line, or its bullet. */
export const FAIL_IF_RE = /^\s*(?:[-*]\s+)?\*\*FAIL IF\b/;

/** An audited rule's stable ID, `S<n>`, as a regex source: global across the security specs, never reused. */
export const RULE_ID = 'S[1-9]\\d*';
/** The ID a rule line carries: one code span right after the bold, then a space and the rule, which opens with no second ID. */
const RULE_LEAD_RE = new RegExp(`^\\s*(?:[-*]\\s+)?\\*\\*FAIL IF\\*\\* \`(${RULE_ID})\` (?!\`S\\d)\\S`);
/** The registry of IDs: the next one a new rule takes, and those of deleted rules, never reused. */
export const RULE_IDS_FILE = 'scripts/security-rule-ids.json';

const RULE_HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const RULE_FENCE_RE = /^\s*(```|~~~)/;

/**
 * Every audited rule of a security spec's text, in source order: its 1-based
 * line, its heading, its ID (null when the line carries none, well formed),
 * and its text, indented continuation lines included. Fenced code is skipped,
 * and nothing under `## Future` is a rule.
 */
export function auditedRules(text) {
  const rules = [];
  let heading = null;
  let fenced = false;
  let rule = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (RULE_FENCE_RE.test(line)) { fenced = !fenced; rule = null; continue; }
    if (fenced) continue;
    const h = line.match(RULE_HEADING_RE);
    if (h) {
      if (h[1] === '##' && /^Future\b/.test(h[2])) break;
      heading = h[2];
      rule = null;
      continue;
    }
    if (heading !== null && FAIL_IF_RE.test(line)) {
      rule = { line: i + 1, heading, id: line.match(RULE_LEAD_RE)?.[1] ?? null, text: line };
      rules.push(rule);
    } else if (rule && /^\s+\S/.test(line)) {
      rule.text += `\n${line}`;
    } else {
      rule = null;
    }
  }
  return rules;
}

/** Where the audit's domain prompts live (docs/specs/security-audit.md -> "Domains"). */
export const AUDIT_DIR = '.github/audit';

/** Whether a file in {@link AUDIT_DIR} is a domain prompt: the preamble and the orchestrator claim nothing. */
export const isDomainPrompt = (file) => file.endsWith('.md') && !file.startsWith('_') && file !== 'orchestrator.md';

/**
 * The repo paths a domain prompt's scope claims: the backticked paths in the
 * bullet list directly under its `**Scope` line. Null when it has no such
 * line. `lines` are {@link proseLines}, so a fenced example claims nothing.
 */
export function scopeOf(lines) {
  const at = lines.findIndex((l) => /^\*\*Scope\b/.test(l));
  if (at === -1) return null;
  let j = at + 1;
  while (j < lines.length && lines[j].trim() === '') j++;
  const claimed = [];
  for (; j < lines.length && /^[-*]\s/.test(lines[j]); j++) {
    for (const m of lines[j].matchAll(/`([^`\n]+)`/g)) claimed.push(m[1]);
  }
  return claimed;
}
