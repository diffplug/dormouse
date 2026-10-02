import type { Dirent } from 'node:fs';
import { opendir, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { resolveBinaryPath, spawnAndCapture } from 'dor-lib-common';
import { openSequence, validToolOpenPath } from 'dor-tools-lib/osc';
import { folderViewerPage } from './folder-viewer-page.js';
import { announceViewer, HttpError, isInsideRoot, pathSegments, readJsonBody, reply, startCapabilityViewer } from './viewer-server.js';

/** Entries one listing returns. */
const ENTRY_LIMIT = 5000;
/** Names one listing reads to choose them: a bound on its memory. */
const READ_LIMIT = 100_000;
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
type Ordered = { dir: boolean; folded: string; entry: { name: string } };
/** Directories first, then by lowercased name, then by name. */
const byDisplayOrder = (a: Ordered, b: Ordered): number =>
  Number(!a.dir) - Number(!b.dir) || compare(a.folded, b.folded) || compare(a.entry.name, b.entry.name);

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
      if (dirents.length === READ_LIMIT) { truncated = true; break; }
      dirents.push(entry);
    }
    // Sorted before the cap, on the kind readdir knows without a stat (a
    // symlink counts as a file here), so a cut listing keeps its head.
    const kept = dirents.map(entry => ({ entry, dir: entry.isDirectory(), folded: entry.name.toLowerCase() })).sort(byDisplayOrder);
    if (kept.length > ENTRY_LIMIT) { kept.length = ENTRY_LIMIT; truncated = true; }
    const [kinds, ignored] = await Promise.all([
      Promise.all(kept.map(item => kindOf(dir, item.entry))), gitIgnored(git, dir, kept.map(item => item.entry.name)),
    ]);
    const keyed = kept.map((item, i) => ({ ...item, dir: kinds[i] === 'dir', kind: kinds[i] })).sort(byDisplayOrder);
    // Inspect at most two real entries per hop: ignored/hidden siblings still
    // stop compaction. Never follow a symlink as a compacted child, and bound
    // both depth and concurrent directory handles for huge/generated trees.
    async function compact(name: string, kind: FolderEntryKind): Promise<string> {
      if (kind !== 'dir') return name;
      let path = join(dir, name);
      let display = name;
      for (let depth = 0; depth < 32; depth++) {
        try {
          if (!isInsideRoot(root, await realpath(path))) break;
          const children: Dirent[] = [];
          for await (const child of await opendir(path)) {
            children.push(child);
            if (children.length === 2) break;
          }
          if (children.length !== 1 || !children[0].isDirectory()) break;
          display += '/' + children[0].name;
          path = join(path, children[0].name);
        } catch { break; }
      }
      return display;
    }
    // Sixteen workers share the queue, so one deep chain never idles the rest.
    const entries: FolderEntry[] = new Array(keyed.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(16, keyed.length) }, async () => {
      for (let i = next++; i < keyed.length; i = next++) {
        const { entry, kind } = keyed[i];
        entries[i] = { name: await compact(entry.name, kind), kind, ignored: ignored.has(entry.name) };
      }
    }));
    return { entries, truncated };
  }

  async function requestedPath(req: IncomingMessage): Promise<string> {
    const path = (await readJsonBody(req, BODY_LIMIT) as { path?: unknown } | null)?.path;
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
 * call, and returns its title and OSC 367 announcement for the caller to print.
 * Select and activate write OSC 367 `open` to this Tool's terminal, in the
 * order the page sends them; the host answers nothing, showing a failure in
 * the preview slot. */
export async function runFolderViewer(dir: string): Promise<string> {
  const viewer = await startFolderViewer(dir, { open: oscOpen(text => process.stdout.write(text)) });
  return announceViewer(viewer, viewer.root);
}

/** Writes each open as an OSC 367 `open`. A path the host would refuse (a
 * control character, a UNC root, over the length limit) answers an error the
 * page shows, rather than throwing into a 500. */
export function oscOpen(write: (text: string) => void): FolderOpen {
  return async (path, preview) => {
    let sequence: string;
    try {
      if (!validToolOpenPath(path)) throw new RangeError('invalid Tool open path');
      sequence = openSequence({ path, preview });
    } catch {
      // A field can fit its own bound while JSON escaping exceeds the host's
      // serialized payload cap. Report that refusal to the page without a write.
      return { ok: false, error: `Cannot open ${JSON.stringify(path)} from a Tool` };
    }
    write(sequence);
    return { ok: true, status: 'sent' };
  };
}
