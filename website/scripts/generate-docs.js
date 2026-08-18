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

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSlugger, parseMarkdown } from './docs-parser.js';

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

export async function generateDocs() {
  return { guide: await buildGuide() };
}

async function main() {
  const data = await generateDocs();
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  const { guide } = data;
  console.log(
    `Wrote docs data: guide "${guide.title}" (${guide.blocks.length} blocks, ${guide.headings.length} headings, ${guide.delta.length} delta op(s))`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`generate-docs failed: ${error.message}`);
    process.exit(1);
  });
}
