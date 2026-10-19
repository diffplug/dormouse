import { validToolFragment } from 'dor-tools-lib/osc';
import { CONTROLS } from './file-viewer-format.js';

const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/** A link that keeps the page's own web/mail handling instead of opening a document. */
export function isWebLink(href: string): boolean {
  return /^(?:https?:|mailto:)/i.test(href.trim());
}

/** URL syntax is removed before decoding, so `%23` still names a file's `#`.
 * This parses a document reference, never a URL against the capability URL. */
export function markdownLink(href: string): { path: string; fragment?: string } | null {
  if (!href || href.length > 4096 || SCHEME.test(href.trim()) || href.includes('\\')) return null;
  const hash = href.indexOf('#');
  try {
    const path = decodeURIComponent((hash < 0 ? href : href.slice(0, hash)).split('?', 1)[0]);
    const fragment = hash < 0 ? undefined : decodeURIComponent(href.slice(hash + 1));
    if (path.startsWith('/') || path.includes('\\') || SCHEME.test(path) || CONTROLS.test(path)
      || (fragment !== undefined && !validToolFragment(fragment))) return null;
    return { path, ...(fragment === undefined ? {} : { fragment }) };
  } catch { return null; }
}

/** Render-only heading ids. The suffix counter includes naturally suffixed
 * names too, so `A`, `A`, `A-1` never produce duplicate DOM ids. */
export function headingIds(texts: readonly string[]): string[] {
  const used = new Set<string>();
  return texts.map(text => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/ /g, '-');
    let id = base, n = 0;
    while (used.has(id)) id = `${base}-${++n}`;
    used.add(id);
    return id;
  });
}
