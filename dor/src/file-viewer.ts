import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileViewerFormat } from './file-viewer-format.js';
import { allowsFileViewerRequest } from './file-viewer-loopback-guard.js';

const TEXT_LIMIT = 8 * 1024 * 1024;
const ASSET_LIMIT = 256;
type Resource = { file: FileHandle; mime: string; text: boolean; path: string };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

async function readText(file: FileHandle): Promise<string> {
  const size = (await file.stat()).size;
  if (size > TEXT_LIMIT) throw new Error('text preview exceeds 8 MiB; configure a Tool for this file');
  const bytes = Buffer.alloc(size + 1);
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
  const target = await realpath(input);
  const format = fileViewerFormat(target);
  if (!format) throw new Error('unsupported file format; configure a user Tool association');
  const root = dirname(target);
  const prefix = `/${randomBytes(32).toString('hex')}/`;
  const resources = new Map<string, Resource>();
  const paths = new Set<string>();
  const closeFiles = async () => { await Promise.all([...resources.values()].map(r => r.file.close())); };

  async function register(path: string, required: boolean): Promise<void> {
    let file: FileHandle | undefined;
    try {
      const canonical = await realpath(path);
      const rel = relative(root, canonical);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return;
      const route = `file/${relative(root, path).split(sep).join('/')}`;
      if (resources.has(route)) return;
      if (resources.size >= ASSET_LIMIT) throw new Error('local preview exceeds 256 referenced files');
      const type = fileViewerFormat(canonical);
      if (!type) return;
      file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      if (!(await file.stat()).isFile()) throw new Error('not a regular file');
      const resource = { file, ...type, path: canonical };
      resources.set(route, resource);
      file = undefined; // grant owns it now
      if (paths.has(canonical)) return;
      paths.add(canonical);
      const html = type.mime.startsWith('text/html');
      if (html || type.mime.startsWith('text/css')) {
        const contents = await readText(resource.file);
        for (const ref of references(contents, html)) {
          if (!ref || ref.startsWith('/') || ref.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(ref) || ref.includes('\\')) continue;
          let local: string;
          try { local = decodeURIComponent(ref.split(/[?#]/, 1)[0]); } catch { continue; }
          const asset = resolve(dirname(path), local);
          const inside = relative(root, asset);
          if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) continue;
          await register(asset, false);
        }
      }
    } catch (error) {
      if (required || (error instanceof Error && /exceeds/.test(error.message))) throw error;
      // A missing/broken relative asset stays unavailable; never broaden the grant.
    } finally { await file?.close(); }
  }

  try {
    await register(target, true);
    const main = resources.get(`file/${basename(target)}`)!;
    if (!main) throw new Error('not a supported regular file');
    if (format.text) await readText(main.file); // fail oversized text before announcing
    let port = 0;
    const server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
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
        // Positional reads let simultaneous range requests share a descriptor.
        // A disconnected response must not destroy the grant's shared handle.
        const buffer = Buffer.alloc(64 * 1024);
        for (let offset = start; offset <= end && !res.destroyed;) {
          const { bytesRead } = await resource.file.read(buffer, 0, Math.min(buffer.length, end - offset + 1), offset);
          if (!bytesRead) { res.destroy(); return; }
          offset += bytesRead;
          const chunk = Buffer.from(buffer.subarray(0, bytesRead));
          if (!res.write(chunk) && !res.destroyed) await new Promise<void>(done => {
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

export async function runFileViewer(file: string): Promise<void> {
  const viewer = await startFileViewer(file);
  const stop = () => { void viewer.close().then(() => { process.exitCode = 0; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.write(`\x1b]367;serve;${JSON.stringify({ port: viewer.port, path: viewer.path, v: 1 })}\x07`);
}
