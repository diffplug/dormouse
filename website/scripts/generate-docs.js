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

import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSlugger,
  hasScheme,
  isProtocolRelative,
  parseMarkdown,
  slugify,
  visit,
} from './docs-parser.js';
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
 * Guide media lives next to the guide; the site serves a copy under /guide/.
 *
 * It is `vscode-ext/images/`, not `vscode-ext/media/`, because the latter is
 * the webview bundle's output directory — Vite empties it on every extension
 * build, which would delete anything committed there.
 *
 * The published copy gets `public/guide/` to itself, and `syncGuideMedia`
 * deletes that directory wholesale on every build. Nothing else may write
 * there; hand-authored site assets stay at `public/` root, where they are
 * tracked by git rather than swept away.
 *
 * Load-bearing beyond this repo: `vsce --baseImagesUrl` is passed
 * `SITE_IMAGE_BASE`, which turns the guide's `images/hero.jpg` into
 * `https://dormouse.sh/guide/images/hero.jpg` on the Marketplace and Open VSX,
 * so the listing's images 404 if the site stops serving these.
 */
const mediaSrcDir = join(repoRoot, 'vscode-ext', 'images');
const MEDIA_SRC_PREFIX = 'images/';
const mediaOutDir = join(__dirname, '..', 'public', 'guide', MEDIA_SRC_PREFIX);
const MEDIA_URL_BASE = `/guide/${MEDIA_SRC_PREFIX}`;
/** This site's own origin, as the canonical sources are forced to spell it. */
export const SITE_ORIGIN = 'https://dormouse.sh';
/**
 * What `vsce --baseImagesUrl` must be given, everywhere it is invoked.
 *
 * `vsce` resolves the guide's repo-relative `images/x` against this, so it is
 * the site copy's parent, not the directory itself. Pinned by
 * scripts/public-docs-lint.mjs -> checkImageBaseUrl.
 */
export const SITE_IMAGE_BASE = `${SITE_ORIGIN}/guide`;
/**
 * The repository's own file view, where anything not published here still reads.
 *
 * Two rewrites need it: a link into a section the delta withheld, and a link a
 * source spells relative to its own directory in the repository.
 */
export const REPO_BLOB_BASE = 'https://github.com/diffplug/dormouse/blob/main';
/**
 * Repository files this site publishes, by route. A link into one of them
 * resolves to the page rather than to GitHub, so a reader on the site stays on
 * the site, while the source keeps its repo-relative link — which
 * `scripts/spec-lint.mjs` verifies down to the fragment, as it cannot for a
 * URL. `assertRouteFragments` then holds the fragment against the page.
 */
export const SITE_ROUTES = {
  'SELF_HOST.md': '/docs/self-host',
  'docs/specs/security.md': '/docs/security',
};
/** Where the unpublished half of SELF_HOST.md is still readable. */
const SELF_HOST_CANONICAL_URL = `${REPO_BLOB_BASE}/SELF_HOST.md`;

/** Every page's shell supplies its own title and breadcrumb, so no published
 *  document keeps the `#` heading its file leads with. */
const DROP_DOCUMENT_TITLE = {
  id: 'drop-document-title',
  reason: 'The docs page shell supplies its own title and breadcrumb.',
  /** @param {{type: string, depth?: number}} block */
  match: (block) => block.type === 'heading' && block.depth === 1,
  operation: 'remove',
};

/**
 * The complete guide delta, per docs/specs/website-docs.md.
 *
 * The website applies only structural operations to the canonical README. Each
 * entry names exactly one target and fails the build when that target is absent
 * or ambiguous — no regexes over prose, no line-number patches.
 */
const DOCS_DELTA = [DROP_DOCUMENT_TITLE];

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
  DROP_DOCUMENT_TITLE,
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

/**
 * The complete security delta, per docs/specs/website-docs.md.
 *
 * docs/specs/security.md is published whole — the guarantees, what is not
 * defended, the gaps, and how each is checked are the point of the page — so
 * nothing but the file's own title and its spec front matter is withheld.
 */
