#!/usr/bin/env node
/**
 * Public documentation lint.
 *
 * Checks the contracts in docs/specs/website-docs.md that are mechanically
 * checkable. Nuanced product prose is deliberately NOT checked with phrase
 * blacklists — when a public feature section changes, review it against its
 * owning spec instead.
 *
 * Run by the root `pnpm test`.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMarkdown, visit, UnsupportedMarkdownError } from '../website/scripts/docs-parser.js';
import { generateDocs } from '../website/scripts/generate-docs.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const fail = (msg) => failures.push(msg);

const GUIDE = 'vscode-ext/README.md';
const ROOT_README = 'README.md';
const SKILL = 'dor/skill.md';

/** Sections the canonical guide must carry. */
const REQUIRED_GUIDE_SECTIONS = [
  'get dormouse',
  'layout and panes',
  'alerts and todos',
  'browsers for you and your agents',
  'mouse, selection, and copy/paste',
  'keyboard shortcuts',
  'themes and host integration',
  'getting started',
  'automation and agents',
  'help and project links',
];

const read = (rel) => readFile(join(repoRoot, rel), 'utf8');

/** Each source read once and parsed once, then shared by every check. */
const src = {
  [GUIDE]: await read(GUIDE),
  [ROOT_README]: await read(ROOT_README),
  [SKILL]: await read(SKILL),
};

/** Parsed form, or null when the source is outside the supported subset. */
const parsed = {};
for (const rel of [GUIDE, SKILL]) {
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

async function checkNoPlaceholders() {
  for (const rel of [GUIDE, ROOT_README]) {
    if (/\bTODO:/.test(src[rel])) fail(`${rel}: contains a TODO: placeholder`);
  }
}

async function checkGuideSections() {
  if (!parsed[GUIDE]) return;
  const present = parsed[GUIDE].headings.map((h) => h.text.toLowerCase());
  for (const required of REQUIRED_GUIDE_SECTIONS) {
    if (!present.includes(required)) fail(`${GUIDE}: missing required section "${required}"`);
  }
}

/** Marketplace media rules, read off the parsed tree rather than the source.
 *  A regex over raw Markdown also matches <img> examples inside fenced code
 *  blocks and misses images the parser normalizes. */
async function checkImages() {
  if (!parsed[GUIDE]) return;
  const urls = [];
  visit(parsed[GUIDE].blocks, (node) => {
    if (node.type === 'image' && node.src) urls.push(node.src);
  });
  if (urls.length === 0) fail(`${GUIDE}: has no images; the listing needs at least a hero`);
  for (const url of urls) {
    if (/\.svg(\?|#|$)/i.test(url)) fail(`${GUIDE}: SVG images are not allowed on the Marketplace — ${url}`);

    // Guide images must be repo-relative local files, so the README stays the
    // source of truth and ordinary GitHub authoring works. Remote media is
    // rejected outright: github.com/user-attachments URLs 302 to a
    // signature-expiring S3 object, cannot be cached downstream, leak visitor
    // IPs, and vanish with the comment they were uploaded to.
    //
    // Where the file must live, that it exists, and that nothing is unused are
    // the generator's rules (resolveGuideMedia); checkGenerated reports those.
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) {
      fail(`${GUIDE}: image must be a repo-relative local file, not a remote URL — ${url}`);
    }
  }
}

/** Local Markdown links must resolve; public links must be absolute https. */
async function checkLinks() {
  for (const rel of [GUIDE, ROOT_README]) {
    // Skip fenced code blocks: a link-looking string inside a sample is not a
    // link, and reporting it as broken would be a false failure.
    const text = src[rel]
      .split('\n')
      .reduce(
        (acc, line) => {
          if (/^\s*(```|~~~)/.test(line)) return { ...acc, inFence: !acc.inFence };
          return acc.inFence ? acc : { ...acc, out: acc.out.concat(line) };
        },
        { inFence: false, out: [] },
      )
      .out.join('\n');
    for (const [, href] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      if (href.startsWith('#')) continue;
      if (/^https:\/\//i.test(href)) continue;
      if (/^https?:\/\//i.test(href)) {
        fail(`${rel}: public link must use https — ${href}`);
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      const target = join(repoRoot, dirname(rel), href.split('#')[0]);
      if (!existsSync(target)) fail(`${rel}: local link does not resolve — ${href}`);
    }
  }
}

/** Commands the guide tells people to run must exist in the extension manifest. */
async function checkVsCodeCommands() {
  const manifest = JSON.parse(await read('vscode-ext/package.json'));
  const titles = new Set((manifest.contributes?.commands ?? []).map((c) => c.title));
  for (const [, title] of src[GUIDE].matchAll(/\*\*(Dormouse: [^*]+)\*\*/g)) {
    if (!titles.has(title)) fail(`${GUIDE}: names VS Code command "${title}", which is not in vscode-ext/package.json`);
  }
  for (const field of ['bugs', 'homepage', 'repository', 'icon']) {
    if (!manifest[field]) fail(`vscode-ext/package.json: missing listing field "${field}"`);
  }
}

/**
 * Both READMEs must route to the published references.
 *
 * Checked as exact URLs rather than a `/docs` prefix: `/docs` itself is not a
 * page, so a prefix test would pass on a link to it and ship a 404.
 */
const REFERENCE_URLS = ['https://dormouse.sh/docs/dor', 'https://dormouse.sh/docs/agent-skill'];

async function checkRoutesToReferences() {
  for (const rel of [GUIDE, ROOT_README]) {
    for (const url of REFERENCE_URLS) {
      if (!src[rel].includes(url)) fail(`${rel}: does not link to ${url}`);
    }
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
  // snapshot/inventory agreement in both directions, and reference anchors
  // resolving. Re-asserting them here would state each invariant twice with a
  // different message, so only the generator owns them and the catch above
  // reports any failure.
  for (const file of data.guide.media.unused) {
    fail(`vscode-ext/images/${file} is not referenced by the guide`);
  }
}

/** Public copy must not present staged WebRTC as shipped. */
async function checkNoStagedClaims() {
  for (const rel of [GUIDE, ROOT_README, 'website/src/pages/Home.tsx']) {
    const text = rel in src ? src[rel] : await read(rel);
    if (/WebRTC/i.test(text)) {
      fail(`${rel}: mentions WebRTC, which is staged in docs/specs/remote-api.md and must not be presented as shipped`);
    }
  }
}

const checks = [
  checkNoPlaceholders,
  checkGuideSections,
  checkImages,
  checkLinks,
  checkVsCodeCommands,
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
