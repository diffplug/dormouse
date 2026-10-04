#!/usr/bin/env node
/**
 * Mechanical checks for the spec-suite conventions in AGENTS.md ("Specs" and
 * "Spec lifecycle"). Runs from the repo root via `pnpm test` (see the root
 * package.json). Exits non-zero with a per-violation report.
 *
 * Checks:
 *   1. Every docs/specs/*.md file is indexed in AGENTS.md.
 *   2. `## Future` (or `## N. Future`), when present, is the LAST section of
 *      its spec — the fold convention.
 *   3. Every relative markdown link in AGENTS.md + external specs + docs/specs
 *      resolves: the target file exists, and a `#fragment` matches a real
 *      heading anchor.
 *   4. Every backticked repo path mentioned in AGENTS.md + external specs +
 *      docs/specs exists on disk — catches `Source of truth:` pointers
 *      rotting on renames.
 *      Conservative: only tokens that start with a known top-level directory
 *      and contain no globs/placeholders are checked. Build outputs that only
 *      exist after a build are skipped via SKIP_PATH_PREFIXES.
 *   5. Every spec that uses glossary vocabulary (Session / Pane / Door /
 *      baseboard / passthrough) leads with a `> See docs/specs/glossary.md`
 *      blockquote. SELF_HOST.md is exempt: its deployment runbook uses
 *      "baseboard" only incidentally.
 *   6. A named scope (`**Scope: X**` leading a line) is defined exactly once
 *      across the corpus, and every bold reference — `(**Scope: X**)` or the
 *      bare `the **x** scope` form — names a defined scope.
 *   7. Every `Reserved:` paragraph names `## Future` or a defined scope — the
 *      Reservations convention in AGENTS.md.
 *   8. Every `<foo>.rationale.md` pairs with an existing `<foo>.md`, keys its
 *      entries by that spec's headings (each rationale `## X` must exist as a
 *      heading in the spec), and has no `## Future` — rationale files are
 *      informative, the fold belongs to the spec. Rationale files are not
 *      specs: they skip checks 1, 2, and 5 but ride 3 and 4.
 *   9. A spec navigates by one form: a `Files` / `Code Map` heading (any
 *      level, any case) or section-local `Source of truth` pointers, never
 *      both. Check 4 validates a map's repo paths, check 12 the pointers.
 *  10. Word-budget ratchet: every spec, plus AGENTS.md and SECURITY.md, stays
 *      under its budget in scripts/spec-word-budgets.json. A budget is the
 *      file's size rounded up to the nearest BUDGET_STEP words. Growth past
 *      it fails; cut to fit, or add what is needed and re-baseline with
 *      `--ratchet <file>` in the same PR.
 *      Rationale files carry no budget. Words are counted by
 *      scripts/spec-md.mjs, which ignores table plumbing.
 *  11. Every `(rationale)` marker in a spec sits under a heading (or an
 *      ancestor heading) that has an entry in the paired rationale file — a
 *      marker asserts the evidence lives there. A spec with markers but no
 *      rationale file fails.
 *  12. A `Source of truth` paragraph, however its lead-in is punctuated,
 *      names at least one repo path check 4 can verify, never a bare file
 *      name (`Wall.tsx` dodges check 4 and rots silently). `Source of truth
 *      (<name> repo):` points outside this repo and is left alone. And
 *      anywhere in the prose of a spec, AGENTS.md, or SECURITY.md (not a
 *      rationale file), not only there, every `` `symbol` in
 *      `path` `` pointer names a symbol that path's file contains.
 *  13. Every citation of a spec section — `docs/specs/<name>.md -> "Heading"`,
 *      `→ Heading`, `§Heading`, or `` `## Future` `` — in a tracked source
 *      file or spec names a spec that exists and a heading (quoted forms may
 *      also name a bolded phrase) that exists in it. A quoted heading may wrap
 *      onto the next line, and every quoted heading in a list (`-> "A", "B"
 *      and "C"`) is checked. Code comments cite specs this way in hundreds of
 *      places and nothing else keeps them honest.
 *  14. A rationale file states no rule: no paragraph or bullet opens with a
 *      bolded imperative (**Never …**, **Must …**, …). Those belong in the
 *      spec.
 *  15. A spec of RATIONALE_REQUIRED_WORDS or more has a rationale file;
 *      without one every piece of evidence sits above the fold and the
 *      ratchet cannot see it. Root-level specs ride this too: the rationale
 *      sits beside its spec, so SELF_HOST.md pairs with SELF_HOST.rationale.md.
 *  16. Every security spec (docs/specs/security*.md) is claimed by exactly one
 *      audit domain: the bullet list under the `**Scope` line of a domain
 *      prompt in .github/audit/ names it, and names no file that does not
 *      exist. docs/specs/security-audit.md -> "Domains" states the rule; a
 *      spec claimed by nobody is unaudited, one claimed twice gets
 *      contradictory verdicts.
 *  17. A `**FAIL IF**` rule leads a line only in a docs/specs/security*.md
 *      spec. AGENTS.md -> "House form for rules" states it; check 16 proves
 *      each security spec has an auditor, so an audited rule written anywhere
 *      else is claimed by nobody and silently never run.
 *  18. `## Future` opens with a named scope (`**Scope: X**` leading the
 *      first line of content), design-stage specs included, and every scope
 *      lists at least one item — inline after its lead, or below it — before
 *      the next scope or heading. A lead ending in `:` introduces a list and
 *      lists nothing itself. AGENTS.md -> "Named scopes": every unbuilt item
 *      belongs to a named scope; order is the scope's to state.
 *  19. A bolded clause of RESTATED_MIN_WORDS or more written words in one spec
 *      appears in no other spec's prose, bolded or not, once case,
 *      punctuation, and markup are normalized away; a sanctioned
 *      `-> "Heading"` citation (check 13) is not prose. AGENTS.md -> "What,
 *      not why": each rule once in the corpus, every other mention a bare
 *      pointer — and where a feature spec restates a security spec's
 *      `FAIL IF`, the `FAIL IF` keeps it.
 *  20. No spec quotes a test title: a backticked or double-quoted span of
 *      RESTATED_MIN_WORDS or more written words is not, normalized as in check 19,
 *      the title of an `it(` / `test(` call in a tracked test file. AGENTS.md
 *      -> "House form for rules": cite the test file, never a title, which
 *      renames silently.
 *
 * scripts/spec-lint-selftest.mjs plants one defect per finding check and
 * requires this lint to go red.
 */
import { readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { readRepoFile, repoRoot as ROOT, trackedFiles } from './lint-kit.mjs';
import { countWords, proseLines as proseLinesOf, SOURCE_EXTENSIONS } from './spec-md.mjs';

const SPECS_DIR = 'docs/specs';

const TOP_LEVEL_DIRS = [
  'lib/', 'standalone/', 'vscode-ext/', 'website/', 'relay/', 'hosted/',
  'remote-lib-common/', 'dor/', 'dor-lib-common/', 'dor-tools-builtin/', 'dor-tools-lib/', 'canopy/', 'docs/',
  'scripts/', 'deploy/', '.github/', '.claude/', '.vscode/',
];
// Path prefixes that are legitimate references to build/staged/generated
// output which does not exist in a clean checkout.
const SKIP_PATH_PREFIXES = [
  'lib/dist', 'dor/dist', 'vscode-ext/dist', 'vscode-ext/media',
  'standalone/dist', 'hosted/dist',
  'website/src/data/changelog.json', // gitignored, generated by website prebuild (deploy.md)
  'standalone/sidecar/node_modules', // created by pnpm install; the Tauri bundle copies it (security-supply-chain.md)
];
// Root files a spec may name without a directory; every other checkable path
// starts with a top-level dir.
const ROOT_FILES = ['AGENTS.md', 'DESIGN.md', 'PRODUCT.md', 'SECURITY.md', 'SELF_HOST.md', 'SELF_HOST.rationale.md', 'package.json', 'pnpm-workspace.yaml'];

/**
 * A backticked token check 4 verifies on disk: a listed root file, or a repo
 * path under a known top-level dir with no glob or placeholder that is not
 * build output. Check 12 uses the same notion, so "verifiable" means one thing.
 */
function checkablePath(token) {
  if (ROOT_FILES.includes(token)) return true;
  if (!token.includes('/')) return false;
  if (/[\s*{<>$%(?\\]|\.\.\.|…/.test(token)) return false;
  if (!TOP_LEVEL_DIRS.some((d) => token.startsWith(d))) return false;
  return !SKIP_PATH_PREFIXES.some((p) => token.startsWith(p));
}

const specDirFiles = readdirSync(join(ROOT, SPECS_DIR))
  .filter((f) => f.endsWith('.md'))
  // Keep repo-relative paths in POSIX form on every platform — they are
  // compared against forward-slash paths written in the markdown.
  .map((f) => `${SPECS_DIR}/${f}`);
const specFiles = specDirFiles.filter((f) => !f.endsWith('.rationale.md'));
// Canonical specs outside docs/specs pair with a rationale beside the source.
// Declare the specs, so a missing companion can still be diagnosed.
const EXTERNAL_SPECS = ['SELF_HOST.md', 'docs/compatible-agents.md'];
const rationaleFiles = [
  ...specDirFiles.filter((f) => f.endsWith('.rationale.md')),
  ...EXTERNAL_SPECS.map((f) => f.replace(/\.md$/, '.rationale.md')).filter((f) => existsSync(join(ROOT, f))),
];
// SECURITY.md is a policy pointer; only link, path, and budget checks apply.
const allFiles = ['AGENTS.md', 'SECURITY.md', ...EXTERNAL_SPECS, ...specFiles, ...rationaleFiles];
const foldCheckedFiles = [...EXTERNAL_SPECS, ...specFiles];
/** Specs that pair with a rationale file — checks 11 and 15. */
const rationaleCheckedSpecs = [...EXTERNAL_SPECS, ...specFiles];
const problems = [];

/** Memoize a one-argument pure function; the lint never writes, so nothing goes stale. */
const memo = (fn) => {
  const cache = new Map();
  return (key) => (cache.has(key) ? cache : cache.set(key, fn(key))).get(key);
};
const read = memo(readRepoFile);
/** A repo file's text, or null when the path is missing or not a regular file. */
const readIfExists = (rel) => (statSync(join(ROOT, rel), { throwIfNoEntry: false })?.isFile() ? read(rel) : null);

/** The fold heading's title: `Future` or `N. Future`. */
const FUTURE_TITLE_RE = /^(\d+\.\s*)?Future$/i;
/** A bolded phrase. */
const BOLD_RE = /\*\*([^*\n]+)\*\*/g;

/** GitHub-style anchor slug for a heading title. */
function slug(title) {
  let t = title.trim().replace(/`/g, '');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // unwrap md links
  return t
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-');
}

/** Lines of a file with fenced code blocks blanked, for prose-only checks. */
const proseLines = memo((rel) => proseLinesOf(read(rel)));

/** Every heading of a file, with its 1-based line number. */
const headings = memo((rel) => {
  const out = [];
  proseLines(rel).forEach((line, i) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) out.push({ level: m[1].length, title: m[2].trim(), line: i + 1 });
  });
  return out;
});

const anchorsOf = memo((rel) => new Set(headings(rel).map((h) => slug(h.title))));
/** The headings a rationale file keys its entries by. */
const rationaleKeys = memo((rat) => new Set(headings(rat).filter((h) => h.level === 2).map((h) => slug(h.title))));
const hasRationale = new Set(rationaleFiles);

/**
 * The block that starts at `lines[i]` (`head` overrides the first line's
 * text): its continuation lines, up to a blank line, a new top-level bullet,
 * or a heading, plus a table that immediately follows it — `Source of truth:`
 * sometimes introduces one.
 */
function blockAt(lines, i, head = lines[i]) {
  const ends = (l) => l.trim() === '' || /^[-*]\s/.test(l) || /^#{1,6}\s/.test(l);
  let text = head;
  let j = i + 1;
  for (; j < lines.length && !ends(lines[j]); j++) text += '\n' + lines[j];
  while (j < lines.length && lines[j].trim() === '') j++;
  for (; j < lines.length && lines[j].trimStart().startsWith('|'); j++) text += '\n' + lines[j];
  return text;
}

// --- Check 1: index completeness -------------------------------------------
const agents = read('AGENTS.md');
for (const spec of specFiles) {
  const base = spec.split('/').pop();
  if (!agents.includes(base)) {
    problems.push(`AGENTS.md: spec not indexed -> ${spec}`);
  }
}

// --- Check 2: Future is the last section ------------------------------------
for (const spec of foldCheckedFiles) {
  const h2s = headings(spec).filter((h) => h.level === 2);
  const futureIdx = h2s.findIndex((h) => FUTURE_TITLE_RE.test(h.title));
  if (futureIdx !== -1 && futureIdx !== h2s.length - 1) {
    problems.push(
      `${spec}: "## ${h2s[futureIdx].title}" must be the last section ` +
      `(followed by "## ${h2s[futureIdx + 1].title}")`,
    );
  }
}

// --- Check 3: relative links + anchors resolve -------------------------------
const LINK_RE = /\]\(([^)\s]+)\)/g;
for (const rel of allFiles) {
  const base = dirname(rel);
  const lines = read(rel).split('\n');
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) return;
    for (const m of line.matchAll(LINK_RE)) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [path, fragment] = target.split('#');
      const full = path ? normalize(join(base, path)) : rel;
      if (path && !existsSync(join(ROOT, full))) {
        problems.push(`${rel}:${i + 1}: broken link -> ${target}`);
        continue;
      }
      if (fragment && full.endsWith('.md') && !anchorsOf(full).has(fragment)) {
        problems.push(`${rel}:${i + 1}: missing anchor -> ${target}`);
      }
    }
  });
}

// --- Check 4: backticked repo paths exist ------------------------------------
const TICK_RE = /`([^`\n]+)`/g;
for (const rel of allFiles) {
  proseLines(rel).forEach((line, i) => {
    for (const m of line.matchAll(TICK_RE)) {
      const token = m[1];
      if (checkablePath(token) && !existsSync(join(ROOT, token))) {
        problems.push(`${rel}:${i + 1}: path does not exist -> ${token}`);
      }
    }
  });
}

// --- Check 5: glossary callout for specs using glossary vocabulary -----------
// Conservative match: the capitalized glossary senses plus the two words that
// are dormouse-specific in any case. Lowercase "session"/"pane" prose and
// compounds like `PersistedPane` do not trigger.
const GLOSSARY_VOCAB = /\b(?:Pane|Door|Session|[Bb]aseboard|passthrough)\b/;
for (const spec of foldCheckedFiles) {
  if (spec === 'SELF_HOST.md' || spec.endsWith('/glossary.md')) continue;
  const lines = proseLines(spec);
  const firstH2 = lines.findIndex((l) => /^##\s/.test(l));
  const head = lines.slice(0, firstH2 === -1 ? lines.length : firstH2);
  if (head.some((l) => l.startsWith('>') && l.includes('glossary.md'))) continue;
  const hit = lines.findIndex((l) => GLOSSARY_VOCAB.test(l));
  if (hit !== -1) {
    problems.push(
      `${spec}:${hit + 1}: uses glossary vocabulary but has no leading ` +
      '"> See docs/specs/glossary.md ..." blockquote',
    );
  }
}

// --- Check 6: named scopes defined once; bold references resolve --------------
const SCOPE_RE = /\*\*Scope: ([a-z0-9-]+)\*\*/g;
/** A scope definition: the bold scope name leading its line. */
const SCOPE_LEAD_RE = new RegExp(`^${SCOPE_RE.source}`);
// Cross-spec references also use the bare form ("the **dor-tools** scope"),
// which AGENTS.md sanctions with "other specs link to it by name".
const SCOPE_REF_RE = /\*\*([a-z0-9-]+)\*\* scope/g;
const scopeDefs = new Map(); // name -> "file:line" of the definition
const scopeRefs = [];
for (const rel of allFiles) {
  proseLines(rel).forEach((line, i) => {
    for (const m of line.matchAll(SCOPE_RE)) {
      if (m.index === 0) {
        // A definition leads its line; references are parenthesized mid-line.
        if (scopeDefs.has(m[1])) {
          problems.push(
            `${rel}:${i + 1}: scope "${m[1]}" already defined at ` +
            `${scopeDefs.get(m[1])} — a scope is defined in exactly one spec`,
          );
        } else {
          scopeDefs.set(m[1], `${rel}:${i + 1}`);
        }
      } else {
        scopeRefs.push({ rel, line: i + 1, name: m[1] });
      }
    }
    for (const m of line.matchAll(SCOPE_REF_RE)) {
      scopeRefs.push({ rel, line: i + 1, name: m[1] });
    }
  });
}
for (const ref of scopeRefs) {
  if (!scopeDefs.has(ref.name)) {
    problems.push(`${ref.rel}:${ref.line}: reference to undefined scope "${ref.name}"`);
  }
}

// --- Check 7: Reserved: names ## Future or a defined scope --------------------
for (const rel of allFiles) {
  const lines = proseLines(rel);
  lines.forEach((line, i) => {
    if (!/\bReserved:/.test(line)) return;
    const para = blockAt(lines, i);
    const named = /Future/.test(para) || [...scopeDefs.keys()].some((n) => para.includes(n));
    if (!named) {
      problems.push(
        `${rel}:${i + 1}: "Reserved:" paragraph names neither ## Future nor a defined scope`,
      );
    }
  });
}

// --- Check 8: rationale files pair with a spec and key by its headings --------
for (const rat of rationaleFiles) {
  const spec = rat.replace(/\.rationale\.md$/, '.md');
  if (!existsSync(join(ROOT, spec))) {
    problems.push(`${rat}: no paired spec -> ${spec}`);
    continue;
  }
  const specAnchors = anchorsOf(spec);
  for (const h of headings(rat).filter((h) => h.level === 2)) {
    if (FUTURE_TITLE_RE.test(h.title)) {
      problems.push(`${rat}: rationale files are informative — the fold ("## Future") belongs to ${spec}`);
    } else if (!specAnchors.has(slug(h.title))) {
      problems.push(`${rat}: "## ${h.title}" is not a heading in ${spec}`);
    }
  }
}

// A `Source of truth` lead-in, however punctuated, that points into this repo;
// `Source of truth (<name> repo):` points outside it. Checks 9 and 12 share it.
function sourceOfTruthLead(line) {
  const lead = /Source of truth\b([^:\n]*):/.exec(line);
  return lead && !/\brepo\)/.test(lead[1]) ? lead : null;
}

// --- Check 9: a map or pointers, never both ----------------------------------
const MAP_HEADING_RE = /^(?:Files|Code Map)$/i;
for (const spec of foldCheckedFiles) {
  const map = headings(spec).find((h) => MAP_HEADING_RE.test(h.title));
  if (!map) continue;
  const pointer = proseLines(spec).findIndex(sourceOfTruthLead);
  if (pointer === -1) continue;
  problems.push(
    `${spec}:${pointer + 1}: \`Source of truth\` pointer beside "${'#'.repeat(map.level)} ${map.title}" (line ${map.line}) — ` +
    'choose the map or section pointers, never both (AGENTS.md -> "Specs")',
  );
}

// --- Check 10: word-budget ratchet ------------------------------------------
// A budget is the file's size rounded up to the nearest BUDGET_STEP words, so
// a rule (46 words at the corpus median) rarely fits without trimming a clause
// elsewhere, and the budgets file changes only when a size crosses a step.
// `--ratchet [file...]` rewrites the budgets of the named files (all of them
// when none is named) to that formula and drops entries for files that carry
// none. Rationale files carry none: evidence may grow without limit.
const BUDGETS_FILE = 'scripts/spec-word-budgets.json';
const BUDGET_STEP = 50;
const budgetedFiles = ['AGENTS.md', 'SECURITY.md', ...EXTERNAL_SPECS, ...specFiles];
const wordsOf = new Map(budgetedFiles.map((rel) => [rel, countWords(read(rel))]));
const budgetFor = (rel) => Math.ceil(wordsOf.get(rel) / BUDGET_STEP) * BUDGET_STEP;
let budgets = JSON.parse(read(BUDGETS_FILE));
const ratchetAt = process.argv.indexOf('--ratchet');
if (ratchetAt !== -1) {
  const named = process.argv.slice(ratchetAt + 1).filter((a) => !a.startsWith('-'));
  for (const rel of named) {
    if (!budgetedFiles.includes(rel)) {
      console.error(`spec-lint: --ratchet ${rel}: not a budgeted file (specs, AGENTS.md, SECURITY.md, SELF_HOST.md)`);
      process.exit(2);
    }
  }
  const chosen = named.length ? named : budgetedFiles;
  for (const rel of chosen) budgets[rel] = budgetFor(rel);
  budgets = Object.fromEntries(budgetedFiles.filter((rel) => rel in budgets).sort().map((rel) => [rel, budgets[rel]]));
  writeFileSync(join(ROOT, BUDGETS_FILE), JSON.stringify(budgets, null, 2) + '\n');
  console.log(`spec-lint: ratcheted ${chosen.length} budget(s) to size rounded up to ${BUDGET_STEP}`);
}
for (const rel of budgetedFiles) {
  const words = wordsOf.get(rel);
  const budget = budgets[rel];
  if (budget === undefined) {
    problems.push(`${BUDGETS_FILE}: no budget for ${rel} — run \`node scripts/spec-lint.mjs --ratchet ${rel}\` (currently ${words} words)`);
  } else if (words > budget) {
    problems.push(
      `${rel}: ${words} words exceeds its ${budget}-word budget — cut to fit, or add what is ` +
      `needed and run \`node scripts/spec-lint.mjs --ratchet ${rel}\` in the same PR`,
    );
  }
}
for (const rel of Object.keys(budgets)) {
  if (!budgetedFiles.includes(rel)) {
    const why = rel.endsWith('.rationale.md') ? 'rationale files carry no budget' : 'no such spec';
    problems.push(`${BUDGETS_FILE}: stale entry for ${rel} — ${why}; run \`node scripts/spec-lint.mjs --ratchet\``);
  }
}

// --- Check 11: (rationale) markers sit under a heading the rationale keys -----
// The marker is the word `rationale` as an item of a parenthetical —
// `(rationale)`, `(rationale; …)`, `(…; rationale)`.
const MARKER_RE = /(?:^|[(;])\s*rationale\s*[;)]/;
for (const spec of rationaleCheckedSpecs) {
  const rat = spec.replace(/\.md$/, '.rationale.md');
  const keys = hasRationale.has(rat) ? rationaleKeys(rat) : null;
  const heads = headings(spec);
  proseLines(spec).forEach((line, i) => {
    if (!MARKER_RE.test(line)) return;
    if (!keys) {
      problems.push(`${spec}:${i + 1}: "(rationale)" marker, but ${rat} does not exist`);
      return;
    }
    // The marker's heading and that heading's ancestors.
    const chain = [];
    for (const h of heads) {
      if (h.line > i + 1) break;
      while (chain.length && chain[chain.length - 1].level >= h.level) chain.pop();
      chain.push(h);
    }
    if (!chain.some((h) => keys.has(slug(h.title)))) {
      const under = chain.length ? chain[chain.length - 1].title : '(no heading)';
      problems.push(
        `${spec}:${i + 1}: "(rationale)" marker under "${under}", but ${rat} has no ` +
        'entry under that heading or an ancestor of it',
      );
    }
  });
}

// --- Check 12: Source of truth paragraphs are checkable ---------------------
const BARE_BASENAME_RE = new RegExp(`^[\\w.-]+\\.(?:${SOURCE_EXTENSIONS.join('|')})$`);
const IDENT_RE = /^[A-Za-z_$][\w$]*(?:[.#][\w$]+)*(?:\(\))?$/;
// `` `sym` / `sym2` in `path` `` — the symbols placed in a file.
const SYMBOLS_IN_FILE_RE = /((?:`[^`\n]+`\s*(?:\/|,|and|\+)?\s*)+)\bin\s+`([^`\n]+)`/g;
for (const spec of foldCheckedFiles) {
  const lines = proseLines(spec);
  lines.forEach((line, i) => {
    const lead = sourceOfTruthLead(line);
    if (!lead) return;
    const para = blockAt(lines, i, line.slice(lead.index));
    const tokens = [...para.matchAll(TICK_RE)].map((m) => m[1]);
    if (!tokens.some(checkablePath)) {
      problems.push(`${spec}:${i + 1}: Source of truth names no repo path the path check can verify`);
    }
    for (const t of tokens) {
      if (BARE_BASENAME_RE.test(t) && !checkablePath(t)) {
        problems.push(`${spec}:${i + 1}: Source of truth names a bare file name \`${t}\` — use the full repo path`);
      }
    }
  });
}
// Symbols placed in a file, anywhere in a non-rationale file's prose: a pointer outside
// `Source of truth` rots the same way. Rationale files are history, and may
// name what is gone. A directory, or a path check 4 reports missing, is skipped.
for (const rel of allFiles.filter((f) => !rationaleFiles.includes(f))) {
  proseLines(rel).forEach((line, i) => {
    for (const m of line.matchAll(SYMBOLS_IN_FILE_RE)) {
      const src = checkablePath(m[2]) ? readIfExists(m[2]) : null;
      if (src === null) continue;
      for (const sym of [...m[1].matchAll(TICK_RE)].map((x) => x[1])) {
        if (!IDENT_RE.test(sym)) continue;
        const leaf = sym.replace(/\(\)$/, '').split(/[.#]/).pop();
        if (!src.includes(leaf)) {
          problems.push(`${rel}:${i + 1}: places \`${sym}\` in \`${m[2]}\`, which does not contain it`);
        }
      }
    }
  });
}

// --- Check 13: spec-section citations resolve, in specs and in code --------
// `docs/specs/<name>.md -> "Heading"`, `→ Heading`, `("Heading")`, `§8.9`, or
// `` `## Future` ``. A quoted reference may also name a bolded phrase; an
// unquoted one runs on into the sentence, so its prefixes are tried, and a
// lone word must open a heading. A numbered `§` names the heading that carries
// that number. A quoted reference may continue as a list (`"A", "B" and "C"`),
// and may wrap: a line with an unclosed quote is read joined to the next one.
const CITABLE = [...new Set([...ROOT_FILES.filter((f) => f.endsWith('.md')), ...EXTERNAL_SPECS])]
  .map((f) => f.replaceAll('.', '\\.')).join('|');
const CITATION_RE = new RegExp(
  `(docs\\/specs\\/[a-z-]+\\.md|${CITABLE})[\`)\\]]*\\s*(?:` +
  '(?:->|→)\\s*(?:"([^"]+)"|`(#{1,6}\\s[^`]+)`|([A-Z][^"`.,;:()\\n]*))' +
  '|§\\s*(\\d+(?:\\.\\d+)*|[^.,;:()\\n]+)' +
  '|\\(\\s*"([^"]+)")',
  'g',
);
// The further headings of a quoted citation, from just past its first one.
const MORE_QUOTED_RE = /^\s*(?:,\s*(?:and\s+|or\s+)?|and\s+|or\s+)"([^"]+)"/;
// A comment or blockquote marker that opens a continuation line.
const CONTINUATION_RE = /^\s*(?:\/\/+|\*(?!\*)|#|>)?\s*/;
const CITING_FILE_RE = new RegExp(`\\.(?:${SOURCE_EXTENSIONS.join('|')})$`);
const citeTarget = memo((rel) => {
  const text = readIfExists(rel);
  if (text === null) return null;
  return {
    heads: headings(rel).map((h) => h.title),
    bolds: [...text.matchAll(BOLD_RE)].map((m) => m[1]),
  };
});
for (const rel of trackedFiles().filter((f) => CITING_FILE_RE.test(f))) {
  let text;
  try { text = read(rel); } catch { continue; }
  const lines = text.split('\n');
  lines.forEach((own, i) => {
    if (!own.includes('.md')) return; // every citable name ends in .md; this guard is exact, and cheaper than the regex
    // An odd quote count means a quoted heading wraps; a match must still start on this line.
    const wraps = (own.split('"').length - 1) % 2 === 1 && i + 1 < lines.length;
    const line = wraps ? `${own} ${lines[i + 1].replace(CONTINUATION_RE, '')}` : own;
    for (const m of line.matchAll(CITATION_RE)) {
      if (m.index >= own.length) break;
      const t = citeTarget(m[1]);
      if (!t) {
        // A backticked path in a spec is check 4's report already; anything else is nobody's.
        const backticked = allFiles.includes(rel) && line[m.index - 1] === '`';
        if (!backticked) problems.push(`${rel}:${i + 1}: cites ${m[1]}, which does not exist`);
        continue;
      }
      const quoted = m[2] !== undefined || m[6] !== undefined;
      const refs = [(m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6]).replace(/^#+\s*/, '').trim()];
      if (quoted) {
        let rest = line.slice(m.index + m[0].length);
        for (let more; (more = rest.match(MORE_QUOTED_RE)); rest = rest.slice(more[0].length)) refs.push(more[1].trim());
      }
      const inHeading = (r) => t.heads.some((h) => h.includes(r));
      const opensHeading = (r) => t.heads.some((h) => h === r || h.startsWith(`${r} `) || h.startsWith(`${r}:`));
      const names = (r) => inHeading(r) || t.bolds.some((b) => b.includes(r));
      for (const ref of refs.filter(Boolean)) {
        let ok;
        if (/^\d+(?:\.\d+)*$/.test(ref)) {
          ok = t.heads.some((h) => h.startsWith(`${ref} `) || h.startsWith(`${ref}.`));
        } else if (quoted) {
          ok = names(ref);
        } else {
          const words = ref.split(/\s+/);
          ok = words.some((_, k) => {
            const r = words.slice(0, words.length - k).join(' ');
            return r.includes(' ') ? names(r) : opensHeading(r);
          });
        }
        if (!ok) {
          problems.push(
            `${rel}:${i + 1}: cites ${m[1]} -> "${ref}", which names no heading` +
            `${quoted ? ' or phrase' : ''} in that file`,
          );
        }
      }
    }
  });
}

// --- Check 14: rationale files state no rule ---------------------------------
const BOLD_IMPERATIVE_RE = /^\s*(?:[-*]\s+)?\*\*(?:Never|Must|Always|May|Do not|Don['’]t|Should|Shall)\b/;
for (const rat of rationaleFiles) {
  proseLines(rat).forEach((line, i) => {
    if (BOLD_IMPERATIVE_RE.test(line)) {
      problems.push(`${rat}:${i + 1}: opens with a bolded imperative — rules live in the spec, not the rationale`);
    }
  });
}

// --- Check 15: a large spec has a rationale file -----------------------------
const RATIONALE_REQUIRED_WORDS = 2500; // stated in AGENTS.md -> "What, not why"
for (const spec of rationaleCheckedSpecs) {
  const rat = spec.replace(/\.md$/, '.rationale.md');
  const words = wordsOf.get(spec);
  if (!hasRationale.has(rat) && words >= RATIONALE_REQUIRED_WORDS) {
    problems.push(`${spec}: ${words} words and no ${rat} — its evidence has nowhere to go but above the fold`);
  }
}

// --- Check 16: every security spec is claimed by exactly one audit domain ----
// Ownership is by file, declared in each domain prompt's scope block — the
// bullet list directly under its `**Scope` line — as backticked repo paths.
// The preamble and the orchestrator are not domains and claim nothing.
const AUDIT_DIR = '.github/audit';
const domainFiles = readdirSync(join(ROOT, AUDIT_DIR))
  .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'orchestrator.md')
  .map((f) => `${AUDIT_DIR}/${f}`);
const claimants = new Map(specFiles.filter((f) => /\/security[a-z-]*\.md$/.test(f)).map((f) => [f, []]));
if (domainFiles.length === 0) problems.push(`${AUDIT_DIR}: no domain prompt files — check 16 enforces nothing`);
for (const rel of domainFiles) {
  const lines = proseLines(rel);
  const at = lines.findIndex((l) => /^\*\*Scope\b/.test(l));
  if (at === -1) {
    problems.push(`${rel}: no "**Scope" line — the domain claims no spec`);
    continue;
  }
  let j = at + 1;
  while (j < lines.length && lines[j].trim() === '') j++;
  const claimed = [];
  for (; j < lines.length && /^[-*]\s/.test(lines[j]); j++) {
    for (const m of lines[j].matchAll(TICK_RE)) claimed.push(m[1]);
  }
  if (claimed.length === 0) problems.push(`${rel}: the bullet list under "**Scope" names no spec`);
  for (const path of claimed) {
    if (claimants.has(path)) claimants.get(path).push(rel);
    else problems.push(`${rel}: scope names ${path}, which is not a security spec (docs/specs/security*.md) that exists`);
  }
}
for (const [spec, by] of claimants) {
  if (by.length === 0) problems.push(`${spec}: in no audit domain's scope (${AUDIT_DIR}) — unaudited`);
  else if (by.length > 1) problems.push(`${spec}: in the scope of ${by.join(' and ')} — one domain owns a spec, or their verdicts contradict`);
}

// --- Check 17: an audited rule lives only in a security spec -----------------
// Check 16 gives every security spec exactly one auditor; nothing gives one to
// any other file, so a `FAIL IF` written elsewhere is never executed. Matched
// only where the bold LEADS the line — an inline `` `FAIL IF` `` pointer at the
// specs that own them is the form this leaves alone.
const FAIL_IF_RE = /^\s*(?:[-*]\s+)?\*\*FAIL IF\b/;
for (const rel of allFiles) {
  if (claimants.has(rel)) continue;
  proseLines(rel).forEach((line, i) => {
    if (!FAIL_IF_RE.test(line)) return;
    problems.push(
      `${rel}:${i + 1}: a "**FAIL IF**" rule outside docs/specs/security*.md — no audit domain ` +
      'claims this file, so nothing runs it (AGENTS.md -> "House form for rules")',
    );
  });
}

// --- Check 18: Future opens with a named scope, and no scope is empty ---------
for (const spec of foldCheckedFiles) {
  const fold = headings(spec).find((h) => h.level === 2 && FUTURE_TITLE_RE.test(h.title));
  if (!fold) continue;
  // The lines below the fold heading; `fold.line` is 1-based, so index k is line fold.line + k + 1.
  const body = proseLines(spec).slice(fold.line);
  const at = (k) => fold.line + k + 1;
  const first = body.findIndex((l) => l.trim() !== '');
  if (first !== -1 && !SCOPE_LEAD_RE.test(body[first])) {
    problems.push(`${spec}:${at(first)}: "## ${fold.title}" opens without a "**Scope: X**" lead (AGENTS.md -> "Named scopes")`);
  }
  body.forEach((line, k) => {
    const lead = SCOPE_LEAD_RE.exec(line);
    if (!lead) return;
    const inline = line.slice(lead[0].length).replace(/^[\s—–:.-]+/, '').trim();
    if (inline && !inline.endsWith(':')) return;
    const next = body.slice(k + 1).find((l) => l.trim() !== '');
    if (next === undefined || SCOPE_LEAD_RE.test(next) || /^#{1,6}\s/.test(next)) {
      problems.push(`${spec}:${at(k)}: ${lead[0]} lists no item before the next scope or heading`);
    }
  });
}

// --- Check 19: a bolded clause is stated in one spec only --------------------
// Shorter bold runs are labels and slogans ("Must", "Known gaps"), which two
// specs may share without either restating a rule.
const RESTATED_MIN_WORDS = 6;
const normalized = (text) => text.toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
// Counted as written, before normalizing splits `half-working` or `Pi's` in two.
const writtenWords = (text) => text.trim().split(/\s+/).length;
// A quoted citation (`-> "A", "B" and "C"`) names a heading or bolded phrase
// on purpose — check 13 verifies it — so it is not a restatement.
const QUOTED_CITATION_RE = /(?:->|→)\s*"[^"\n]*"(?:\s*(?:,\s*(?:and\s+|or\s+)?|and\s+|or\s+)"[^"\n]*")*/g;
const specProse = new Map(foldCheckedFiles.map((f) => [f, ` ${normalized(proseLines(f).join('\n').replace(QUOTED_CITATION_RE, ' '))} `]));
// Every run of RESTATED_MIN_WORDS words -> the specs containing it, so a
// clause is substring-searched only in specs that share its opening words.
const specsWithRun = new Map();
for (const [spec, prose] of specProse) {
  const words = prose.trim().split(' ');
  for (let k = 0; k + RESTATED_MIN_WORDS <= words.length; k++) {
    const run = words.slice(k, k + RESTATED_MIN_WORDS).join(' ');
    if (!specsWithRun.has(run)) specsWithRun.set(run, new Set());
    specsWithRun.get(run).add(spec);
  }
}
for (const spec of foldCheckedFiles) {
  proseLines(spec).forEach((line, i) => {
    for (const m of line.matchAll(BOLD_RE)) {
      if (writtenWords(m[1]) < RESTATED_MIN_WORDS) continue;
      const clause = normalized(m[1]);
      const words = clause.split(' ');
      for (const other of specsWithRun.get(words.slice(0, RESTATED_MIN_WORDS).join(' ')) ?? []) {
        if (other !== spec && specProse.get(other).includes(` ${clause} `)) {
          problems.push(
            `${spec}:${i + 1}: bolded "${m[1]}" is restated in ${other} — keep it in the spec that owns it ` +
            '(a `FAIL IF` over a feature spec) and point there (AGENTS.md -> "What, not why")',
          );
        }
      }
    }
  });
}

// --- Check 20: no spec quotes a test title ----------------------------------
// Only quoted spans are candidates: a rule phrased like the test named after
// it is the test following the spec, not the spec quoting the test.
const QUOTED_SPAN_RE = /`([^`\n]+)`|"([^"\n]+)"/g;
const TEST_FILE_RE = /\.(?:test|spec|smoketest)\.[cm]?[jt]sx?$|(?:^|\/)tests?\/.*\.[cm]?[jt]sx?$/;
// `it('…')`, `test.each(…)("…")`, … — a template title with `${…}` is never quoted whole.
const TITLE_RE = /\b(?:it|test)(?:\.(?:only|skip|todo|concurrent|each\([^)]*\)))?\(\s*(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
const testTitles = new Map(); // normalized title -> test file
for (const rel of trackedFiles().filter((f) => TEST_FILE_RE.test(f))) {
  for (const m of (readIfExists(rel) ?? '').matchAll(TITLE_RE)) testTitles.set(normalized(m[2]), rel);
}
for (const spec of foldCheckedFiles) {
  proseLines(spec).forEach((line, i) => {
    for (const m of line.matchAll(QUOTED_SPAN_RE)) {
      const span = m[1] ?? m[2];
      const key = normalized(span);
      const test = testTitles.get(key);
      if (test && writtenWords(span) >= RESTATED_MIN_WORDS) {
        problems.push(`${spec}:${i + 1}: quotes the title of a test in ${test} ("${span}") — cite the test file, never a title`);
      }
    }
  });
}

// -----------------------------------------------------------------------------
if (problems.length > 0) {
  console.error(`spec-lint: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nConventions are defined in AGENTS.md ("Specs" and "Spec lifecycle").',
  );
  process.exit(1);
}
console.log(`spec-lint: OK (${specFiles.length} specs, ${allFiles.length} files checked)`);
