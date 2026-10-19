import { realpath, type FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { openSequence, stateSequence, type ToolOpen } from 'dor-tools-lib/osc';
import { editableImageType, fileViewerFormat, type FileFormat } from './file-viewer-format.js';
import { announceViewer, contentType, HttpError, isInsideRoot, openRegularFile, pathSegments, readBody, reply, startCapabilityViewer } from './viewer-server.js';
import { EDITOR_CSP } from './editor-page.js';
import { editorKind, editorRoutes, imagesRoute, storePath, TEXT_BOUND } from './editor-routes.js';
import { openImage } from './markdown-images.js';
import { readUpTo } from './editable-file.js';
import { editorStore } from './editor-store.js';
import { viewerAsset } from './viewer-assets.js';
import { IMAGE_CSP } from './image-format.js';
import { EDITABILITY_HEAD, imageEditability } from './image-editability.js';

const ASSET_LIMIT = 256;
const CHUNK = 64 * 1024;
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'self'; base-uri 'self'; form-action 'none'";
type Resource = { file: FileHandle; mime: string };
/** A bound on the grant itself: fatal even when reached through an optional asset. */
class ViewerLimitError extends Error {}

async function textSize(file: FileHandle): Promise<number> {
  const { size } = await file.stat();
  if (size > TEXT_BOUND.limit) throw new ViewerLimitError('text preview exceeds 8 MiB; configure a Tool for this file');
  return size;
}

/** The first `EDITABILITY_HEAD` bytes of `file`, which is `size` long. */
async function head(file: FileHandle, size: number): Promise<Uint8Array> {
  const bytes = Buffer.allocUnsafe(Math.min(size, EDITABILITY_HEAD));
  const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
  return bytes.subarray(0, bytesRead);
}

async function readText(file: FileHandle): Promise<string> {
  const size = await textSize(file);
  const bytes = await readUpTo(file, size);
  if (bytes.length > size) throw new Error('file changed while preparing preview; open it again');
  return bytes.toString('utf8');
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

/** `resource`'s bytes, honoring one byte range and HEAD. */
async function stream(req: IncomingMessage, res: ServerResponse, resource: Resource): Promise<void> {
  const size = (await resource.file.stat()).size;
  let start = 0;
  let end = size - 1;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) { res.setHeader('Content-Range', `bytes */${size}`); throw new HttpError(416); }
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0 || start >= size) {
      res.setHeader('Content-Range', `bytes */${size}`); throw new HttpError(416);
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
}

/** One Tool process owns one file grant and its file descriptors. Restarting
 * creates a fresh capability; only the file argument is persisted by Dormouse.
 *
 * `formatOf` is the handler's (`BuiltinHandler.format`): `builtin:code`'s
 * serves every textual format as source. */
export async function startFileViewer(input: string, { onDirty = () => {}, onOpen = () => {}, formatOf = fileViewerFormat }: { onDirty?: (dirty: boolean) => void; onOpen?: (open: ToolOpen) => void; formatOf?: (path: string) => FileFormat | null } = {}): Promise<{ port: number; path: string; target: string; editable: boolean; close(): Promise<void> }> {
  const target = await realpath(input);
  const format = formatOf(target);
  if (!format) throw new Error('unsupported file format; configure a user Tool association');
  // Source reaches Monaco as inert JSON; none of its references load.
  const inspectDependencies = !format.text;
  const root = dirname(target);
  const resources = new Map<string, Resource>();
  const scanned = new Set<string>();
  const closeFiles = async () => { await Promise.all([...resources.values()].map(r => r.file.close())); };

  async function register(path: string, required: boolean): Promise<Resource | undefined> {
    try {
      const route = `file/${relative(root, path).split(sep).join('/')}`;
      if (resources.has(route)) return resources.get(route);
      const canonical = await realpath(path);
      if (!isInsideRoot(root, canonical)) return;
      if (resources.size >= ASSET_LIMIT) throw new ViewerLimitError('local preview exceeds 256 referenced files');
      const type = fileViewerFormat(canonical);
      if (!type) return;
      const file = await openRegularFile(canonical);
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
          if (!isInsideRoot(root, asset)) continue;
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
    // Fails oversized text before announcing; a PNG or JPEG the editor leaves
    // view-only streams (docs/specs/dor-tools-builtin.md -> Image editor).
    const size = format.text ? await textSize(main.file) : (await main.file.stat()).size;
    const kind = editorKind(format, editableImageType(target) ? imageEditability(size, await head(main.file, size)) : null);
    const editable = !!kind;
    const editor = kind && editorRoutes({ kind, file: storePath(target), name: basename(target), store: editorStore(root), onDirty,
      openLink: (link, disposition) => {
        const open = { path: link.path ? resolve(root, link.path) : target, preview: false, disposition, fragment: link.fragment };
        openSequence(open); // Bound and validate before handing even a test callback the request.
        onOpen(open);
      },
    });
    const viewer = await startCapabilityViewer({ csp: editable ? EDITOR_CSP : CSP, post: editable, chunked: true, unavailable: 'File preview unavailable', release: closeFiles,
      route: async (req, res, prefix) => {
        let route: string;
        const url = new URL(req.url!, 'http://localhost');
        try { route = decodeURIComponent(url.pathname.slice(prefix.length)); }
        catch { throw new HttpError(400); }
        if (!pathSegments(route)) throw new HttpError(403);
        const answer = await editor?.({ method: req.method!, route, query: url.searchParams, contentType: contentType(req), body: bound => readBody(req, bound.limit, bound.message) });
        if (answer) {
          for (const [name, value] of Object.entries(answer.headers ?? {})) res.setHeader(name, value);
          reply(res, 200, answer.body, answer.type);
          return;
        }
        if (editable && route.startsWith('assets/')) {
          const asset = await viewerAsset(route.slice('assets/'.length));
          reply(res, 200, asset.bytes, asset.mime);
          return;
        }
        const resource = resources.get(route);
        if (resource) { await stream(req, res, resource); return; }
        const segments = imagesRoute(kind, route);
        if (!segments) throw new HttpError(404);
        const image = await openImage(root, segments);
        try {
          res.setHeader('Content-Security-Policy', IMAGE_CSP);
          await stream(req, res, image);
        } finally { await image.file.close(); }
      },
    });
    return { port: viewer.port, path: `${viewer.prefix}${editable ? 'view' : `file/${encodeURIComponent(basename(target))}`}`, target, editable, close: viewer.close };
  } catch (error) { await closeFiles(); throw error; }
}

/** The `dor __view-file <file>` entry, and `__view-code`'s: starts the viewer, which outlives the
 * call, and returns its title and OSC 367 announcement for the caller to print. */
export async function runFileViewer(file: string, formatOf: (path: string) => FileFormat | null): Promise<string> {
  const viewer = await startFileViewer(file, { formatOf, onDirty: dirty => { process.stdout.write(stateSequence({ dirty })); }, onOpen: open => { process.stdout.write(openSequence(open)); } });
  // An editor reports its own state once loaded; a view of anything else
  // cannot change, so it is clean from the start (docs/specs/dor-tools-builtin.md).
  return announceViewer(viewer, viewer.target) + (viewer.editable ? '' : stateSequence({ dirty: false }));
}
