#!/usr/bin/env node
/**
 * Download VSCode theme extensions from OpenVSX, extract theme JSONs,
 * and write lib/src/lib/themes/bundled.json.
 *
 * Usage: node scripts/bundle-themes.mjs
 *
 * Output is checked into git so builds don't require network access.
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { parse as parseJsonc } from 'jsonc-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, '../src/lib/themes/bundled.json');
const OUTPUT_EXTENSIONS = resolve(__dirname, '../src/lib/themes/bundled-extensions.json');

/** Extensions to download from OpenVSX. */
const EXTENSIONS = [
  { namespace: 'vscode', name: 'theme-defaults' },
  { namespace: 'vscode', name: 'theme-monokai' },
  { namespace: 'vscode', name: 'theme-quietlight' },
  { namespace: 'vscode', name: 'theme-red' },
  { namespace: 'vscode', name: 'theme-kimbie-dark' },
  { namespace: 'vscode', name: 'theme-abyss' },
  { namespace: 'santoso-wijaya', name: 'helios-selene' },
];

const PREFERRED_THEME_ORDER = [
  'GitHub.github-vscode-theme.github-dark-default',
];

// Excluded: legacy/classic variants, plus HC variants (our bg-only chrome
// renders flat in HC themes — see docs/specs/theme.md).
const EXCLUDED_THEMES = new Set([
  'vscode.theme-defaults.dark',
  'vscode.theme-defaults.light',
  'vscode.theme-defaults.dark-modern',
  'vscode.theme-defaults.light-modern',
  'vscode.theme-defaults.dark-high-contrast',
  'vscode.theme-defaults.light-high-contrast',
]);

/**
 * VSCode theme color keys consumed by Dormouse.
 * Keep in sync with lib/src/lib/themes/convert.ts.
 */
const CONSUMED_KEYS = new Set([
  'foreground',
  'editor.background', 'sideBar.background', 'sideBar.foreground',
  'editorWidget.background', 'editor.selectionBackground', 'editor.foreground', 'descriptionForeground',
  'focusBorder', 'panel.border',
  'list.activeSelectionBackground', 'list.activeSelectionForeground',
  'list.inactiveSelectionBackground', 'list.inactiveSelectionForeground',
  'terminal.background', 'terminal.foreground',
  'errorForeground',
  'input.background', 'input.border',
  'button.background', 'button.foreground',
  'textLink.foreground',
  'terminalCursor.foreground', 'terminal.selectionBackground',
  'terminal.ansiBlack', 'terminal.ansiRed', 'terminal.ansiGreen', 'terminal.ansiYellow',
  'terminal.ansiBlue', 'terminal.ansiMagenta', 'terminal.ansiCyan', 'terminal.ansiWhite',
  'terminal.ansiBrightBlack', 'terminal.ansiBrightRed', 'terminal.ansiBrightGreen',
  'terminal.ansiBrightYellow', 'terminal.ansiBrightBlue', 'terminal.ansiBrightMagenta',
  'terminal.ansiBrightCyan', 'terminal.ansiBrightWhite',
]);

function convertColors(colors) {
  const vars = {};
  for (const [key, value] of Object.entries(colors)) {
    if (CONSUMED_KEYS.has(key)) {
      vars[`--vscode-${key.replace(/\./g, '-')}`] = value;
    }
  }
  return vars;
}

function uiThemeToType(uiTheme) {
  return uiTheme === 'vs' || uiTheme === 'hc-light' ? 'light' : 'dark';
}

function slugify(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Read a UTF-8 file from the unzipped VSIX entries. */
function readEntry(entries, path) {
  // VSIX entries are prefixed with "extension/"
  const key = `extension/${path}`;
  const data = entries[key];
  if (!data) throw new Error(`Missing ${key} in VSIX`);
  return new TextDecoder().decode(data);
}

async function fetchExtensionThemes(namespace, name) {
  console.log(`Fetching ${namespace}/${name} from OpenVSX...`);

  // Get latest version metadata
  const metaRes = await fetch(`https://open-vsx.org/api/${namespace}/${name}/latest`);
  if (!metaRes.ok) throw new Error(`OpenVSX metadata failed: ${metaRes.status}`);
  const meta = await metaRes.json();

  const downloadUrl = meta.files?.download;
  if (!downloadUrl) throw new Error(`No download URL for ${namespace}/${name}`);

  console.log(`  Downloading VSIX (v${meta.version})...`);
  const vsixRes = await fetch(downloadUrl);
  if (!vsixRes.ok) throw new Error(`VSIX download failed: ${vsixRes.status}`);
  const vsixBuf = new Uint8Array(await vsixRes.arrayBuffer());

  console.log(`  Extracting...`);
  const entries = unzipSync(vsixBuf);

  // Read package.json to find theme contributions
  const pkgJson = JSON.parse(readEntry(entries, 'package.json'));
  const themeContribs = pkgJson.contributes?.themes ?? [];

  // Resolve %key% nls placeholders from package.nls.json if present.
  let nls = {};
  try {
    nls = JSON.parse(readEntry(entries, 'package.nls.json'));
  } catch {
    // No nls bundle; placeholders will pass through.
  }
  const resolveNls = (s) =>
    typeof s === 'string'
      ? s.replace(/^%([^%]+)%$/, (_, k) => (typeof nls[k] === 'string' ? nls[k] : (nls[k]?.message ?? `%${k}%`)))
      : s;

  const themes = [];
  for (const contrib of themeContribs) {
    const themePath = contrib.path.replace(/^\.\//, '');
    const label = resolveNls(contrib.label);
    console.log(`  Converting ${label} (${themePath})...`);

    const themeJson = parseJsonc(readEntry(entries, themePath));
    const colors = themeJson.colors ?? {};
    const vars = convertColors(colors);
    const type = uiThemeToType(contrib.uiTheme ?? themeJson.type ?? 'vs-dark');

    themes.push({
      id: `${namespace}.${name}.${slugify(label)}`,
      label,
      type,
      swatch: colors['editor.background'] ?? (type === 'light' ? '#ffffff' : '#1e1e1e'),
      accent: colors['focusBorder'] ?? (type === 'light' ? '#0090f1' : '#007fd4'),
      vars,
      origin: { kind: 'bundled' },
    });
  }

  console.log(`  Found ${themes.length} theme(s).`);
  return {
    themes,
    extension: {
      name: meta.displayName ?? `${namespace}/${name}`,
      version: meta.version,
      license: meta.license ?? null,
      author: meta.publishedBy?.loginName ?? null,
      homepage: meta.homepage ?? meta.repository ?? null,
    },
  };
}

async function main() {
  const allThemes = [];
  const allExtensions = [];

  for (const ext of EXTENSIONS) {
    const { themes, extension } = await fetchExtensionThemes(ext.namespace, ext.name);
    allThemes.push(...themes.filter(t => !EXCLUDED_THEMES.has(t.id)));
    allExtensions.push(extension);
  }
  allThemes.sort((a, b) => {
    const aIndex = PREFERRED_THEME_ORDER.indexOf(a.id);
    const bIndex = PREFERRED_THEME_ORDER.indexOf(b.id);
    if (aIndex === -1 && bIndex === -1) return 0;
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  });

  console.log(`\nWriting ${allThemes.length} themes to ${OUTPUT}`);
  writeFileSync(OUTPUT, JSON.stringify(allThemes, null, 2) + '\n');

  console.log(`Writing ${allExtensions.length} extensions to ${OUTPUT_EXTENSIONS}`);
  writeFileSync(OUTPUT_EXTENSIONS, JSON.stringify(allExtensions, null, 2) + '\n');
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
