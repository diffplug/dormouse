// Browser-safe: the website playground serves the viewer pages from these.
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `s` as HTML text or a quoted attribute value. */
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, c => HTML_ESCAPES[c]!);

/** The last segment of a POSIX or Windows path, as `node:path`'s `basename` names it for a title. */
export const lastSegment = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
