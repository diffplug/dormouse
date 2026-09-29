import { randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, relative, sep } from 'node:path';
import { resolveBinaryPath, spawnAndCapture } from 'dor-lib-common';
import { errorMessage } from './commands/shared.js';
import type { ControlClient } from './commands/types.js';
import { allowsFileViewerRequest } from './file-viewer-loopback-guard.js';
import { folderViewerPage } from './folder-viewer-page.js';

const ENTRY_LIMIT = 5000;
const BODY_LIMIT = 8 * 1024;
const GIT_TIMEOUT_MS = 5000;
const GIT_OUTPUT_LIMIT = 4 * 1024 * 1024;
/** Backslashes and C0, DEL, and C1 controls never appear in a path the page may name. */
const REJECTED = /[\\\x00-\x1f\x7f-\x9f]/;

export type FolderEntryKind = 'dir' | 'file' | 'other';
export interface FolderEntry { name: string; kind: FolderEntryKind; ignored: boolean }
export type FolderOpenResult = { ok: true; status: string } | { ok: false; error: string };
/** Opens a canonical path inside the root: `preview` for select, pinned for activate. */
export type FolderOpen = (path: string, preview: boolean) => Promise<FolderOpenResult>;

class HttpError extends Error {
  constructor(readonly status: number, message = '') { super(message); }
}

