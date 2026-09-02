/**
 * Build-time codegen for the public documentation pages.
 *
 * Reads the canonical sources, parses them with the in-repo Markdown parser,
 * and writes one gitignored data file per document. Browser code never imports
 * Dor implementation modules (they use Node APIs) or reads Markdown at runtime
 * — everything it needs is in the generated JSON, split per document so
 * /docs/dor does not ship the agent skill along with it.
 *
 * The guide half of this pipeline has no page of its own right now (see
 * docs/specs/website-docs.md -> Canonical product guide). It is kept whole and
 * still runs on every build, because the guide's media sync is what puts
 * vscode-ext/images/ on dormouse.sh, where the packaged Marketplace listing
 * loads its images from, and because the guide data is what a future page
 * would render.
 *
 * Wired into website `predev` / `pretest` / `prebuild`, mirroring
 * generate-changelog.js.
 *
 * See docs/specs/website-docs.md.
 */

import { readFile, readdir, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSlugger, parseMarkdown, visit } from './docs-parser.js';
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
const dataDir = join(__dirname, '..', 'src', 'data');
/**
 * Guide media lives next to the guide; the site serves a copy at /images/.
 *
 * It is `images/`, not `media/`, because `vscode-ext/media/` is the webview
 * bundle's output directory — Vite empties it on every extension build, which
 * would delete anything committed there.
 *
 * Load-bearing beyond this repo: `vsce --baseImagesUrl https://dormouse.sh`
 * turns the guide's `images/hero.jpg` into `https://dormouse.sh/images/hero.jpg`
 * on the Marketplace and Open VSX, so the listing's images 404 if the site
 * stops serving these.
 */
const mediaSrcDir = join(repoRoot, 'vscode-ext', 'images');
const mediaOutDir = join(__dirname, '..', 'public', 'images');
const MEDIA_URL_BASE = '/images/';
const MEDIA_SRC_PREFIX = 'images/';
/** This site's own origin, as the canonical sources are forced to spell it. */
const SITE_ORIGIN = 'https://dormouse.sh';
/** Where the unpublished half of SELF_HOST.md is still readable. */
const SELF_HOST_CANONICAL_URL = 'https://github.com/diffplug/dormouse/blob/main/SELF_HOST.md';

/**
 * The complete guide delta, per docs/specs/website-docs.md.
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

/** Match the one heading whose text is exactly `text`. */
const headingNamed = (text) => (block) => block.type === 'heading' && block.text === text;

/**
 * The complete self-host delta, per docs/specs/website-docs.md.
 *
 * SELF_HOST.md is two documents in one file: a runbook a reader can follow,
 * and material addressed to the assistant running it or to a maintainer of
 * `deploy/local/`. Only the runbook is published; the rest is removed here
 * rather than split out of the file, because the assistant reading
 * `@SELF_HOST.md` in a checkout needs all of it in one place.
 */
const SELF_HOST_DELTA = [
  {
    id: 'drop-document-title',
    reason: 'The docs page shell supplies its own title and breadcrumb.',
    match: (block) => block.type === 'heading' && block.depth === 1,
    operation: 'remove',
  },
  {
    id: 'drop-repo-invocation',
    reason: 'The opening blockquote tells a reader to open the file in a checkout.',
    match: (block) => block.type === 'blockquote',
    operation: 'remove',
  },
  {
    id: 'drop-assistant-instructions',
    reason: 'Addressed to the assistant running the runbook, not to a reader.',
    match: headingNamed('Instructions to the assistant'),
    operation: 'remove-section',
  },
  {
    id: 'drop-final-handoff',
    reason: 'Tells the assistant what to report back; meaningless on a page.',
    match: headingNamed('Final handoff'),
    operation: 'remove-section',
  },
  {
    id: 'drop-installer-contract',
    reason: 'The maintainer half of the file, audited by scripts/deploy-lint.mjs.',
    match: headingNamed('Installer contract (maintainers)'),
    operation: 'remove-section',
  },
];

/** Sections of dor/skill.md reused verbatim as the CLI page's introduction. */
const CLI_INTRO_SECTIONS = [
  { prefix: 'Targeting', id: 'targeting', title: 'Targeting' },
  { prefix: 'Surface handles', id: 'surface-handles', title: 'Surface handles' },
];

