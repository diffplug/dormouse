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
 * The sources it reads: the canonical product guide, the root README, the
 * bundled agent skill, the self-host runbook, the security spec, the homepage,
 * and the route table, redirects, and head-tag plumbing that publish them.
 *
 * Run by the root `pnpm test`.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { repoRoot, readRepoFile, trackedFiles } from './lint-kit.mjs';
import {
  hasScheme,
  inlineToText,
  isProtocolRelative,
  parseMarkdown,
  visit,
  UnsupportedMarkdownError,
} from '../website/scripts/docs-parser.js';
import { generateDocs, SITE_ORIGIN, SITE_IMAGE_BASE } from '../website/scripts/generate-docs.js';
// Imported, not scraped: Node strips the types, so the lint reads the same
// objects the browser bundle does. A regex over the source silently returned
// fewer pages when a field was reordered or a flag renamed, and every check
// here only fails on zero — so a partial miss passed.
import { DOCS_PAGES, DOCS_DEFAULT_PATH } from '../website/src/lib/docs-pages.ts';

const failures = [];
const fail = (msg) => failures.push(msg);

const GUIDE = 'vscode-ext/README.md';
const ROOT_README = 'README.md';
const SKILL = 'dor/skill.md';
const SELF_HOST = 'SELF_HOST.md';
const SECURITY_SPEC = 'docs/specs/security.md';
const HOMEPAGE = 'website/src/pages/Home.tsx';
/** The `/docs` redirect entrypoint `website/public/_redirects` owns; it names
 *  no page, so `sitePath` has nothing to point it at. */
const DOCS_ENTRYPOINT_PATH = '/docs';
/** The `linkedFrom` source naming {@link HOMEPAGE}, as `docs-pages.ts` spells it. */
const HOMEPAGE_SOURCE = 'homepage';
const SPEC = 'docs/specs/website-docs.md';
const REDIRECTS = 'website/public/_redirects';
const ROOT_ROUTE = 'website/src/root.tsx';
const SITE_META = 'website/src/lib/site-meta.ts';
const WEBSITE_SRC = 'website/src';

/**
 * Every `.tsx` a reference page renders, reached transitively from the route
 * table's own modules.
 *
 * Derived rather than listed, like every other inventory here: a hand-kept copy
 * of "which files are docs surfaces" is a second owner of the route table, and
 * a component added to a page — or a page added to `DOCS_PAGES` — would quietly
 * fall outside whatever check reads it. `DocsLayout` is seeded explicitly
 * because it is what makes a page a docs surface (it adds `docs-themed`), and
 * pages reach it through their own imports anyway.
 */
function docsSurfaces() {
  const seed = [
    `${WEBSITE_SRC}/components/DocsLayout.tsx`,
    ...DOCS_PAGES.map((page) => `${WEBSITE_SRC}/${page.module.replace(/^\.\//, '')}`),
  ];
  const tracked = new Set(trackedFiles());
  const seen = new Set();
  const queue = [...seed];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel) || !tracked.has(rel)) continue;
    seen.add(rel);
    for (const [, spec] of readRepoFile(rel).matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const resolved = join(dirname(rel), spec);
      for (const ext of ['.tsx', '.ts']) {
        if (tracked.has(resolved + ext)) queue.push(resolved + ext);
      }
    }
  }
  for (const rel of seed) {
    if (!tracked.has(rel)) fail(`${rel}: docsSurfaces seed names a file that does not exist`);
  }
  return [...seen].filter((rel) => rel.endsWith('.tsx')).sort();
}

/** Each source read once and parsed once, then shared by every check. */
const src = {
  [GUIDE]: readRepoFile(GUIDE),
  [ROOT_README]: readRepoFile(ROOT_README),
  [SKILL]: readRepoFile(SKILL),
  [SELF_HOST]: readRepoFile(SELF_HOST),
  [SECURITY_SPEC]: readRepoFile(SECURITY_SPEC),
  [HOMEPAGE]: readRepoFile(HOMEPAGE),
};