const SECURITY_DELTA = [
  DROP_DOCUMENT_TITLE,
  {
    id: 'drop-front-matter',
    reason:
      'The opening blockquote is spec front matter — what the file owns and defers; the page shell says what the page is.',
    match: (block) => block.type === 'blockquote',
    operation: 'remove',
  },
];

/**
 * Sections of dor/skill.md reused verbatim as the CLI page's introduction.
 *
 * Each entry is the prefix its heading starts with — skill headings carry
 * descriptive suffixes ("Targeting: three ways to name a surface") — and is
 * also the section's title and, slugged, its anchor on /docs/dor.
 */
const CLI_INTRO_SECTIONS = ['Targeting', 'Surface handles'];

/**
 * The heading every command section sits under on /docs/dor.
 *
 * Emitted rather than spelled in the page, because the table of contents nests
 * every command under it and a parent whose id is not on the page links
 * nowhere; one record is what keeps the two the same id.
 */
const CLI_COMMANDS_SECTION = { id: 'commands', title: 'Commands' };

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

/**
 * Send links into the repository to the canonical file on GitHub.
 *
 * A source written next to the code it describes links its neighbours the way
 * GitHub resolves them — `./security-ci.md`, `../../SELF_HOST.md`. Published,
 * those resolve against a URL path that has no such neighbours, so each is
 * rewritten to the file's canonical URL in the repository, `#fragment` intact.
 *
 * A target that does not exist, or a path that climbs out of the repository,
 * fails the build. `scripts/spec-lint.mjs` already resolves relative links
 * inside the specs, but the generator is the last thing between a source and a
 * published page and must not depend on another lint having run.
 */
export function resolveRepoLinks(blocks, sourceFile) {
  const dir = posix.dirname(sourceFile);
  const rewritten = [];
  visit(blocks, (node) => {
    if (node.type !== 'link' || !node.href) return;
    // A bare fragment addresses this page; a scheme or `//host` addresses
    // somewhere else entirely. Neither names a file in the repository.
    if (node.href.startsWith('#') || hasScheme(node.href) || isProtocolRelative(node.href)) return;
    const hash = node.href.indexOf('#');
    const target = hash === -1 ? node.href : node.href.slice(0, hash);
    const fragment = hash === -1 ? '' : node.href.slice(hash);
    // `posix` and not `path`: these are repository paths in Markdown, which are
    // `/`-separated on every platform the build runs on. `join` normalizes, so
    // `docs/specs/../../SELF_HOST.md` arrives as `SELF_HOST.md`.
    const resolved = posix.join(dir, target);
    if (resolved.startsWith('..')) {
      throw new Error(`${sourceFile}: link "${node.href}" resolves outside the repository`);
    }
    if (!existsSync(join(repoRoot, resolved))) {
      throw new Error(`${sourceFile}: link "${node.href}" resolves to ${resolved}, which does not exist`);
    }
    const from = node.href;
    const route = SITE_ROUTES[resolved];
    node.href = route ? `${route}${fragment}` : `${REPO_BLOB_BASE}/${resolved}${fragment}`;
    // Provenance for anything that classifies by what a link names — the
    // security audiences below — since the href no longer says.
    node.repoPath = resolved;
    rewritten.push({ from, to: node.href });
  });
  return rewritten;
}