/**
 * Contextual links rendered beside matching agent-skill headings.
 *
 * The prose half is derived from CLI_INTRO_SECTIONS so a renamed skill section
 * is edited in one table, not two. `command` entries match on a backticked
 * token inside the heading, because skill headings carry descriptive suffixes
 * ("`dor list` — find surfaces").
 */
const SKILL_REFERENCES = [
  ...CLI_INTRO_SECTIONS.map((section) => ({ prefix: section.prefix, anchor: section.id })),
  { command: 'dor list', anchor: 'list' },
  { command: 'dor split', anchor: 'split' },
  { command: 'dor ensure', anchor: 'ensure' },
  { command: 'dor send', anchor: 'send' },
  { command: 'dor read', anchor: 'read' },
  { command: 'dor kill', anchor: 'kill' },
  { command: 'dor ab', anchor: 'agent-browser' },
  { command: 'dor iframe', anchor: 'iframe' },
];

/**
 * Apply one document's delta.
 *
 * `remove` drops the single matched block. `remove-section` drops a matched
 * heading and everything under it — every following block up to the next
 * heading of the same or shallower depth — so removing `## X` takes its `###`
 * subsections with it.
 *
 * Every rule must match exactly one block, and a rule that matches nothing
 * fails the build: a section renamed in the canonical source must be a
 * decision, not a silent republication of what the delta meant to withhold.
 *
 * Returns the ids the delta removed, so the caller can find links left
 * pointing at them.
 */
export function applyDelta(blocks, rules, label) {
  const applied = [];
  const removedIds = [];
  let result = blocks;

  for (const rule of rules) {
    const matches = result.filter(rule.match);
    if (matches.length === 0) {
      throw new Error(`${label} delta "${rule.id}" matched nothing; its target is gone`);
    }
    if (matches.length > 1) {
      throw new Error(`${label} delta "${rule.id}" matched ${matches.length} blocks; target is ambiguous`);
    }
    const [target] = matches;

    let dropped;
    if (rule.operation === 'remove') {
      dropped = [target];
    } else if (rule.operation === 'remove-section') {
      if (target.type !== 'heading') {
        throw new Error(`${label} delta "${rule.id}" is remove-section but matched a ${target.type}`);
      }
      dropped = [target, ...sectionBlocks(result, target)];
    } else {
      throw new Error(`${label} delta "${rule.id}" has unknown operation "${rule.operation}"`);
    }

    const gone = new Set(dropped);
    result = result.filter((b) => !gone.has(b));
    for (const block of dropped) {
      visit([block], (node) => {
        if (node.type === 'heading') removedIds.push(node.id);
      });
    }
    applied.push({
      id: rule.id,
      reason: rule.reason,
      operation: rule.operation,
      target: target.text ?? null,
      blocks: dropped.length,
    });
  }

  return { blocks: result, applied, removedIds };
}

/**
 * Send in-document links that the delta orphaned to the canonical file.
 *
 * A `#anchor` into a removed section would otherwise scroll nowhere. The
 * surviving prose still has a reason to point there — the material exists, it
 * just isn't published here — so the link keeps its text and gains the origin
 * that still serves it.
 */
function resolveRemovedAnchors(blocks, removedIds, canonicalUrl) {
  const removed = new Set(removedIds);
  const rewritten = [];
  visit(blocks, (node) => {
    if (node.type !== 'link' || !node.href?.startsWith('#')) return;
    const id = node.href.slice(1);
    if (!removed.has(id)) return;
    node.href = `${canonicalUrl}#${id}`;
    rewritten.push({ from: `#${id}`, to: node.href });
  });
  return rewritten;
}

/** No `#anchor` link may point at an id the page does not contain. */
function assertAnchorsResolve(blocks, headings, where) {
  const ids = new Set(headings.map((h) => h.id));
  const dangling = [];
  visit(blocks, (node) => {
    if (node.type !== 'link' || !node.href?.startsWith('#')) return;
    if (!ids.has(node.href.slice(1))) dangling.push(node.href);
  });
  if (dangling.length > 0) {
    throw new Error(`dangling anchor link(s) on ${where}: ${[...new Set(dangling)].join(', ')}`);
  }
}

