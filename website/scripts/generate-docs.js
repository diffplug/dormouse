/**
 * Build-time codegen for the public documentation pages.
 *
 * Reads the canonical sources, parses them with the in-repo Markdown parser,
 * and writes one gitignored data module the website imports. Browser code never
 * imports Dor implementation modules (they use Node APIs) or reads Markdown at
 * runtime — everything it needs is in the generated JSON.
 *
 * Wired into website `predev` / `pretest` / `prebuild`, mirroring
 * generate-changelog.js.
 *
 * See docs/specs/website-docs.md.
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSlugger, parseMarkdown, inlineToText } from './docs-parser.js';
import {
  parseSnapshot,
  parseHelp,
  reconstruct,
  rootCommandNames,
  usageLines,
  definitionRows,
  labelledBody,
  proseParagraphs,
  MalformedSnapshotError,
} from './help-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const outFile = join(__dirname, '..', 'src', 'data', 'docs.json');

/**
 * The complete `/docs` delta, per docs/specs/website-docs.md.
 *
 * The website applies only structural operations to the canonical README. Each
 * entry names exactly one target and fails the build when that target is absent
 * or ambiguous — no regexes over prose, no line-number patches.
 */
const DOCS_DELTA = [
  {
    id: 'drop-document-title',
    reason: 'The docs page shell supplies its own title and breadcrumb.',
    /** @param {{type: string, depth?: number}} block */
    match: (block) => block.type === 'heading' && block.depth === 1,
    operation: 'remove',
  },
];

function applyDelta(blocks) {
  const applied = [];
  let result = blocks;

  for (const rule of DOCS_DELTA) {
    const matches = result.filter(rule.match);
    if (matches.length === 0) {
      throw new Error(`docs delta "${rule.id}" matched nothing; its target is gone`);
    }
    if (matches.length > 1) {
      throw new Error(`docs delta "${rule.id}" matched ${matches.length} blocks; target is ambiguous`);
    }
    if (rule.operation !== 'remove') {
      throw new Error(`docs delta "${rule.id}" has unknown operation "${rule.operation}"`);
    }
    const [target] = matches;
    result = result.filter((b) => b !== target);
    applied.push({ id: rule.id, reason: rule.reason, operation: rule.operation, target: target.text ?? null });
  }

  return { blocks: result, applied };
}

/** Build the nested table of contents the docs shell renders. */
function buildToc(headings) {
  const top = [];
  for (const h of headings) {
    if (h.depth <= 1) continue;
    if (h.depth === 2) {
      top.push({ id: h.id, text: h.text, children: [] });
    } else if (h.depth === 3 && top.length > 0) {
      top[top.length - 1].children.push({ id: h.id, text: h.text, children: [] });
    }
  }
  return top;
}

async function buildGuide() {
  const source = join(repoRoot, 'vscode-ext', 'README.md');
  const markdown = await readFile(source, 'utf8');

  // One slugger for the whole document, so ids are unique across the page.
  const slug = createSlugger();
  const parsed = parseMarkdown(markdown, { slug });

  const title = parsed.blocks.find((b) => b.type === 'heading' && b.depth === 1)?.text ?? 'Documentation';
  const { blocks, applied } = applyDelta(parsed.blocks);
  const headings = parsed.headings.filter((h) => h.depth > 1);

  const ids = headings.map((h) => h.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    throw new Error(`duplicate heading ids in the product guide: ${[...new Set(dupes)].join(', ')}`);
  }

  return {
    source: 'vscode-ext/README.md',
    title,
    blocks,
    headings,
    toc: buildToc(headings),
    delta: applied,
  };
}

/**
 * Contextual links rendered beside matching agent-skill headings.
 *
 * `command` entries match on a backticked token inside the heading, because
 * skill headings carry descriptive suffixes ("`dor list` — find surfaces").
 * `prefix` entries match the heading text's opening words. Either way a rule
 * that matches zero or several headings fails the build, which is what keeps
 * the spec's "missing or ambiguous" guarantee meaningful.
 */
const SKILL_REFERENCES = [
  { prefix: 'Targeting', anchor: 'targeting' },
  { prefix: 'Surface handles', anchor: 'surface-handles' },
  { command: 'dor list', anchor: 'list' },
  { command: 'dor split', anchor: 'split' },
  { command: 'dor ensure', anchor: 'ensure' },
  { command: 'dor send', anchor: 'send' },
  { command: 'dor read', anchor: 'read' },
  { command: 'dor kill', anchor: 'kill' },
  { command: 'dor ab', anchor: 'agent-browser' },
  { command: 'dor iframe', anchor: 'iframe' },
];

/** Sections of dor/skill.md reused verbatim as the CLI page's introduction. */
const CLI_INTRO_SECTIONS = [
  { prefix: 'Targeting', id: 'targeting', title: 'Targeting' },
  { prefix: 'Surface handles', id: 'surface-handles', title: 'Surface handles' },
];

/** Backticked tokens inside a heading's inline nodes. */
function headingCodeTokens(heading) {
  return (heading.children ?? []).filter((n) => n.type === 'code').map((n) => n.value.trim());
}

/** Blocks belonging to a heading: everything up to the next heading of <= depth. */
function sectionBlocks(blocks, headingIndex) {
  const start = blocks[headingIndex];
  const out = [];
  for (let i = headingIndex + 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'heading' && b.depth <= start.depth) break;
    out.push(b);
  }
  return out;
}

