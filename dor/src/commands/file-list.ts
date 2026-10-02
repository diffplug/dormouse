/**
 * The files `dor open` with no path offers (`docs/specs/dor-tool.md` ->
 * Choosing a file): git's view of the tree under `cwd` when it is in a work
 * tree, otherwise a bounded walk.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveBinaryPath, spawnAndCapture } from 'dor-lib-common';

const FILE_LIST_LIMIT = 200_000;
const GIT_TIMEOUT_MS = 15_000;
const SKIPPED_DIRECTORIES = new Set(['node_modules']);

export interface FileList {
  /** `/`-separated, relative to the listing directory. */
  files: string[];
  /** The limit cut the listing short. */
  truncated: boolean;
}

export async function listFiles(cwd: string): Promise<FileList> {
  return await gitFiles(cwd) ?? walkFiles(cwd);
}

/** Code-unit order, as git sorts its index. */
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Tracked and untracked-but-not-ignored files, less deleted ones. Null
 *  outside a work tree or without git. */
async function gitFiles(cwd: string): Promise<FileList | null> {
  // PATH-resolved, never the bare name, which Windows also searches for in the
  // cwd (docs/specs/dor-cli.md -> "Spawning External Binaries"); reading the
  // index runs `core.fsmonitor`, which the listed repo's own config may name.
  const git = resolveBinaryPath('git', process.env);
  if (!git) return null;
  const run = (args: string[]) => spawnAndCapture(git, ['-c', 'core.fsmonitor=false', 'ls-files', '-z', ...args], {
    cwd, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 256 * 1024 * 1024,
  });
  const [listed, deleted] = await Promise.all([run(['--cached', '--others', '--exclude-standard']), run(['--deleted'])]);
  if (!listed.ok || listed.exitCode !== 0) return null;
  const gone = new Set(deleted.ok && deleted.exitCode === 0 ? deleted.stdout.split('\0') : []);
  // An unmerged path is listed once per stage.
  const files = [...new Set(listed.stdout.split('\0'))].filter(path => path && !gone.has(path)).sort(byPath);
  return { files: files.slice(0, FILE_LIST_LIMIT), truncated: files.length > FILE_LIST_LIMIT };
}

/** Breadth-first, so a cut keeps the shallow files; skips dot-entries and
 *  `node_modules`, as fd does by default. */
async function walkFiles(cwd: string): Promise<FileList> {
  const files: string[] = [];
  const queue = [''];
  while (queue.length > 0) {
    const directory = queue.shift()!;
    const entries = await readdir(join(cwd, directory), { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => byPath(a.name, b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) queue.push(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (files.length === FILE_LIST_LIMIT) return { files, truncated: true };
        files.push(path);
      }
    }
  }
  return { files, truncated: false };
}