/** Headings that survive the delta, in document order. */
function headingsOf(blocks) {
  const headings = [];
  visit(blocks, (node) => {
    if (node.type === 'heading') headings.push({ depth: node.depth, id: node.id, text: node.text });
  });
  return headings;
}

/** Nested table of contents from an already-filtered heading list. */
function buildToc(headings) {
  const top = [];
  for (const h of headings) {
    if (h.depth === 2) {
      top.push({ id: h.id, text: h.text, children: [] });
    } else if (h.depth === 3 && top.length > 0) {
      top[top.length - 1].children.push({ id: h.id, text: h.text, children: [] });
    }
  }
  return top;
}

/** Fail unless exactly one heading matches, naming the rule that looked. */
function findExactlyOneHeading(headings, predicate, label) {
  const matches = headings.filter(predicate);
  if (matches.length === 0) throw new Error(`no heading matches "${label}"`);
  if (matches.length > 1) throw new Error(`heading "${label}" is ambiguous (${matches.length} matches)`);
  return matches[0];
}

/** Fail on any duplicate id, so a page's anchors stay addressable. */
function assertUniqueIds(ids, where) {
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupes.length > 0) throw new Error(`duplicate anchor ids on ${where}: ${dupes.join(', ')}`);
}

/**
 * Rewrite the guide's relative image sources to the path the site serves, and
 * report which media files were actually used.
 *
 * The README is the source of truth and references images the way GitHub
 * expects — repo-relative — so dropping a file into vscode-ext/images/ and
 * linking it just works on GitHub, in the packaged extension, and here.
 */
