import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileViewerFormat } from './file-viewer-format.js';
import { allowsFileViewerRequest } from './file-viewer-loopback-guard.js';

const TEXT_LIMIT = 8 * 1024 * 1024;
const ASSET_LIMIT = 256;
const CHUNK = 64 * 1024;
type Resource = { file: FileHandle; mime: string };
/** A bound on the grant itself: fatal even when reached through an optional asset. */
class ViewerLimitError extends Error {}
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => HTML_ESCAPES[c]!);

async function textSize(file: FileHandle): Promise<number> {
  const { size } = await file.stat();
  if (size > TEXT_LIMIT) throw new ViewerLimitError('text preview exceeds 8 MiB; configure a Tool for this file');
  return size;
}

async function readText(file: FileHandle): Promise<string> {
  const size = await textSize(file);
  const bytes = Buffer.allocUnsafe(size + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset > size) throw new Error('file changed while preparing preview; open it again');
  return bytes.subarray(0, offset).toString('utf8');
}

/** Static local dependencies only. No directory browsing, arbitrary fetch API,
 * or external URL loading. Relative CSS dependencies are followed recursively. */
function references(text: string, html: boolean): string[] {
  const refs: string[] = [];
  if (html) {
    for (const tag of text.matchAll(/<(?:img|script|link|source|video|audio|iframe|embed|object)\b[^>]*>/gi)) {
      for (const attr of tag[0].matchAll(/\b(?:src|href|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        refs.push(attr[1] ?? attr[2] ?? attr[3]);
      }
    }
  }
  for (const match of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)|@import\s+["']([^"']+)["']/gi)) {
    refs.push(match[1] ?? match[2] ?? match[3] ?? match[4]);
  }
  return refs;
}

function finish(res: ServerResponse, status: number, message = ''): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

/** One Tool process owns one file grant and its file descriptors. Restarting
 * creates a fresh capability; only the file argument is persisted by Dormouse. */
