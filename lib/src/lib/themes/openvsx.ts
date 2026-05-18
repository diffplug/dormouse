/**
 * Runtime OpenVSX theme installer.
 *
 * Searches for theme extensions, downloads VSIX files, extracts theme
 * JSONs in the browser, and converts them to DormouseTheme objects.
 *
 * fflate is dynamically imported so it doesn't affect initial bundle size.
 */

import type { DormouseTheme } from './types';
import { convertVscodeThemeColors, uiThemeToType } from './convert';

const OPENVSX_API = 'https://open-vsx.org/api';

export interface OpenVSXSearchResult {
  extensions: OpenVSXExtension[];
  totalSize: number;
  offset: number;
}

export interface OpenVSXExtension {
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  averageRating?: number;
  downloadCount: number;
  files?: { icon?: string };
}

export async function searchThemes(
  query: string,
  offset = 0,
  size = 20,
): Promise<OpenVSXSearchResult> {
  const params = new URLSearchParams({
    category: 'Themes',
    query,
    size: String(size),
    offset: String(offset),
    sortBy: 'relevance',
    sortOrder: 'desc',
  });
  const res = await fetch(`${OPENVSX_API}/-/search?${params}`);
  if (!res.ok) throw new Error(`OpenVSX search failed: ${res.status}`);
  return res.json();
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Download a theme extension from OpenVSX and return all theme variants
 * as DormouseTheme objects ready for installation.
 */
export async function fetchExtensionThemes(
  namespace: string,
  name: string,
): Promise<DormouseTheme[]> {
  // 1. Get latest version metadata
  const metaRes = await fetch(`${OPENVSX_API}/${namespace}/${name}/latest`);
  if (!metaRes.ok) throw new Error(`OpenVSX metadata failed: ${metaRes.status}`);
  const meta = await metaRes.json();

  const downloadUrl = meta.files?.download;
  if (!downloadUrl) throw new Error(`No download URL for ${namespace}/${name}`);

  // 2. Download VSIX
  const vsixRes = await fetch(downloadUrl);
  if (!vsixRes.ok) throw new Error(`VSIX download failed: ${vsixRes.status}`);
  const vsixBuf = new Uint8Array(await vsixRes.arrayBuffer());

  // 3. Extract (dynamic import — fflate only loaded when needed)
  const { unzipSync } = await import('fflate');
  const entries = unzipSync(vsixBuf);

  // 4. Read package.json
  const pkgData = entries['extension/package.json'];
  if (!pkgData) throw new Error('No package.json in VSIX');
  const pkgJson = JSON.parse(new TextDecoder().decode(pkgData));
  const themeContribs: Array<{ label: string; uiTheme?: string; path: string }> =
    pkgJson.contributes?.themes ?? [];

  // Resolve %key% nls placeholders from package.nls.json if present.
  let nls: Record<string, string | { message?: string }> = {};
  const nlsData = entries['extension/package.nls.json'];
  if (nlsData) {
    try {
      nls = JSON.parse(new TextDecoder().decode(nlsData));
    } catch {
      // Ignore malformed nls; placeholders pass through.
    }
  }
  const resolveNls = (s: string): string =>
    s.replace(/^%([^%]+)%$/, (_, k) => {
      const v = nls[k];
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object' && typeof v.message === 'string') return v.message;
      return `%${k}%`;
    });

  // 5. Parse JSONC (dynamic import to avoid loading at startup)
  const { parse: parseJsonc } = await import('jsonc-parser');

  // 6. Convert each theme variant
  const themes: DormouseTheme[] = [];
  for (const contrib of themeContribs) {
    const themePath = `extension/${contrib.path.replace(/^\.\//, '')}`;
    const themeData = entries[themePath];
    if (!themeData) continue;

    const label = resolveNls(contrib.label);
    const themeJson = parseJsonc(new TextDecoder().decode(themeData));
    const colors: Record<string, string> = themeJson.colors ?? {};
    const vars = convertVscodeThemeColors(colors);
    const type = uiThemeToType(contrib.uiTheme ?? themeJson.type ?? 'vs-dark');

    themes.push({
      id: `${namespace}.${name}.${slugify(label)}`,
      label,
      type,
      swatch: colors['editor.background'] ?? (type === 'light' ? '#ffffff' : '#1e1e1e'),
      accent: colors['focusBorder'] ?? (type === 'light' ? '#0090f1' : '#007fd4'),
      vars,
      origin: {
        kind: 'installed',
        extensionId: `${namespace}/${name}`,
        installedAt: new Date().toISOString(),
      },
    });
  }

  return themes;
}