function resolveGuideMedia(blocks, available) {
  const used = new Set();
  visit(blocks, (node) => {
    if (node.type !== 'image' || !node.src) return;
    if (/^[a-z][a-z0-9+.-]*:|^\//i.test(node.src)) {
      throw new Error(`guide image "${node.src}" must be a repo-relative local file`);
    }
    const rel = node.src.replace(/^\.\//, '');
    if (!rel.startsWith(MEDIA_SRC_PREFIX)) {
      throw new Error(`guide image "${node.src}" must live under vscode-ext/${MEDIA_SRC_PREFIX}`);
    }
    const file = rel.slice(MEDIA_SRC_PREFIX.length);
    if (!available.includes(file)) {
      throw new Error(`guide references ${rel}, which is not in vscode-ext/${MEDIA_SRC_PREFIX}`);
    }
    used.add(file);
    node.src = MEDIA_URL_BASE + file;
  });
  return { used: [...used], unused: available.filter((f) => !used.has(f)) };
}

/**
 * Rewrite links that point back at this site to root-relative paths.
 *
 * The canonical sources spell these absolutely on purpose: the Marketplace,
 * Open VSX, and GitHub all render them away from this origin, where a relative
 * path means nothing (see docs/specs/website-docs.md -> Marketplace and Open
 * VSX constraints). On the site itself the same URL is a bug — every click
 * leaves the origin, so a link followed from a dev server lands on production.
 *
 * Only the origin is dropped; path, query, and fragment survive verbatim, so
 * `.../docs/dor#agent-browser` keeps its deep link.
 */
function localizeSiteLinks(blocks) {
  const localized = [];
  visit(blocks, (node) => {
    if (node.type !== 'link' || !node.href) return;
    // Relative hrefs and bare fragments are already local; a non-HTTP scheme
    // (mailto:, vscode:) has no origin to compare and must be left alone.
    if (!/^https?:\/\//i.test(node.href)) return;
    const url = new URL(node.href);
    if (url.origin !== SITE_ORIGIN) return;
    const from = node.href;
    node.href = `${url.pathname}${url.search}${url.hash}`;
    localized.push({ from, to: node.href });
  });
  return localized;
}

/**
 * Copy the guide's media next to the site. Only `main()` should call this.
 *
 * Required by the Marketplace listing, not by any page here — see mediaSrcDir.
 */
async function syncGuideMedia(files) {
  await rm(mediaOutDir, { recursive: true, force: true });
  await mkdir(mediaOutDir, { recursive: true });
  await Promise.all(files.map((f) => copyFile(join(mediaSrcDir, f), join(mediaOutDir, f))));
}

async function buildGuide() {
  const markdown = await readFile(join(repoRoot, 'vscode-ext', 'README.md'), 'utf8');

  // One slugger for the whole document, so ids are unique across the page.
  const parsed = parseMarkdown(markdown, { slug: createSlugger() });
  const title = parsed.blocks.find((b) => b.type === 'heading' && b.depth === 1)?.text ?? 'Documentation';

  const { blocks, applied } = applyDelta(parsed.blocks, DOCS_DELTA, '/docs');
  // Derived from the post-delta tree, so the delta is expressed once: whatever
  // it removes disappears from the heading inventory and the TOC for free.
  const headings = headingsOf(blocks);
  assertUniqueIds(headings.map((h) => h.id), '/docs');
  assertAnchorsResolve(blocks, headings, '/docs');

  const available = (await readdir(mediaSrcDir)).sort();
  const media = resolveGuideMedia(blocks, available);
  const localizedLinks = localizeSiteLinks(blocks);

  return {
    source: 'vscode-ext/README.md',
    title,
    blocks,
    headings,
    toc: buildToc(headings),
    delta: applied,
    media: { available, ...media },
    localizedLinks,
  };
}

/**
 * `/docs/self-host` from SELF_HOST.md, minus the halves the delta withholds.
 *
 * The file stays canonical: an assistant reads it in a checkout, and
 * `scripts/deploy-lint.mjs` audits its Installer contract against
 * `deploy/local/`. Publishing a copy would mean two files to keep true about
 * how a server is installed.
 */
async function buildSelfHost() {
  const markdown = await readFile(join(repoRoot, 'SELF_HOST.md'), 'utf8');

  const parsed = parseMarkdown(markdown, { slug: createSlugger() });
  const title = parsed.blocks.find((b) => b.type === 'heading' && b.depth === 1)?.text ?? 'Self-host';

  const { blocks, applied, removedIds } = applyDelta(parsed.blocks, SELF_HOST_DELTA, '/docs/self-host');
  const headings = headingsOf(blocks);
  assertUniqueIds(headings.map((h) => h.id), '/docs/self-host');

  const withheldLinks = resolveRemovedAnchors(blocks, removedIds, SELF_HOST_CANONICAL_URL);
  const localizedLinks = localizeSiteLinks(blocks);
  assertAnchorsResolve(blocks, headings, '/docs/self-host');

  return {
    source: 'SELF_HOST.md',
    title,
    blocks,
    headings,
    toc: buildToc(headings),
    delta: applied,
    withheldLinks,
    localizedLinks,
  };
}

/** Blocks belonging to a heading: everything up to the next heading of <= depth. */
function sectionBlocks(blocks, heading) {
  const start = blocks.indexOf(heading);
  const out = [];
  for (let i = start + 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'heading' && b.depth <= heading.depth) break;
    out.push(b);
  }
  return out;
}

/** Backticked tokens inside a heading's inline nodes. */
function headingCodeTokens(heading) {
  return (heading.children ?? []).filter((n) => n.type === 'code').map((n) => n.value.trim());
}

async function buildCli(skill) {
  const helpDir = join(repoRoot, 'dor', 'test', 'snapshots', 'help');
  const files = (await readdir(helpDir)).filter((f) => f.endsWith('.md')).sort();
  const texts = await Promise.all(files.map((f) => readFile(join(helpDir, f), 'utf8')));

  const snapshots = new Map();
  files.forEach((file, i) => {
    const id = file.replace(/\.md$/, '');
    if (snapshots.has(id)) throw new MalformedSnapshotError(`duplicate command id "${id}"`);
    const parsed = parseSnapshot(texts[i], file);
    const nodes = parseHelp(parsed.raw);
    if (reconstruct(nodes) !== parsed.raw) {
      throw new MalformedSnapshotError(`${file}: parsed nodes do not reconstruct the raw help`);
    }
    snapshots.set(id, { id, file, ...parsed, nodes });
  });

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
    const pick = (kind) => snap.nodes.filter((n) => n.kind === kind);
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
  const skillHeadings = skill.blocks.filter((b) => b.type === 'heading');
  const intro = CLI_INTRO_SECTIONS.map(({ prefix, id, title }) => {
    const heading = findExactlyOneHeading(skillHeadings, (h) => h.text.startsWith(prefix), prefix);
    return { id, title, blocks: sectionBlocks(skill.blocks, heading) };
  });

  const commands = inventory.map((name) => toSection(snapshots.get(name)));

  // Every id addressable on /docs/dor, from all three of its sources: the
  // intro sections, the root section, the command sections, and any heading
  // inside a lifted intro block. Nothing else may collide with a command
  // anchor that SKILL_REFERENCES links into.
  const anchors = [
    ...intro.map((s) => s.id),
    ...intro.flatMap((s) => headingsOf(s.blocks).map((h) => h.id)),
    'dor',
    ...commands.map((c) => c.id),
  ];
  assertUniqueIds(anchors, '/docs/dor');

  return { source: 'dor/test/snapshots/help/', intro, root: toSection(root), commands, anchors };
}

async function buildSkill() {
  const markdown = await readFile(join(repoRoot, 'dor', 'skill.md'), 'utf8');
  const parsed = parseMarkdown(markdown, { slug: createSlugger() });
  // Before buildCli lifts its intro sections out of these same block objects,
  // so /docs/dor inherits the rewrite rather than needing its own.
  const localizedLinks = localizeSiteLinks(parsed.blocks);
  return { source: 'dor/skill.md', blocks: parsed.blocks, headings: parsed.headings, localizedLinks };
}

/** Attach a CLI reference link to each mapped skill heading. */
function linkSkillHeadings(skill, cli) {
  const anchors = new Set(cli.anchors);
  const headings = skill.blocks.filter((b) => b.type === 'heading');
  const links = {};

  for (const rule of SKILL_REFERENCES) {
    if (!anchors.has(rule.anchor)) {
      throw new Error(`skill reference target "#${rule.anchor}" does not exist in the CLI reference`);
    }
    const label = rule.command ?? rule.prefix;
    const heading = findExactlyOneHeading(
      headings,
      rule.command
        ? (h) => headingCodeTokens(h).includes(rule.command)
        : (h) => h.text.startsWith(rule.prefix),
      label,
    );
    links[heading.id] = { href: `/docs/dor#${rule.anchor}`, label };
  }

  return links;
}

export async function generateDocs() {
  const guide = await buildGuide();
  const selfhost = await buildSelfHost();
  const skill = await buildSkill();
  const cli = await buildCli(skill);
  const references = linkSkillHeadings(skill, cli);

  return {
    guide,
    selfhost,
    cli,
    skill: {
      source: skill.source,
      blocks: skill.blocks,
      headings: skill.headings,
      localizedLinks: skill.localizedLinks,
      toc: buildToc(skill.headings.filter((h) => h.depth > 1)),
      references,
    },
  };
}

async function main() {
  const data = await generateDocs();
  await mkdir(dataDir, { recursive: true });
  // One file per page: importing a single combined module made every docs
  // route ship all three documents in one shared chunk.
  await Promise.all([
    ...Object.entries(data).map(([name, value]) =>
      writeFile(join(dataDir, `docs.${name}.json`), `${JSON.stringify(value, null, 2)}\n`, 'utf8'),
    ),
    syncGuideMedia(data.guide.media.available),
  ]);
  const { guide, selfhost, cli, skill } = data;
  console.log(
    `Wrote docs data: guide ${guide.headings.length} headings, ` +
      `self-host ${selfhost.headings.length} headings (${selfhost.delta.length} delta rules), ` +
      `cli ${cli.commands.length} commands + ${cli.intro.length} intro sections, ` +
      `skill ${Object.keys(skill.references).length} reference links, ` +
      `${guide.media.available.length} media file(s), ` +
      `${guide.localizedLinks.length + selfhost.localizedLinks.length + skill.localizedLinks.length} link(s) localized`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`generate-docs failed: ${error.message}`);
    process.exit(1);
  });
}