export async function startFileViewer(input: string): Promise<{ port: number; path: string; close(): Promise<void> }> {
  // Loaded on demand: this module is bundled into every `dor` invocation, and
  // these two builtins cost more to load than everything else the CLI touches.
  const [{ open, realpath }, { createServer }] = await Promise.all([import('node:fs/promises'), import('node:http')]);
  const target = await realpath(input);
  const format = fileViewerFormat(target);
  if (!format) throw new Error('unsupported file format; configure a user Tool association');
  // A source preview escapes the document; none of its references load.
  const inspectDependencies = !format.text;
  const root = dirname(target);
  const prefix = `/${randomBytes(32).toString('hex')}/`;
  const resources = new Map<string, Resource>();
  const scanned = new Set<string>();
  const closeFiles = async () => { await Promise.all([...resources.values()].map(r => r.file.close())); };
  const outsideRoot = (path: string) => {
    const rel = relative(root, path);
    return isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`);
  };

  async function register(path: string, required: boolean): Promise<Resource | undefined> {
    try {
      const route = `file/${relative(root, path).split(sep).join('/')}`;
      if (resources.has(route)) return resources.get(route);
      const canonical = await realpath(path);
      if (outsideRoot(canonical)) return;
      if (resources.size >= ASSET_LIMIT) throw new ViewerLimitError('local preview exceeds 256 referenced files');
      const type = fileViewerFormat(canonical);
      if (!type) return;
      const file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try { if (!(await file.stat()).isFile()) throw new Error('not a regular file'); }
      catch (error) { await file.close(); throw error; }
      const resource = { file, mime: type.mime };
      resources.set(route, resource); // the grant owns the descriptor from here
      const html = type.mime.startsWith('text/html');
      if (inspectDependencies && (html || type.mime.startsWith('text/css')) && !scanned.has(canonical)) {
        scanned.add(canonical);
        // Inspection is optional: large or changing HTML/CSS can still stream.
        const contents = await readText(file).catch(() => '');
        for (const ref of references(contents, html)) {
          if (!ref || ref.startsWith('/') || ref.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(ref) || ref.includes('\\')) continue;
          let local: string;
          try { local = decodeURIComponent(ref.split(/[?#]/, 1)[0]); } catch { continue; }
          const asset = resolve(dirname(path), local);
          if (outsideRoot(asset)) continue;
          await register(asset, false);
        }
      }
      return resource;
    } catch (error) {
      if (required || error instanceof ViewerLimitError) throw error;
      return; // A missing/broken relative asset stays unavailable; never broaden the grant.
    }
  }

  try {
    const main = await register(target, true);
    if (!main) throw new Error('not a supported regular file');
    if (format.text) await textSize(main.file); // fail oversized text before announcing
    let port = 0;
    const server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // The iframe proxy must retain this policy on every MIME type.
      res.setHeader('X-Dormouse-Preserve-CSP', '1');
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'self'; base-uri 'self'; form-action 'none'");
      if (!allowsFileViewerRequest(req, port, prefix)) { finish(res, 403); return; }
      void (async () => {
        let route: string;
        try { route = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname.slice(prefix.length)); }
        catch { finish(res, 400); return; }
        if (route.includes('\\') || route.split('/').some(part => part === '..' || part === '.')) { finish(res, 403); return; }
        if (route === 'view' && format.text) {
          const text = await readText(main.file);
          const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(basename(target))}</title><style>:root{color-scheme:light dark}body{margin:1rem;background:Canvas;color:CanvasText}pre{font:14px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}</style><pre>${escapeHtml(text)}</pre>`;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
          res.end(req.method === 'HEAD' ? undefined : body);
          return;
        }
        const resource = resources.get(route);
        if (!resource) { finish(res, 404); return; }
        const size = (await resource.file.stat()).size;
        let start = 0;
        let end = size - 1;
        const range = req.headers.range;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || (!match[1] && !match[2])) { res.setHeader('Content-Range', `bytes */${size}`); finish(res, 416); return; }
          start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0 || start >= size) {
            res.setHeader('Content-Range', `bytes */${size}`); finish(res, 416); return;
          }
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        }
        res.writeHead(range ? 206 : 200, { 'Content-Type': resource.mime, 'Content-Length': Math.max(0, end - start + 1), 'Accept-Ranges': 'bytes' });
        if (req.method === 'HEAD' || size === 0) { res.end(); return; }
        // Positional reads let simultaneous range requests share a descriptor,
        // and a disconnected response must not destroy the grant's shared handle.
        // Each chunk is a fresh buffer because res.write queues it without copying.
        for (let offset = start; offset <= end && !res.destroyed;) {
          const chunk = Buffer.allocUnsafe(Math.min(CHUNK, end - offset + 1));
          const { bytesRead } = await resource.file.read(chunk, 0, chunk.length, offset);
          if (!bytesRead) { res.destroy(); return; }
          offset += bytesRead;
          if (!res.write(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead)) && !res.destroyed) await new Promise<void>(done => {
            const complete = () => { res.off('drain', complete); res.off('close', complete); done(); };
            res.once('drain', complete);
            res.once('close', complete);
          });
        }
        res.end();
      })().catch(() => { if (res.headersSent) res.destroy(); else finish(res, 500, 'File preview unavailable'); });
    });
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    port = (server.address() as { port: number }).port;
    let closing: Promise<void> | undefined;
    return { port, path: `${prefix}${format.text ? 'view' : `file/${encodeURIComponent(basename(target))}`}`,
      close: () => closing ??= new Promise<void>((yes, no) => {
        server.close(error => { void closeFiles().then(() => error ? no(error) : yes(), no); });
        server.closeAllConnections();
      }),
    };
  } catch (error) { await closeFiles(); throw error; }
}

/** The `dor __view-file <file>` entry: starts the viewer, which outlives the
 * call, and returns the OSC 367 announcement for the caller to print. */
export async function runFileViewer(file: string): Promise<string> {
  const viewer = await startFileViewer(file);
  const stop = () => { void viewer.close().then(() => { process.exitCode = 0; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return `\x1b]367;serve;${JSON.stringify({ port: viewer.port, path: viewer.path, v: 1 })}\x07`;
}
