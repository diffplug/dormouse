#!/usr/bin/env node
/**
 * Public documentation lint.
 *
 * Checks the contracts in docs/specs/website-docs.md that are mechanically
 * checkable. Nuanced product prose is deliberately NOT checked with phrase
 * blacklists — when a public feature section changes, review it against its
 * owning spec instead.
 *
 * Every inventory here is derived from the file that owns it rather than
 * restated: the guide's sections from the spec, the reference pages from the
 * route table's own list, the image base from the generator. A lint that
 * carries its own copy of a list is a second owner, and the copy is the one
 * that rots.
 *
 * Run by the root `pnpm test`.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoRoot, readRepoFile, trackedFiles } from './lint-kit.mjs';
import {
  hasScheme,
  isProtocolRelative,
  parseMarkdown,
  visit,
  UnsupportedMarkdownError,
} from '../website/scripts/docs-parser.js';
import { generateDocs, SITE_ORIGIN, SITE_IMAGE_BASE } from '../website/scripts/generate-docs.js';

const failures = [];
const fail = (msg) => failures.push(msg);

const GUIDE = 'vscode-ext/README.md';
const ROOT_README = 'README.md';
const SKILL = 'dor/skill.md';
const SELF_HOST = 'SELF_HOST.md';
const HOMEPAGE = 'website/src/pages/Home.tsx';
const SPEC = 'docs/specs/website-docs.md';
const DOCS_PAGES = 'website/src/lib/docs-pages.ts';
const ROOT_ROUTE = 'website/src/root.tsx';
const SITE_META = 'website/src/lib/site-meta.ts';

/** Each source read once and parsed once, then shared by every check. */
const src = {
  [GUIDE]: readRepoFile(GUIDE),
  [ROOT_README]: readRepoFile(ROOT_README),
  [SKILL]: readRepoFile(SKILL),
  [SELF_HOST]: readRepoFile(SELF_HOST),
  [HOMEPAGE]: readRepoFile(HOMEPAGE),
};

/** Parsed form, or null when the source is outside the supported subset. */
const parsed = {};
for (const rel of [GUIDE, ROOT_README, SKILL, SELF_HOST]) {
  try {
    parsed[rel] = parseMarkdown(src[rel]);
  } catch (error) {
    parsed[rel] = null;
    if (error instanceof UnsupportedMarkdownError) {
      fail(`${rel}: uses Markdown outside the supported subset — ${error.message}`);
    } else {
      throw error;
    }
  }
}

/** Every href a document links to, off the parsed tree. */
function linksIn(rel) {
  const hrefs = [];
  visit(parsed[rel].blocks, (node) => {
    if (node.type === 'link' && node.href) hrefs.push(node.href);
  });
  return hrefs;
}

function checkNoPlaceholders() {
  for (const rel of [GUIDE, ROOT_README, SELF_HOST]) {
    if (/\bTODO:/.test(src[rel])) fail(`${rel}: contains a TODO: placeholder`);
  }
}

/**
 * The guide must carry the sections the spec says it carries.
 *
 * Read out of the spec's own `text` fence, which is where the guide's shape is
 * declared; a copy of the list here would be a second owner, and the spec is
 * the one a person edits. An empty or missing fence fails: the rule and the
 * prose it enforces must move together.
 */