/** Parsed form, or null when the source is outside the supported subset. */
const parsed = {};
for (const rel of [GUIDE, ROOT_README, SKILL, SELF_HOST, SECURITY_SPEC]) {
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
  for (const rel of [GUIDE, ROOT_README, SELF_HOST, SECURITY_SPEC]) {
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
 * docs/specs/website-docs.md -> Canonical product guide — the
 * guide's images are repo-relative, both packagers infer a base from the
 * repository root, and this extension lives in a subdirectory, so an
 * invocation without the flag ships a listing whose images 404. Only a human
 * looking at the live Marketplace page would find out, which is why it is
 * pinned here. An invocation with `--packagePath` republishes an
 * already-packaged VSIX, whose URLs were rewritten when it was built.
 */
function checkImageBaseUrl() {
  const claim = '**Must pass** `--baseImagesUrl` on every';
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
 * SELF_HOST.md and the security spec get only the https half.
 * scripts/spec-lint.mjs already resolves both files' relative links and
 * validates their `#fragment` against real headings, which is strictly more
 * than this check could say.
 */
function checkLinks() {
  for (const rel of [GUIDE, ROOT_README, SELF_HOST, SECURITY_SPEC]) {
    if (!parsed[rel]) continue;
    for (const href of linksIn(rel)) {
      if (href.startsWith('#')) continue;
      if (/^https:\/\//i.test(href)) continue;
      if (/^https?:\/\//i.test(href)) {
        fail(`${rel}: public link must use https — ${href}`);
        continue;
      }
      if (hasScheme(href) || isProtocolRelative(href)) continue;
      if (rel === SELF_HOST || rel === SECURITY_SPEC) continue;
      const target = join(repoRoot, dirname(rel), href.split('#')[0]);
      if (!existsSync(target)) fail(`${rel}: local link does not resolve — ${href}`);
    }
  }
}

/**
 * The security spec is published whole, so it may carry nothing staged.
 *
 * Every other spec keeps unbuilt design under `## Future` and marks what
 * constrains present code `Reserved:`. This one has no fold: `SECURITY_DELTA`
 * withholds the title and the front matter and nothing else, so anything
 * staged in the file ships to dormouse.sh as a promise
 * (docs/specs/website-docs.md -> `/docs/security` spec).
 *
 * Read off the parsed tree, so `## Future` inside a fenced example and a code
 * span reading `Reserved:` are not findings.
 */
function checkSecurityFold() {
  if (!parsed[SECURITY_SPEC]) return;
  const where = `${SPEC} -> "/docs/security"`;
  const remedy = 'staged material must be withheld by a delta rule before it can exist there';
  for (const heading of parsed[SECURITY_SPEC].headings) {
    // Any depth, numbered or not: the fold is a fold wherever it is written.
    if (heading.depth >= 2 && /^(?:\d+\.\s*)?Future$/.test(heading.text)) {
      fail(`${SECURITY_SPEC}: carries a "${heading.text}" heading, but is published whole (${where}) — ${remedy}`);
    }
  }
  visit(parsed[SECURITY_SPEC].blocks, (node) => {
    if (node.type !== 'paragraph') return;
    if (!inlineToText(node.children ?? []).startsWith('Reserved:')) return;
    fail(`${SECURITY_SPEC}: carries a Reserved: paragraph, but is published whole (${where}) — ${remedy}`);
  });
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
 * Every page reaches the readers its `linkedFrom` names, and the homepage
 * reaches them all.
 *
 * The READMEs render off-site and spell the URLs absolutely; the homepage is
 * on-site and spells them root-relatively.
 */
function checkRoutesToReferences() {
  // Each page names the documents that must link it, so the one exemption —
  // the guide owes nothing to the self-host runbook — lives on the entry it
  // applies to rather than as a set here.
  const README_OF = { guide: GUIDE, 'root-readme': ROOT_README };
  // A link to the page itself, or to an anchor on it — in either spelling,
  // because the host 308s the bare path to the trailing-slash one (`sitePath`
  // in `website/src/lib/site-meta.ts`), so a document that writes the
  // destination directly is as correct as one that writes the redirect.
  const satisfies = (href, path) =>
    [path, `${path}/`].some((form) => href === form || href.startsWith(`${form}#`));
  // Pages owing a README a link. Scoped past `homepage`, which the second half
  // checks — counting it here would leave this tripwire armed by a page whose
  // only obligation is on-site, so the README half could enforce nothing and
  // still print "passed".
  const linked = DOCS_PAGES.filter((page) =>
    page.linkedFrom?.some((source) => source !== HOMEPAGE_SOURCE));
  if (linked.length === 0) {
    fail('docs-pages.ts: no page names a README; checkRoutesToReferences enforces nothing');
    return;
  }

  for (const page of linked) {
    const url = SITE_ORIGIN + page.path;
    for (const source of page.linkedFrom ?? []) {
      // The homepage is on-site and spells its links root-relatively; it is
      // checked below, against the same registry.
      if (source === HOMEPAGE_SOURCE) continue;
      const rel = README_OF[source];
      // Node strips the `"guide" | "root-readme" | "homepage"` union at
      // runtime, so a typo here would otherwise skip the page's check and
      // still print "passed".
      if (!rel) {
        fail(`docs-pages.ts: ${page.path} names an unknown linkedFrom "${source}"`);
        continue;
      }
      if (!parsed[rel]) continue;
      if (!linksIn(rel).some((href) => satisfies(href, url))) {
        fail(`${rel}: does not link to ${url}`);
      }
    }
  }

  // Which pages the homepage owes a link to is the registry's call, not a
  // guess from the path: `/hosted` and `/supply-chain` are owed one and do not
  // sit under `/docs`, while `/changelog` sits in the rail on purpose.
  const owed = DOCS_PAGES.filter((page) => page.linkedFrom?.includes(HOMEPAGE_SOURCE));
  if (owed.length === 0) {
    fail(`docs-pages.ts: no page names the homepage; ${HOMEPAGE} enforces nothing`);
    return;
  }
  // The homepage routes every in-site link through `sitePath("<path>")`
  // (`checkInSiteHrefsAreServed`), so the path is read from the call rather
  // than from a rendered href. An anchor on the page still counts as a link
  // to it, and that suffix is outside the call.
  const homeHrefs = [...src[HOMEPAGE].matchAll(/sitePath\("(\/[^"]*)"\)/g)].map(([, href]) => href);
  if (homeHrefs.length === 0) {
    fail(`${HOMEPAGE}: no sitePath() links found — the homepage link checks are looking `
      + 'at nothing. Has the href form changed?');
    return;
  }
  for (const page of owed) {
    if (!homeHrefs.some((href) => satisfies(href, page.path))) {
      fail(`${HOMEPAGE}: does not link to ${page.path}`);
    }
  }

  // A homepage link *shaped* like a reference must be one. Scoped to `/docs`
  // because that namespace is only ever references, so a typo there is
  // detectable; a mistyped top-level path is just a broken link, which no
  // prefix rule can tell from a real page. Exact paths, because `/docs` is an
  // entrypoint rather than a page and a prefix test would accept a link to it.
  const docsPaths = DOCS_PAGES.map((page) => page.path).filter((path) => path.startsWith('/docs/'));
  for (const href of homeHrefs.filter((href) => href.startsWith('/docs'))) {
    if (!docsPaths.some((path) => satisfies(href, path))) {
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

  // A route that re-exports another page's component inherits its rendering but
  // not its `meta` — the export is per-module. That left /changelog/after/* with
  // no head tags at all, serving the SPA fallback's homepage title and canonical
  // on the URL the standalone updater opens.
  for (const rel of trackedFiles()) {
    if (!rel.startsWith('website/src/pages/') || !/\.tsx$/.test(rel)) continue;
    const source = readRepoFile(rel);
    if (!/export \{[^}]*\bdefault\b[^}]*\} from/.test(source)) continue;
    // An export, not the word: `\bmeta\b` also matched the comment above the
    // re-export explaining why the export must be there, so deleting the export
    // and keeping the comment passed. Both legitimate spellings count.
    if (!/export function meta\b|export \{[^}]*\bmeta\b[^}]*\} from/.test(source)) {
      fail(`${rel}: re-exports a page component without meta(); the route would ship the fallback's head`);
    }
  }
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

/**
 * `/docs` sends a reader to the page `DOCS_DEFAULT_PATH` names, with the status
 * docs/specs/website-docs.md requires.
 *
 * `_redirects` is a deploy artifact no test exercises and no build reads, so
 * without this the two spellings of one destination drift the first time
 * someone edits only the constant.
 */
function checkDocsEntrypoint() {
  const target = DOCS_DEFAULT_PATH;
  if (!DOCS_PAGES.some((page) => page.path === target)) {
    fail(`docs-pages.ts: DOCS_DEFAULT_PATH is ${target}, which is not a page in the rail`);
  }
  const rule = readRepoFile(REDIRECTS)
    .split('\n')
    .find((line) => /^\/docs\s/.test(line));
  if (!rule) {
    fail(`${REDIRECTS}: no /docs rule; the entrypoint would 404`);
    return;
  }
  const [, to, status] = rule.trim().split(/\s+/);
  if (to !== target) fail(`${REDIRECTS}: /docs goes to ${to}, but DOCS_DEFAULT_PATH is ${target}`);
  // A 301 outlives the next time we change our mind about the entrypoint.
  if (status !== '302') fail(`${REDIRECTS}: /docs must redirect with 302, not ${status ?? '(none)'}`);
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

/**
 * The reference pages must not render text in a translucent colour.
 *
 * `docs/specs/website-docs.md` -> "Reference page chrome" states the rule, and
 * `website/src/lib/docs-accent.ts` supplies the replacement: an opaque colour
 * walked toward the background only as far as WCAG AA allows. Translucency
 * cannot do that — it composites against whatever surface it lands on, so the
 * same class measured 5.03:1 on one bundled theme and 2.01:1 on another.
 *
 * Both spellings count. `opacity-50` and `text-[var(--color-text)]/50` differ
 * only in whether the alpha rides the element or the colour, and banning one
 * merely moves the failure to the other — which is what happened: the pages
 * converted off `opacity-*` still dimmed prose with `text-…/70`.
 *
 * Only *resting* translucency, and only below full: a `hover:`/`focus:` variant
 * is a transient state over a colour that already passed, and `/100` and
 * `opacity-100` are opaque.
 *
 * Scoped to the surfaces a reference page actually renders, derived below. The
 * marketing pages are painted in colours the reader cannot retheme, so their
 * contrast is fixed at authoring time and translucency there is safe.
 */
function checkNoDimmedDocsText() {
  // Files whose resting translucency is not reading text: the exact classes
  // exempted, each with the reason. Keyed by class rather than by file so a
  // file that later grows a *different* dimmed class still fails — an
  // exemption covers the element someone justified, not the module.
  const ALLOWED = {
    [`${WEBSITE_SRC}/components/DocsLayout.tsx`]: {
      'opacity-30':
        'An aria-hidden "/" separating the rail crumb from the page title. '
        + 'Decoration, never read, and not a contrast surface.',
    },
    [`${WEBSITE_SRC}/components/DocsThemeControl.tsx`]: {
      'opacity-50':
        'The theme prompt\'s dismiss button — an icon affordance that comes to '
        + 'full strength on hover, not body copy.',
    },
    [`${WEBSITE_SRC}/components/NotifySignupForm.tsx`]: {
      'opacity-50': 'The `site` palette\'s muted label and placeholder.',
      'text-[var(--color-text)]/70': 'The `site` palette\'s input text.',
    },
  };

  const surfaces = docsSurfaces();
  const matchedAllowed = new Map();
  for (const rel of surfaces) {
    // `(?<![\w:-])` rejects `hover:opacity-100`; `(?!100)` skips the opaque end
    // of both scales.
    const hits = new Set([...readRepoFile(rel).matchAll(
      /(?<![\w:-])opacity-(?!100\b)\d+|text-\[[^\]]*\]\/(?!100\b)\d+/g,
    )].map(([m]) => m));
    if (hits.size === 0) continue;
    const allowed = ALLOWED[rel] ?? {};
    matchedAllowed.set(rel, hits);
    const unexplained = [...hits].filter((hit) => !(hit in allowed));
    if (unexplained.length === 0) continue;
    fail(`${rel}: dims text with ${unexplained.join(', ')} — use MUTED_TEXT_CLASS `
      + '(website/src/components/docs-tokens.ts), or add an ALLOWED entry in '
      + 'scripts/public-docs-lint.mjs saying why this one is not reading text.');
  }

  // A stale entry silently exempts nothing, or worse, exempts the next thing
  // that file grows.
  for (const [rel, allowed] of Object.entries(ALLOWED)) {
    if (!surfaces.includes(rel)) {
      fail(`${rel}: ALLOWED entry in checkNoDimmedDocsText is not a docs surface — drop it.`);
      continue;
    }
    const hits = matchedAllowed.get(rel) ?? new Set();
    for (const hit of Object.keys(allowed)) {
      if (!hits.has(hit)) {
        fail(`${rel}: ALLOWED entry in checkNoDimmedDocsText exempts "${hit}", which the `
          + 'file no longer uses — drop it.');
      }
    }
  }
}
/**
 * Every in-site `href` spells the path the host actually serves.
 *
 * The host answers `/supply-chain` with a 308 to `/supply-chain/`, so a
 * hand-written bare path costs the reader a redirect on a full page load —
 * which is every in-site link here, since these are plain `<a href>` and not
 * React Router `<Link to>`. `sitePath` in `website/src/lib/site-meta.ts` owns
 * the rule; this stops the twenty-first href from quietly re-deriving it.
 *
 * Both spellings of a written href: the JSX attribute and the `href:` property
 * of a nav-link table. `/` is exempt as already-served, and `/docs` because
 * `website/public/_redirects` owns it as an entrypoint rather than a page.
 */
function checkInSiteHrefsAreServed() {
  const files = trackedFiles().filter(
    (rel) => /^website\/src\/(pages|components)\/.*\.tsx$/.test(rel) && !rel.endsWith('.test.tsx'),
  );
  if (files.length === 0) {
    fail('checkInSiteHrefsAreServed matched no files — its path filter has rotted.');
    return;
  }
  for (const rel of files) {
    for (const [, href] of readRepoFile(rel).matchAll(/href[=:] ?"(\/[^"]*)"/g)) {
      // `/` and an anchor on it are already the served form.
      if (href === '/' || href.startsWith('/#') || href === DOCS_ENTRYPOINT_PATH) continue;
      fail(`${rel}: hand-written in-site href "${href}" — wrap it in sitePath() `
        + '(website/src/lib/site-meta.ts) so it points at the page rather than a redirect.');
    }
  }
}

const checks = [
  checkNoPlaceholders,
  checkGuideSections,
  checkImages,
  checkImageBaseUrl,
  checkLinks,
  checkSecurityFold,
  checkVsCodeCommands,
  checkPageHeadTags,
  checkSiteOrigin,
  checkDocsEntrypoint,
  checkRoutesToReferences,
  checkGenerated,
  checkNoStagedClaims,
  checkNoDimmedDocsText,
  checkInSiteHrefsAreServed,
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
