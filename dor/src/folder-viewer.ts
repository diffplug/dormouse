import type { Dirent } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { resolveBinaryPath, spawnAndCapture } from 'dor-lib-common';
import { errorMessage } from './commands/shared.js';
import type { ControlClient } from './commands/types.js';
import { folderViewerPage } from './folder-viewer-page.js';
import { announceViewer, HttpError, isInsideRoot, pathSegments, reply, startCapabilityViewer } from './viewer-server.js';

const ENTRY_LIMIT = 5000;
const BODY_LIMIT = 8 * 1024;
const GIT_TIMEOUT_MS = 5000;
const GIT_OUTPUT_LIMIT = 4 * 1024 * 1024;
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

export type FolderEntryKind = 'dir' | 'file' | 'other';
export interface FolderEntry { name: string; kind: FolderEntryKind; ignored: boolean }
export type FolderOpenResult = { ok: true; status: string } | { ok: false; error: string };
/** Opens a canonical path inside the root: `preview` for select, pinned for activate. */
export type FolderOpen = (path: string, preview: boolean) => Promise<FolderOpenResult>;

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** The `names` in `dir` that `git` ignores. Any failure (no git, not a
 * repository, a timeout) answers none: ignore state only dims entries. */
async function gitIgnored(git: string | undefined, dir: string, names: string[]): Promise<Set<string>> {
  if (!git || !names.length) return new Set();
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
  const { opendir, realpath, stat } = await import('node:fs/promises');
  const root = await realpath(input);
  if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
  const page = folderViewerPage(root);
  // Resolved once, at start. PATH-resolved, never the bare name, which Windows also
  // searches for in the cwd: this process runs in the folder it lists
  // (docs/specs/dor-cli.md -> "Spawning External Binaries").
  const git = resolveBinaryPath('git', process.env);

  /** The canonical path the page-supplied POSIX path `rel` names: it must
   * exist, and be the root or inside it. */
  async function resolveInside(rel: string): Promise<string> {
    const parts = rel === '' ? [] : pathSegments(rel, { strict: true });
    if (!parts) throw new HttpError(403, 'invalid path');
    let canonical: string;
    try { canonical = await realpath(join(root, ...parts)); } catch { throw new HttpError(404, 'no such entry'); }
    if (!isInsideRoot(root, canonical)) throw new HttpError(403, 'outside the folder');
    return canonical;
  }

  /** Follows a symlink for its kind, except one whose target leaves the root. */
  async function kindOf(dir: string, entry: Dirent): Promise<FolderEntryKind> {
    if (entry.isDirectory()) return 'dir';
    if (entry.isFile()) return 'file';
    if (!entry.isSymbolicLink()) return 'other';
    try {
      const target = await realpath(join(dir, entry.name));
      if (!isInsideRoot(root, target)) return 'other';
      const stats = await stat(target);
      return stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other';
    } catch { return 'other'; }
  }

  async function list(rel: string): Promise<{ entries: FolderEntry[]; truncated: boolean }> {
    const dir = await resolveInside(rel);
    const handle = await opendir(dir, { bufferSize: 512 }).catch(() => { throw new HttpError(404, 'not a directory'); });
    const dirents: Dirent[] = [];
    let truncated = false;
    for await (const entry of handle) {
      if (dirents.length === ENTRY_LIMIT) { truncated = true; break; }
      dirents.push(entry);
    }
    const [kinds, ignored] = await Promise.all([
      Promise.all(dirents.map(entry => kindOf(dir, entry))), gitIgnored(git, dir, dirents.map(entry => entry.name)),
    ]);
    // Directories first, then by lowercased name, then by name.
    const keyed = dirents.map((entry, i) => ({ folded: entry.name.toLowerCase(), entry: { name: entry.name, kind: kinds[i], ignored: ignored.has(entry.name) } }));
    keyed.sort((a, b) => Number(a.entry.kind !== 'dir') - Number(b.entry.kind !== 'dir') || compare(a.folded, b.folded) || compare(a.entry.name, b.entry.name));
    return { entries: keyed.map(item => item.entry), truncated };
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

  const viewer = await startCapabilityViewer({ csp: CSP, post: true, unavailable: 'Folder viewer unavailable',
    route: async (req, res, prefix) => {
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
    },
  });
  return { port: viewer.port, path: viewer.prefix, root, close: viewer.close };
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
  return announceViewer(viewer);
}