/** Node sends no body on a HEAD response. */
function reply(res: ServerResponse, status: number, body = '', type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** A page-supplied POSIX path relative to the root, as its segments; null when
 * its spelling alone could leave the root. Containment is decided on the realpath. */
function segments(path: string): string[] | null {
  if (path === '') return [];
  const parts = path.split('/');
  return REJECTED.test(path) || parts.some(part => part === '' || part === '.' || part === '..') ? null : parts;
}

const compareNames = (a: string, b: string): number => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** The `names` in `dir` that git ignores. Any failure (no git, not a
 * repository, a timeout) answers none: ignore state only dims entries. */
async function gitIgnored(dir: string, names: string[]): Promise<Set<string>> {
  // PATH-resolved, never the bare name, which Windows also searches for in the
  // cwd: this process runs in the folder it lists (docs/specs/dor-cli.md ->
  // "Spawning External Binaries").
  const git = resolveBinaryPath('git', process.env);
  if (!git) return new Set();
  // Reading the index runs `core.fsmonitor`, which the listed folder's own
  // `.git/config` may name. `./` keeps a leading `:` from reading as pathspec
  // magic; git resolves each path's type itself, so dir-only patterns match.
  const result = await spawnAndCapture(git, ['-c', 'core.fsmonitor=false', 'check-ignore', '-z', '--stdin'], {
    cwd: dir, input: names.map(name => `./${name}\0`).join(''), timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: GIT_OUTPUT_LIMIT,
  });
  // Exit 1 is git's "none ignored"; 128 is "not a repository" or a refused query.
  return new Set(result.ok && result.exitCode === 0 ? result.stdout.split('\0').map(path => path.slice(2)) : []);
}

/** One Tool process lists one canonical root, a directory at a time, and never
 * serves file contents: select and activate hand a path to `open`. */
export async function startFolderViewer(input: string, { open }: { open: FolderOpen }): Promise<{ port: number; path: string; root: string; close(): Promise<void> }> {
  // Loaded on demand, as in the file viewer: this module is bundled into every `dor` invocation.
  const [{ opendir, realpath, stat }, { createServer }] = await Promise.all([import('node:fs/promises'), import('node:http')]);
  const root = await realpath(input);
  if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
  const prefix = `/${randomBytes(32).toString('hex')}/`;
  const page = folderViewerPage(root);
  const inside = (path: string) => {
    const rel = relative(root, path);
    return !(isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`));
  };

  /** The canonical path `rel` names: it must exist, and be the root or inside it. */
  async function resolveInside(rel: string): Promise<string> {
    const parts = segments(rel);
    if (!parts) throw new HttpError(403, 'invalid path');
    let canonical: string;
    try { canonical = await realpath(join(root, ...parts)); } catch { throw new HttpError(404, 'no such entry'); }
    if (!inside(canonical)) throw new HttpError(403, 'outside the folder');
    return canonical;
  }

  /** Follows a symlink for its kind, except one whose target leaves the root. */
  async function kindOf(dir: string, entry: Dirent): Promise<FolderEntryKind> {
    if (entry.isDirectory()) return 'dir';
    if (entry.isFile()) return 'file';
    if (!entry.isSymbolicLink()) return 'other';
    try {
      const target = await realpath(join(dir, entry.name));
      if (!inside(target)) return 'other';
      const stats = await stat(target);
      return stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other';
    } catch { return 'other'; }
  }

  async function list(rel: string): Promise<{ entries: FolderEntry[]; truncated: boolean }> {
    const dir = await resolveInside(rel);
    const handle = await opendir(dir).catch(() => { throw new HttpError(404, 'not a directory'); });
    const dirents: Dirent[] = [];
    let truncated = false;
    for await (const entry of handle) {
      if (dirents.length === ENTRY_LIMIT) { truncated = true; break; }
      dirents.push(entry);
    }
    const [kinds, ignored] = await Promise.all([
      Promise.all(dirents.map(entry => kindOf(dir, entry))), gitIgnored(dir, dirents.map(entry => entry.name)),
    ]);
    const entries = dirents.map((entry, i) => ({ name: entry.name, kind: kinds[i], ignored: ignored.has(entry.name) }));
    entries.sort((a, b) => Number(a.kind !== 'dir') - Number(b.kind !== 'dir') || compareNames(a.name, b.name));
    return { entries, truncated };
  }

  async function requestedPath(req: IncomingMessage): Promise<string> {
    if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415);
    const chunks: Buffer[] = [];
    let size = 0;
    await new Promise<void>((done, fail) => {
      req.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= BODY_LIMIT) chunks.push(chunk); });
      req.on('end', done);
      req.on('error', fail);
    });
    if (size > BODY_LIMIT) throw new HttpError(413);
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400); }
    const path = (body as { path?: unknown } | null)?.path;
    if (typeof path !== 'string' || !path) throw new HttpError(400);
    return path;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, 'http://localhost');
    const name = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : undefined;
    if (req.method === 'POST') {
      if (name !== 'select' && name !== 'activate') throw new HttpError(404);
      const target = await resolveInside(await requestedPath(req));
      reply(res, 200, JSON.stringify(await open(target, name === 'select')), 'application/json');
    } else if (name === '') {
      reply(res, 200, page, 'text/html; charset=utf-8');
    } else if (name === 'list') {
      reply(res, 200, JSON.stringify(await list(url.searchParams.get('dir') ?? '')), 'application/json');
    } else {
      throw new HttpError(404);
    }
  }

  let port = 0;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The iframe proxy must retain this policy.
    res.setHeader('X-Dormouse-Preserve-CSP', '1');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'");
    if (!allowsFileViewerRequest(req, port, prefix, { post: true })) { reply(res, 403); return; }
    route(req, res).catch(error => {
      if (res.headersSent) res.destroy();
      else reply(res, error instanceof HttpError ? error.status : 500, error instanceof HttpError ? error.message : 'Folder viewer unavailable');
    });
  });
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  port = (server.address() as { port: number }).port;
  let closing: Promise<void> | undefined;
  return { port, path: prefix, root,
    close: () => closing ??= new Promise<void>((yes, no) => {
      server.close(error => error ? no(error) : yes());
      server.closeAllConnections();
    }),
  };
}

/** The `dor __view-folder <dir>` entry: starts the viewer, which outlives the
 * call, and returns the OSC 367 announcement for the caller to print. Select
 * and activate run `dor open` through the control client, or report why none is available. */
export async function runFolderViewer(dir: string, client: ControlClient | Error): Promise<string> {
  const viewer = await startFolderViewer(dir, {
    // Requests are served only after `viewer` is assigned.
    open: async (file, preview) => {
      if (client instanceof Error) return { ok: false, error: client.message };
      try {
        const response = await client.toolSurface({ file, preview, cwd: viewer.root, fresh: false, minimized: false });
        return { ok: true, status: response.status };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  });
  const stop = () => { void viewer.close().then(() => { process.exitCode = 0; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return `\x1b]367;serve;${JSON.stringify({ port: viewer.port, path: viewer.path, v: 1 })}\x07`;
}
