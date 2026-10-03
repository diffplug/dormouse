/** The browser-safe half of the viewer servers (`viewer-server.ts`): what
 * the website playground's virtual viewers share with them. */
import { serveSequence } from 'dor-tools-lib/osc';
import { CONTROLS, viewerTitle } from './file-viewer-format.js';

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `s` as HTML text or a quoted attribute value. */
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, c => HTML_ESCAPES[c]!);

/** Thrown by a route to answer with `status` and `message` as plain text. */
export class HttpError extends Error {
  constructor(readonly status: number, message = '') { super(message); }
}

/** The headers every viewer response carries, under its page's `csp`. */
export function viewerHeaders(csp: string): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': csp,
  };
}

/** `path`'s `/` segments; null when its spelling alone could leave a root: a
 * backslash or a `.` or `..` segment, and when `strict`, an empty segment or a
 * control character. Containment is decided on the realpath. */
export function pathSegments(path: string, { strict = false } = {}): string[] | null {
  const parts = path.split('/');
  const refused = path.includes('\\') || (strict && CONTROLS.test(path))
    || parts.some(part => part === '.' || part === '..' || (strict && part === ''));
  return refused ? null : parts;
}

/** What a `dor __view-*` entry prints for its caller: an OSC 2 title naming
 * `target` and the OSC 367 `serve` announcement, declaring `dehydrate` when the
 * viewer emits its state on the graceful-stop signal. */
export function viewerAnnouncement(viewer: { port: number; path: string }, target: string, { dehydrate = false } = {}): string {
  const { port, path } = viewer;
  return `\x1b]2;${viewerTitle(target)}\x07${serveSequence(dehydrate ? { port, path, dehydrate } : { port, path })}`;
}
