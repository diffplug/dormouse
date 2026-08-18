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
import { parseMarkdown, UnsupportedMarkdownError } from '../website/scripts/docs-parser.js';
import { generateDocs } from '../website/scripts/generate-docs.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const fail = (msg) => failures.push(msg);

const GUIDE = 'vscode-ext/README.md';
const ROOT_README = 'README.md';

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

async function checkNoPlaceholders() {
  for (const rel of [GUIDE, ROOT_README]) {
    const text = await read(rel);
    if (/\bTODO:/.test(text)) fail(`${rel}: contains a TODO: placeholder`);
  }
}

/**
 * The guide must stay inside the Markdown subset the in-repo parser supports.
 * Without this, an unsupported construct renders wrong at /docs instead of
 * failing the build — the tradeoff we accepted by hand-rolling the parser.
 */
async function checkGuideParses() {
  for (const rel of [GUIDE, 'dor/skill.md']) {
    try {
      parseMarkdown(await read(rel));
    } catch (error) {
      if (error instanceof UnsupportedMarkdownError) {
        fail(`${rel}: uses Markdown outside the supported subset — ${error.message}`);
      } else {
        throw error;
      }
    }
  }
}

async function checkGuideSections() {
  const { headings } = parseMarkdown(await read(GUIDE));
  const present = headings.map((h) => h.text.toLowerCase());
  for (const required of REQUIRED_GUIDE_SECTIONS) {
    if (!present.includes(required)) fail(`${GUIDE}: missing required section "${required}"`);
  }
}

/** Marketplace media rules: https only, raster only. */
async function checkImages() {
  const text = await read(GUIDE);
  const urls = [
    ...[...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]),
    ...[...text.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]),
  ];
  if (urls.length === 0) fail(`${GUIDE}: has no images; the listing needs at least a hero`);
  for (const url of urls) {
    if (/\.svg(\?|#|$)/i.test(url)) fail(`${GUIDE}: SVG images are not allowed on the Marketplace — ${url}`);

    // Guide images must be repo-relative local files, so the README stays the
    // source of truth and ordinary GitHub authoring works. Remote media is
    // rejected outright: github.com/user-attachments URLs 302 to a
    // signature-expiring S3 object, cannot be cached downstream, leak visitor
    // IPs, and vanish with the comment they were uploaded to.
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) {
      fail(`${GUIDE}: image must be a repo-relative local file, not a remote URL — ${url}`);
      continue;
    }

    const rel = url.replace(/^\.\//, '');
    if (!rel.startsWith('media/')) {
      fail(`${GUIDE}: image must live under vscode-ext/media/ — ${url}`);
      continue;
    }
    if (!existsSync(join(repoRoot, 'vscode-ext', rel))) {
      fail(`${GUIDE}: references ${url}, which does not exist in vscode-ext/`);
    }
  }

  // Every file in vscode-ext/media must be referenced, or it ships unused.
  const mediaDir = join(repoRoot, 'vscode-ext', 'media');
  if (existsSync(mediaDir)) {
    const referenced = new Set(urls.map((u) => u.replace(/^\.\//, '').replace(/^media\//, '')));
    for (const file of await readdir(mediaDir)) {
      if (!referenced.has(file)) fail(`vscode-ext/media/${file} is not referenced by the guide`);
    }
  }
}

/** Local Markdown links must resolve; public links must be absolute https. */
async function checkLinks() {
  for (const rel of [GUIDE, ROOT_README]) {
    const text = await read(rel);
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
  const text = await read(GUIDE);
  for (const [, title] of text.matchAll(/\*\*(Dormouse: [^*]+)\*\*/g)) {
    if (!titles.has(title)) fail(`${GUIDE}: names VS Code command "${title}", which is not in vscode-ext/package.json`);
  }
  for (const field of ['bugs', 'homepage', 'repository', 'icon']) {
    if (!manifest[field]) fail(`vscode-ext/package.json: missing listing field "${field}"`);
  }
}

/** Both READMEs must route durable user documentation to /docs. */
async function checkRoutesToDocs() {
  for (const rel of [GUIDE, ROOT_README]) {
    const text = await read(rel);
    if (!text.includes('https://dormouse.sh/docs')) fail(`${rel}: does not link to https://dormouse.sh/docs`);
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

  const ids = data.guide.headings.map((h) => h.id);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupes.length > 0) fail(`/docs heading ids are not unique: ${dupes.join(', ')}`);

  const helpDir = join(repoRoot, 'dor', 'test', 'snapshots', 'help');
  const snapshotIds = (await readdir(helpDir)).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  const generated = new Set([...data.cli.commands.map((c) => c.id), data.cli.root.id]);
  for (const id of snapshotIds) {
    if (!generated.has(id)) fail(`/docs/dor is missing command snapshot "${id}"`);
  }
  for (const id of generated) {
    if (!snapshotIds.includes(id)) fail(`/docs/dor generated command "${id}" has no snapshot`);
  }

  const anchors = new Set([...data.cli.intro.map((s) => s.id), 'dor', ...data.cli.commands.map((c) => c.id)]);
  for (const ref of Object.values(data.skill.references)) {
    const anchor = ref.href.replace('/docs/dor#', '');
    if (!anchors.has(anchor)) fail(`agent-skill reference target #${anchor} does not exist in /docs/dor`);
  }

  const skillOnDisk = await read('dor/skill.md');
  if (data.skill.markdown !== skillOnDisk) fail('/docs/agent-skill markdown is not byte-identical to dor/skill.md');
}

/** Public copy must not present staged WebRTC as shipped. */
async function checkNoStagedClaims() {
  for (const rel of [GUIDE, ROOT_README, 'website/src/pages/Home.tsx']) {
    const text = await read(rel);
    if (/WebRTC/i.test(text)) {
      fail(`${rel}: mentions WebRTC, which is staged in docs/specs/remote-api.md and must not be presented as shipped`);
    }
  }
}

const checks = [
  checkNoPlaceholders,
  checkGuideParses,
  checkGuideSections,
  checkImages,
  checkLinks,
  checkVsCodeCommands,
  checkRoutesToDocs,
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