/** A link into a page this site publishes must name a heading that page renders. */
export function assertRouteFragments(pages) {
  const pageByRoute = new Map(
    Object.entries(SITE_ROUTES).map(([file, route]) => [route, pages.find((page) => page.source === file)]),
  );
  for (const page of pages) {
    visit(page.blocks, (node) => {
      if (node.type !== 'link' || !node.href) return;
      const hash = node.href.indexOf('#');
      if (hash === -1) return;
      const target = pageByRoute.get(node.href.slice(0, hash));
      if (!target) return;
      const id = node.href.slice(hash + 1);
      if (!target.headings.some((h) => h.id === id)) {
        throw new Error(`${page.source}: link "${node.href}" names no heading on ${node.href.slice(0, hash)}`);
      }
    });
  }
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
    if (hasScheme(node.src) || node.src.startsWith('/')) {
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

/**
 * One published page from one canonical Markdown file.
 *
 * Every Markdown page needs the same steps in the same order, and the only
 * difference is an option: `canonicalUrl` sends links into withheld sections
 * off-site rather than leaving them dangling. Written once because two copies
 * of this had already drifted on the order of the last three steps, which is
 * how one page quietly loses a guarantee the other still has.
 *
 * The three link rewrites run in one fixed order: a withheld section's anchor
 * goes off-site first, then a repository-relative path becomes a canonical
 * GitHub URL, and only then is a link that happens to address this site's own
 * origin localized like any other.
 */
async function buildDocument({ file, delta, label, fallbackTitle, canonicalUrl }) {
  const markdown = await readFile(join(repoRoot, file), 'utf8');

  // One slugger for the whole document, so ids are unique across the page.
  const parsed = parseMarkdown(markdown, { slug: createSlugger() });
  const title = parsed.blocks.find((b) => b.type === 'heading' && b.depth === 1)?.text ?? fallbackTitle;

  const { blocks, applied, removedIds } = applyDelta(parsed.blocks, delta, label);
  // Derived from the post-delta tree, so the delta is expressed once: whatever
  // it removes disappears from the heading inventory and the TOC for free.
  const headings = headingsOf(blocks);
  assertUniqueIds(headings.map((h) => h.id), label);

  // Every rewrite runs before the assertion: a link into a withheld section is
  // not dangling once it has gained the origin that still serves it.
  const withheldLinks = canonicalUrl ? resolveRemovedAnchors(blocks, removedIds, canonicalUrl) : [];
  const repoLinks = resolveRepoLinks(blocks, file);
  const localizedLinks = localizeSiteLinks(blocks);
  assertAnchorsResolve(blocks, headings, label);

  return {
    source: file,
    title,
    blocks,
    headings,
    toc: buildToc(headings),
    delta: applied,
    withheldLinks,
    repoLinks,
    localizedLinks,
  };
}

async function buildGuide() {
  const page = await buildDocument({
    file: 'vscode-ext/README.md',
    delta: DOCS_DELTA,
    label: '/docs',
    fallbackTitle: 'Documentation',
  });
  const available = (await readdir(mediaSrcDir)).sort();
  return { ...page, media: { available, ...resolveGuideMedia(page.blocks, available) } };
}

/**
 * `/docs/self-host` from SELF_HOST.md, minus the halves the delta withholds.
 *
 * The file stays canonical: an assistant reads it in a checkout, and
 * `scripts/deploy-lint.mjs` audits its Installer contract against
 * `deploy/local/`. Publishing a copy would mean two files to keep true about
 * how a server is installed.
 */
const buildSelfHost = () =>
  buildDocument({
    file: 'SELF_HOST.md',
    delta: SELF_HOST_DELTA,
    label: '/docs/self-host',
    fallbackTitle: 'Self-host',
    canonicalUrl: SELF_HOST_CANONICAL_URL,
  });

/**
 * Which page carries which of the security spec's rows and bullets.
 *
 * `/docs/security`, `/docs/self-host`, and `/supply-chain` each show the part
 * of the spec a reader there relies on, rendered from this data rather than
 * restated — the spec is what the nightly audit reads, and a hand-written copy
 * in a page is the one that rots. The umbrella page is one audience among
 * three: the local application and the pipeline; the spec file on GitHub is
 * the one place every row appears together. A guarantee row, an undefended edge, or a known gap belongs to
 * the audience of the spec its links name, and every link in one entry must
 * agree. An entry naming no spec, a spec in neither group, or both groups
 * fails the build: the spec's own pointers are the classification, so a new
 * spec has to be placed here before its rows can publish anywhere but the
 * umbrella.
 */
export const SECURITY_AUDIENCES = {
  security: ['docs/specs/security-local.md', 'docs/specs/security-ci.md', 'docs/specs/security-audit.md'],
  'self-host': ['docs/specs/remote-security-model.md', 'docs/specs/security-remote.md', 'SELF_HOST.md'],
  'supply-chain': ['docs/specs/security-supply-chain.md'],
};

/** The umbrella sections that split by audience, and the block each splits. */
const SECURITY_AUDIENCE_SECTIONS = [
  { key: 'guarantees', title: 'Guarantees', block: 'table', entries: 'rows' },
  { key: 'notDefended', title: 'What is not defended', block: 'list', entries: 'items' },
  { key: 'knownGaps', title: 'Known gaps', block: 'list', entries: 'items' },
];

function audienceOf(entry, label) {
  const paths = [];
  visit(entry, (node) => {
    if (node.type === 'link' && node.repoPath) paths.push(node.repoPath);
  });
  if (paths.length === 0) throw new Error(`${label} names no spec, so it belongs to no audience`);
  const audiences = new Set(
    paths.map((path) => Object.keys(SECURITY_AUDIENCES).find((a) => SECURITY_AUDIENCES[a].includes(path))),
  );
  if (audiences.size !== 1 || audiences.has(undefined)) {
    throw new Error(`${label} links ${paths.join(', ')}, which do not name exactly one audience`);
  }
  return [...audiences][0];
}

/** The three blocks the audiences split, each found under its own heading. */
function securitySections(page) {
  const headings = page.blocks.filter((b) => b.type === 'heading');
  return SECURITY_AUDIENCE_SECTIONS.map(({ key, title, block: type, entries }) => {
    const heading = findExactlyOneHeading(headings, (h) => h.text === title, title);
    const block = sectionBlocks(page.blocks, heading).find((b) => b.type === type);
    if (!block) throw new Error(`/docs/security: "${title}" has no ${type} to split by audience`);
    return { key, title, block, entries };
  });
}

export function securityAudiences(page) {
  const out = Object.fromEntries(Object.keys(SECURITY_AUDIENCES).map((a) => [a, {}]));
  for (const { key, title, block, entries } of securitySections(page)) {
    const split = new Map(Object.keys(out).map((a) => [a, []]));
    block[entries].forEach((entry, i) => {
      split.get(audienceOf(entry, `/docs/security: "${title}" entry ${i + 1}`)).push(entry);
    });
    for (const [audience, mine] of split) out[audience][key] = { ...block, [entries]: mine };
  }
  return out;
}

/** The umbrella's blocks with the three split blocks narrowed to one audience. */
export function audienceBlocks(page, audiences, audience) {
  const swap = new Map(securitySections(page).map(({ key, block }) => [block, audiences[audience][key]]));
  return page.blocks.map((block) => swap.get(block) ?? block);
}

/**
 * `/docs/security` from docs/specs/security.md, every section of it.
 *
 * The file stays canonical in `docs/specs/`: it is a spec, so
 * `scripts/spec-lint.mjs` budgets it and the nightly audit reads it. No
 * `canonicalUrl`, because the delta removes no section — the page is the spec,
 * which is the point of publishing it. `pageBlocks` is the same document with
 * the three split blocks narrowed to the umbrella's own audience; `blocks`
 * keeps every entry, for the two pages that render the other two audiences.
 */
const buildSecurity = async () => {
  const page = await buildDocument({
    file: 'docs/specs/security.md',
    delta: SECURITY_DELTA,
    label: '/docs/security',
    fallbackTitle: 'Security',
  });
  const audiences = securityAudiences(page);
  return { ...page, audiences, pageBlocks: audienceBlocks(page, audiences, 'security') };
};

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
  const intro = CLI_INTRO_SECTIONS.map((prefix) => {
    const heading = findExactlyOneHeading(skillHeadings, (h) => h.text.startsWith(prefix), prefix);
    return { id: slugify(prefix), title: prefix, blocks: sectionBlocks(skill.blocks, heading) };
  });

  const rootSection = toSection(root);
  const commands = inventory.map((name) => toSection(snapshots.get(name)));

  // Every id addressable on /docs/dor, from all of its sources: the intro
  // sections, the root section, the Commands heading, the command sections,
  // and any heading inside a lifted intro block. Nothing else may collide with
  // a command anchor that SKILL_REFERENCES links into.
  const anchors = [
    ...intro.map((s) => s.id),
    ...intro.flatMap((s) => headingsOf(s.blocks).map((h) => h.id)),
    'dor',
    CLI_COMMANDS_SECTION.id,
    ...commands.map((c) => c.id),
  ];
  assertUniqueIds(anchors, '/docs/dor');

  // Emitted, not assembled in the page: every docs page reads `toc` off its own
  // data file, so the table of contents has one owner for all three. The
  // commands nest one level down, so the rail shows this page as four entries
  // rather than fourteen.
  const entry = ({ id, title }) => ({ id, text: title, children: [] });
  const toc = [
    ...intro.map(entry),
    entry(rootSection),
    { ...entry(CLI_COMMANDS_SECTION), children: commands.map(entry) },
  ];

  return {
    source: 'dor/test/snapshots/help/',
    intro,
    root: rootSection,
    commandsHeading: CLI_COMMANDS_SECTION,
    commands,
    anchors,
    toc,
  };
}

async function buildSkill() {
  const markdown = await readFile(join(repoRoot, 'dor', 'skill.md'), 'utf8');
  const parsed = parseMarkdown(markdown, { slug: createSlugger() });
  // Before buildCli lifts its intro sections out of these same block objects,
  // so /docs/dor inherits the rewrite rather than needing its own.
  const localizedLinks = localizeSiteLinks(parsed.blocks);
  return { source: 'dor/skill.md', blocks: parsed.blocks, headings: parsed.headings, localizedLinks };
}

/**
 * Attach a CLI reference link to each skill heading that has a counterpart.
 *
 * Derived, never listed. The prose sections come from CLI_INTRO_SECTIONS; a
 * command section is any skill heading whose backticked tokens name a `dor`
 * subcommand, so documenting a new command in dor/skill.md earns its link with
 * no table to remember. A heading that names a subcommand with no section on
 * /docs/dor fails the build rather than publishing silently unlinked — the one
 * failure a hardcoded list could not see.
 */
function linkSkillHeadings(skill, cli) {
  const anchors = new Set(cli.anchors);
  const headings = skill.blocks.filter((b) => b.type === 'heading');
  const links = {};

  for (const prefix of CLI_INTRO_SECTIONS) {
    const anchor = slugify(prefix);
    if (!anchors.has(anchor)) {
      throw new Error(`skill reference target "#${anchor}" does not exist in the CLI reference`);
    }
    const heading = findExactlyOneHeading(headings, (h) => h.text.startsWith(prefix), prefix);
    links[heading.id] = { href: `/docs/dor#${anchor}`, label: prefix };
  }

  for (const heading of headings) {
    // A heading may name a command more than one way ("`dor ab` /
    // `dor agent-browser`"). It is labelled by the spelling it leads with and
    // linked to the first that has a section.
    const named = headingCodeTokens(heading)
      .map((token) => /^dor (\S+)$/.exec(token)?.[1])
      .filter((name) => name !== undefined);
    if (named.length === 0) continue;
    const anchor = named.find((name) => anchors.has(name));
    if (anchor === undefined) {
      throw new Error(
        `skill heading "${heading.text}" names dor ${named.join('/')}, which has no section in the CLI reference`,
      );
    }
    links[heading.id] = { href: `/docs/dor#${anchor}`, label: `dor ${named[0]}` };
  }

  return links;
}

export async function generateDocs() {
  const guide = await buildGuide();
  const selfhost = await buildSelfHost();
  const security = await buildSecurity();
  assertRouteFragments([guide, selfhost, security]);
  const skill = await buildSkill();
  const cli = await buildCli(skill);
  const references = linkSkillHeadings(skill, cli);

  return {
    guide,
    selfhost,
    security,
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
  const { guide, selfhost, security, cli, skill } = data;
  const markdownPages = [guide, selfhost, security];
  console.log(
    `Wrote docs data: guide ${guide.headings.length} headings, ` +
      `self-host ${selfhost.headings.length} headings (${selfhost.delta.length} delta rules), ` +
      `security ${security.headings.length} headings (${security.delta.length} delta rules), ` +
      `cli ${cli.commands.length} commands + ${cli.intro.length} intro sections, ` +
      `skill ${Object.keys(skill.references).length} reference links, ` +
      `${guide.media.available.length} media file(s), ` +
      `${markdownPages.reduce((n, page) => n + page.repoLinks.length, 0)} link(s) sent to the repository, ` +
      `${markdownPages.reduce((n, page) => n + page.localizedLinks.length, 0) + skill.localizedLinks.length} link(s) localized`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`generate-docs failed: ${error.message}`);
    process.exit(1);
  });
}