async function buildCli(skill) {
  const helpDir = join(repoRoot, 'dor', 'test', 'snapshots', 'help');
  const files = (await readdir(helpDir)).filter((f) => f.endsWith('.md')).sort();

  const snapshots = new Map();
  for (const file of files) {
    const id = file.replace(/\.md$/, '');
    if (snapshots.has(id)) throw new MalformedSnapshotError(`duplicate command id "${id}"`);
    const parsed = parseSnapshot(await readFile(join(helpDir, file), 'utf8'), file);
    const nodes = parseHelp(parsed.raw);
    if (reconstruct(nodes) !== parsed.raw) {
      throw new MalformedSnapshotError(`${file}: parsed nodes do not reconstruct the raw help`);
    }
    snapshots.set(id, { id, file, ...parsed, nodes });
  }

  const root = snapshots.get('dor');
  if (!root) throw new MalformedSnapshotError('missing root help snapshot dor.md');

  // The root help owns command order and inventory.
  const inventory = rootCommandNames(root.nodes);
  const missing = inventory.filter((c) => !snapshots.has(c));
  if (missing.length > 0) {
    throw new MalformedSnapshotError(`root help lists commands with no snapshot: ${missing.join(', ')}`);
  }
  const extra = [...snapshots.keys()].filter((id) => id !== 'dor' && !inventory.includes(id));
  if (extra.length > 0) {
    throw new MalformedSnapshotError(`snapshots with no entry in root help: ${extra.join(', ')}`);
  }

  const toSection = (snap) => {
    const nodes = snap.nodes;
    const pick = (kind) => nodes.filter((n) => n.kind === kind);
    return {
      id: snap.id,
      title: snap.title,
      invocation: snap.invocation,
      usage: pick('usage').flatMap(usageLines),
      prose: pick('prose').flatMap(proseParagraphs),
      definitions: [...pick('flags'), ...pick('arguments'), ...pick('commands')].map((n) => ({
        label: n.label,
        rows: definitionRows(n),
      })),
      blocks: [...pick('examples'), ...pick('textOutput'), ...pick('jsonOutput')].map((n) => ({
        label: n.label,
        body: labelledBody(n),
      })),
      // The collapsed disclosure shows this byte for byte.
      raw: snap.raw,
    };
  };

  // Intro sections lifted from the skill, not re-authored here.
  const intro = CLI_INTRO_SECTIONS.map(({ prefix, id, title }) => {
    const matches = skill.parsed.blocks
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.type === 'heading' && b.text.startsWith(prefix));
    if (matches.length === 0) throw new Error(`CLI intro section "${prefix}" not found in dor/skill.md`);
    if (matches.length > 1) throw new Error(`CLI intro section "${prefix}" is ambiguous in dor/skill.md`);
    return { id, title, blocks: sectionBlocks(skill.parsed.blocks, matches[0].i) };
  });

  return {
    source: 'dor/test/snapshots/help/',
    intro,
    root: toSection(root),
    commands: inventory.map((name) => toSection(snapshots.get(name))),
  };
}

async function buildSkill() {
  const source = join(repoRoot, 'dor', 'skill.md');
  const markdown = await readFile(source, 'utf8');
  const slug = createSlugger();
  const parsed = parseMarkdown(markdown, { slug });
  return { source: 'dor/skill.md', markdown, parsed };
}

/** Attach a CLI reference link to each mapped skill heading. */
function linkSkillHeadings(skill, cli) {
  const anchors = new Set([...cli.intro.map((s) => s.id), 'dor', ...cli.commands.map((c) => c.id)]);
  const headings = skill.parsed.blocks.filter((b) => b.type === 'heading');
  const links = {};

  for (const rule of SKILL_REFERENCES) {
    if (!anchors.has(rule.anchor)) {
      throw new Error(`skill reference target "#${rule.anchor}" does not exist in the CLI reference`);
    }
    const matches = rule.command
      ? headings.filter((h) => headingCodeTokens(h).includes(rule.command))
      : headings.filter((h) => h.text.startsWith(rule.prefix));
    const label = rule.command ?? rule.prefix;
    if (matches.length === 0) throw new Error(`skill heading for "${label}" is missing`);
    if (matches.length > 1) throw new Error(`skill heading for "${label}" is ambiguous (${matches.length} matches)`);
    links[matches[0].id] = { href: `/docs/dor#${rule.anchor}`, label };
  }

  return links;
}

export async function generateDocs() {
  const guide = await buildGuide();
  const skill = await buildSkill();
  const cli = await buildCli(skill);
  const references = linkSkillHeadings(skill, cli);

  return {
    guide,
    cli,
    skill: {
      source: skill.source,
      markdown: skill.markdown,
      blocks: skill.parsed.blocks,
      headings: skill.parsed.headings,
      toc: buildToc(skill.parsed.headings),
      references,
    },
  };
}

async function main() {
  const data = await generateDocs();
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  const { guide, cli, skill } = data;
  console.log(
    `Wrote docs data: guide ${guide.headings.length} headings, ` +
      `cli ${cli.commands.length} commands + ${cli.intro.length} intro sections, ` +
      `skill ${Object.keys(skill.references).length} reference links`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`generate-docs failed: ${error.message}`);
    process.exit(1);
  });
}