function checkGuideSections() {
  if (!parsed[GUIDE]) return;
  const fence = /```text\n((?:## .*\n)+)```/.exec(readRepoFile(SPEC));
  if (!fence) {
    fail(`${SPEC}: no \`\`\`text fence listing the guide's sections; checkGuideSections enforces nothing without it`);
    return;
  }
  // "## Getting started  (### VS Code, ### Standalone)" annotates subsections.
  const required = fence[1]
    .trim()
    .split('\n')
    .map((line) => line.replace(/^##\s+/, '').replace(/\s{2,}\(.*\)$/, '').toLowerCase());
  const present = parsed[GUIDE].headings.map((h) => h.text.toLowerCase());
  for (const section of required) {
    if (!present.includes(section)) fail(`${GUIDE}: missing required section "${section}" (${SPEC})`);
  }
}

/** Marketplace media rules, read off the parsed tree rather than the source.
 *  A regex over raw Markdown also matches <img> examples inside fenced code
 *  blocks and misses images the parser normalizes.
 *
 *  Where a guide image must live, that it exists, and that nothing under
 *  vscode-ext/images/ is unused are the generator's rules (resolveGuideMedia),
 *  reported by checkGenerated; only what the Marketplace itself refuses is
 *  here. */
function checkImages() {
  if (!parsed[GUIDE]) return;
  const urls = [];
  visit(parsed[GUIDE].blocks, (node) => {
    if (node.type === 'image' && node.src) urls.push(node.src);
  });
  if (urls.length === 0) fail(`${GUIDE}: has no images; the listing needs at least a hero`);
  for (const url of urls) {
    if (/\.svg(\?|#|$)/i.test(url)) fail(`${GUIDE}: SVG images are not allowed on the Marketplace — ${url}`);
  }
}

/**
 * Every `vsce` or `ovsx` invocation that packages the extension from source
 * must pass the site's image base.
 *
 * docs/specs/website-docs.md -> "`--baseImagesUrl` is passed explicitly" — the
 * guide's images are repo-relative, both packagers infer a base from the
 * repository root, and this extension lives in a subdirectory, so an
 * invocation without the flag ships a listing whose images 404. Only a human
 * looking at the live Marketplace page would find out, which is why it is
 * pinned here. An invocation with `--packagePath` republishes an
 * already-packaged VSIX, whose URLs were rewritten when it was built.
 */
function checkImageBaseUrl() {
  const claim = '`--baseImagesUrl` is passed explicitly';
  if (!readRepoFile(SPEC).includes(claim)) {
    fail(`${SPEC}: no longer says ${claim} — the rule and its prose must move together`);
  }
  const callers = ['vscode-ext/package.json', '.github/workflows/release.yml'];
  let found = 0;
  for (const rel of callers) {
    for (const line of readRepoFile(rel).split('\n')) {
      if (!/\b(?:vsce (?:package|publish)|ovsx publish)\b/.test(line) || line.includes('--packagePath')) continue;
      found += 1;
      if (!line.includes(`--baseImagesUrl ${SITE_IMAGE_BASE}`)) {
        fail(`${rel}: packages the extension without --baseImagesUrl ${SITE_IMAGE_BASE} — ${line.trim()}`);
      }
    }
  }
  if (found === 0) fail(`no source-packaging \`vsce\` or \`ovsx\` invocation found in ${callers.join(', ')}`);
}

/**
 * Public links must be absolute https, and a local link must resolve.
 *
 * Read off the parsed tree, like checkImages: a regex over raw Markdown also
 * matches link-shaped text inside code spans and fenced samples.
 *
 * SELF_HOST.md gets only the https half. scripts/spec-lint.mjs already resolves
 * its relative links and validates their `#fragment` against real headings,
 * which is strictly more than this check could say.
 */
function checkLinks() {
  for (const rel of [GUIDE, ROOT_README, SELF_HOST]) {
    if (!parsed[rel]) continue;
    for (const href of linksIn(rel)) {
      if (href.startsWith('#')) continue;
      if (/^https:\/\//i.test(href)) continue;
      if (/^https?:\/\//i.test(href)) {
        fail(`${rel}: public link must use https — ${href}`);
        continue;
      }
      if (hasScheme(href) || isProtocolRelative(href)) continue;
      if (rel === SELF_HOST) continue;
      const target = join(repoRoot, dirname(rel), href.split('#')[0]);
      if (!existsSync(target)) fail(`${rel}: local link does not resolve — ${href}`);
    }
  }
}

/** Commands the guide tells people to run must exist in the extension manifest. */
function checkVsCodeCommands() {
  const manifest = JSON.parse(readRepoFile('vscode-ext/package.json'));
  const titles = new Set((manifest.contributes?.commands ?? []).map((c) => c.title));
  const named = [...src[GUIDE].matchAll(/\*\*(Dormouse: [^*]+)\*\*/g)].map(([, title]) => title);
  // The guide names its commands in bold. Rewritten as a table or in backticks,
  // this check would quietly enforce nothing, and pass while doing it.
  if (named.length === 0) fail(`${GUIDE}: names no **Dormouse: …** command; this check has stopped matching`);
  for (const title of named) {
    if (!titles.has(title)) fail(`${GUIDE}: names VS Code command "${title}", which is not in vscode-ext/package.json`);
  }
  for (const field of ['bugs', 'homepage', 'repository', 'icon']) {
    if (!manifest[field]) fail(`vscode-ext/package.json: missing listing field "${field}"`);
  }
}

/**
 * The published reference pages, from the route table's own list.
 *
 * website/src/lib/docs-pages.ts is the one owner (the routes, the prerender
 * list, and the docs footer all read it); the lint reads its paths rather than
 * keeping a fourth copy that could disagree with what actually ships.
 */
function referencePaths() {
  const source = readRepoFile(DOCS_PAGES);
  return [...source.matchAll(/path:\s*"(\/docs\/[^"]+)"/g)].map(([, path]) => path);
}

/**
 * Both READMEs must route to the published references, and the homepage too.
 *
 * The READMEs render off-site and spell them absolutely; the homepage is
 * on-site and spells them root-relatively. It is the page most able to strand
 * one: a section can be rewritten or cut and take its only link with it.
 *
 * Checked as exact paths rather than a `/docs` prefix: `/docs` itself is not a
 * page, so a prefix test would pass on a link to it and ship a 404.
 */
function checkRoutesToReferences() {
  const paths = referencePaths();
  if (paths.length === 0) {
    fail(`${DOCS_PAGES}: no reference paths found; checkRoutesToReferences enforces nothing without them`);
    return;
  }

  // The product guide is a Marketplace listing for the editor extension, and
  // running a relay server is not part of installing one, so /docs/self-host is
  // the root README's obligation alone.
  const guideExempt = new Set(['/docs/self-host']);
  for (const rel of [GUIDE, ROOT_README]) {
    if (!parsed[rel]) continue;
    const hrefs = linksIn(rel);
    for (const path of paths) {
      if (rel === GUIDE && guideExempt.has(path)) continue;
      const url = SITE_ORIGIN + path;
      if (!hrefs.some((href) => href === url || href.startsWith(`${url}#`))) {
        fail(`${rel}: does not link to ${url}`);
      }
    }
  }

  const hrefs = [...src[HOMEPAGE].matchAll(/href="(\/docs[^"]*)"/g)].map(([, href]) => href);
  const satisfies = (href, path) => href === path || href.startsWith(`${path}#`);
  for (const path of paths) {
    if (!hrefs.some((href) => satisfies(href, path))) fail(`${HOMEPAGE}: does not link to ${path}`);
  }
  for (const href of hrefs) {
    if (!paths.some((path) => satisfies(href, path))) {
      fail(`${HOMEPAGE}: links to ${href}, which is not a published reference`);
    }
  }
}

/**
 * Per-page head tags come from `siteMeta`, never from the root route's `<head>`.
 *
 * React Router renders only the deepest route's `meta`, and anything hardcoded
 * in `root.tsx`'s `<head>` is emitted *before* `<Meta />`. Putting a title or
 * canonical there gave every page with its own `meta` two `<title>` elements —
 * crawlers read the first, so each reference page advertised itself as the
 * homepage — and pinned `canonical`/`og:url` to `https://dormouse.sh/` on every
 * URL, which asks search engines to treat every page as a duplicate of the
 * homepage (docs/specs/website-docs.md -> Per-page head tags).
 */
function checkPageHeadTags() {
  const root = readRepoFile(ROOT_ROUTE);
  const head = root.slice(root.indexOf('<head>'), root.indexOf('</head>'));
  const banned = [
    [/<title>/, '<title>'],
    [/name="description"/, 'name="description"'],
    [/rel="canonical"/, 'rel="canonical"'],
    [/property="og:/, 'property="og:*"'],
    [/name="twitter:/, 'name="twitter:*"'],
  ];
  if (!head) {
    fail(`${ROOT_ROUTE}: no <head> found; checkPageHeadTags enforces nothing without it`);
    return;
  }
  for (const [pattern, label] of banned) {
    if (pattern.test(head)) {
      fail(`${ROOT_ROUTE}: ${label} is hardcoded in <head>; it belongs in siteMeta (${SITE_META})`);
    }
  }

  // Every route module that supplies its own head tags must go through the
  // helper, or it emits a title with no canonical beside it.
  let routesWithMeta = 0;
  for (const rel of trackedFiles()) {
    if (!rel.startsWith('website/src/') || !/\.tsx$/.test(rel)) continue;
    const source = readRepoFile(rel);
    if (!/export function meta\b/.test(source)) continue;
    routesWithMeta += 1;
    if (!/\bsiteMeta\(/.test(source)) {
      fail(`${rel}: exports meta() without calling siteMeta; its page would ship no canonical`);
    }
  }
  if (routesWithMeta === 0) fail(`no route module exports meta(); checkPageHeadTags has stopped matching`);
}

/** One origin, spelled the same in the build script and the browser bundle. */
function checkSiteOrigin() {
  const declared = /SITE_ORIGIN = "([^"]+)"/.exec(readRepoFile(SITE_META));
  if (!declared) {
    fail(`${SITE_META}: no SITE_ORIGIN declaration found`);
    return;
  }
  if (declared[1] !== SITE_ORIGIN) {
    fail(`${SITE_META}: SITE_ORIGIN is ${declared[1]}, but the generator uses ${SITE_ORIGIN}`);
  }
}

/** Generated data must be internally consistent. */
async function checkGenerated() {
  let data;
  try {
    data = await generateDocs();
  } catch (error) {
    fail(`docs generation failed: ${error.message}`);
    return;
  }

  // Everything else the generator guarantees by throwing: unique ids per page,
  // the delta's targets still being there, snapshot/inventory agreement in both
  // directions, and reference anchors resolving. Re-asserting them here would
  // state each invariant twice with a different message, so only the generator
  // owns them and the catch above reports any failure.
  for (const file of data.guide.media.unused) {
    fail(`vscode-ext/images/${file} is not referenced by the guide`);
  }
}

/**
 * Public copy must not present staged remote transports as shipped.
 *
 * Scoped by the spec that stages them: the ban applies only while WebRTC is
 * still below docs/specs/remote-api.md's `## Future` fold, so promoting it
 * retires this rule in the same commit that ships it.
 */
function checkNoStagedClaims() {
  const api = readRepoFile('docs/specs/remote-api.md');
  const future = api.slice(api.indexOf('\n## Future'));
  if (!/WebRTC/i.test(future)) return;
  for (const rel of [GUIDE, ROOT_README, HOMEPAGE]) {
    if (/WebRTC/i.test(src[rel])) {
      fail(`${rel}: mentions WebRTC, which is staged under docs/specs/remote-api.md -> ## Future`);
    }
  }
}

const checks = [
  checkNoPlaceholders,
  checkGuideSections,
  checkImages,
  checkImageBaseUrl,
  checkLinks,
  checkVsCodeCommands,
  checkPageHeadTags,
  checkSiteOrigin,
  checkRoutesToReferences,
  checkGenerated,
  checkNoStagedClaims,
];

// Each check is isolated: one throwing check must not abort the run, or a
// single malformed source hides every other problem behind a stack trace.
for (const check of checks) {
  try {
    await check();
  } catch (error) {
    fail(`${check.name} threw: ${error.message}`);
  }
}

if (failures.length > 0) {
  console.error(`public-docs-lint: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`public-docs-lint: ${checks.length} checks passed`);
