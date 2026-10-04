import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as nodePath from 'node:path';
import { allowsFileViewerRequest } from './file-viewer-loopback-guard.js';
import { HttpError, mediaType, parseJsonBody, viewerAnnouncement, viewerHeaders } from './viewer-http.js';

export { HttpError, pathSegments } from './viewer-http.js';

const TEXT = 'text/plain; charset=utf-8';


/** Node sends no body on a HEAD response. */
export function reply(res: ServerResponse, status: number, body: string | Uint8Array = '', type = TEXT): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** A POST's JSON body, as `parseJsonBody` reads it through `readBody`. */
export const readJsonBody = (req: IncomingMessage, limit: number): Promise<unknown> =>
  parseJsonBody(contentType(req), limit, bound => readBody(req, bound));

/** A request's media type, as `mediaType` gives it. */
export const contentType = (req: IncomingMessage) => mediaType(req.headers['content-type'] ?? '');

/** A request body; 413 with `tooLarge` past `limit` bytes, as `readJsonBody`. */
export async function readBody(req: IncomingMessage, limit: number, tooLarge = ''): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((done, fail) => {
    req.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= limit) chunks.push(chunk); });
    req.on('end', done);
    req.on('error', fail);
  });
  if (size > limit) throw new HttpError(413, tooLarge);
  return Buffer.concat(chunks);
}

/** `path` opened read-only without following a final symlink, when it is a
 * regular file; the caller owns the descriptor. */
export async function openRegularFile(path: string): Promise<FileHandle> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try { if (!(await file.stat()).isFile()) throw new Error('not a regular file'); }
  catch (error) { await file.close(); throw error; }
  return file;
}

type PathModule = Pick<nodePath.PlatformPath, 'isAbsolute' | 'relative' | 'resolve' | 'sep'>;

/** Whether the absolute `path` is `root` or under it. */
export function isInsideRoot(root: string, path: string, { isAbsolute, relative, sep }: PathModule = nodePath): boolean {
  const rel = relative(root, path);
  return !(isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`));
}

/** `segments` (as `pathSegments` gives them) under the absolute `root`, as an
 * absolute path when its spelling stays there; else null. On Windows a `:`
 * spells a drive-relative path or an alternate data stream, so no segment
 * holds one. Containment of what it names is decided on the realpath. */
export function resolveInside(root: string, segments: string[], path: PathModule = nodePath): string | null {
  if (path.sep === '\\' && segments.some(segment => segment.includes(':'))) return null;
  const resolved = path.resolve(root, ...segments);
  return isInsideRoot(root, resolved, path) ? resolved : null;
}


export interface CapabilityViewer { port: number; prefix: string; close(): Promise<void> }

/** A loopback listener whose every URL sits under a fresh 256-bit capability
 * `prefix`: `allowsFileViewerRequest` gates each request before `route` sees it.
 * The scaffold answers a refused request 403, a route's `HttpError` with its
 * status, and any other failure 500 `unavailable`; `chunked` answers those
 * without Content-Length, as the file viewer does. `release` runs once the
 * server has closed. */
export async function startCapabilityViewer({ csp, post = false, chunked = false, unavailable, release, route }: {
  csp: string;
  post?: boolean;
  chunked?: boolean;
  unavailable: string;
  release?: () => Promise<void>;
  route(req: IncomingMessage, res: ServerResponse, prefix: string): Promise<void>;
}): Promise<CapabilityViewer> {
  const prefix = `/${randomBytes(32).toString('hex')}/`;
  const answer = (res: ServerResponse, status: number, message = '') => {
    if (!chunked) { reply(res, status, message); return; }
    res.writeHead(status, { 'Content-Type': TEXT });
    res.end(message);
  };
  let port = 0;
  const server = createServer((req, res) => {
    for (const [name, value] of Object.entries(viewerHeaders(csp))) res.setHeader(name, value);
    // The iframe proxy must retain this policy on every MIME type.
    res.setHeader('X-Dormouse-Preserve-CSP', '1');
    if (!allowsFileViewerRequest(req, port, prefix, { post })) { answer(res, 403); return; }
    route(req, res, prefix).catch(error => {
      if (res.headersSent) res.destroy();
      else if (error instanceof HttpError) answer(res, error.status, error.message);
      else answer(res, 500, unavailable);
    });
  });
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  port = (server.address() as { port: number }).port;
  let closing: Promise<void> | undefined;
  return { port, prefix,
    close: () => closing ??= new Promise<void>((yes, no) => {
      server.close(error => { void (release?.() ?? Promise.resolve()).then(() => error ? no(error) : yes(), no); });
      server.closeAllConnections();
    }),
  };
}

/** Stops `viewer` on SIGINT or SIGTERM, and returns what the `dor __view-*`
 * entry prints for its caller: an OSC 2 title naming `target` and the OSC 367
 * `serve` announcement (docs/specs/dor-tools-builtin.md -> File viewer). With
 * `dehydrate`, the viewer declares itself safe to stop and writes that
 * sequence on the way out (docs/specs/dor-tool.md -> Reaping). */
export function announceViewer(
  viewer: { port: number; path: string; close(): Promise<void> },
  target: string,
  { dehydrate }: { dehydrate?: () => string | null } = {},
): string {
  const stop = () => {
    // Fidelity, never correctness: a state that cannot be written is dropped,
    // and the stop goes on.
    let sequence: string | null = null;
    try { sequence = dehydrate?.() ?? null; } catch { /* restart from args */ }
    if (sequence) process.stdout.write(sequence);
    void viewer.close().then(() => { process.exitCode = 0; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return viewerAnnouncement(viewer, target, { dehydrate: dehydrate !== undefined });
}
