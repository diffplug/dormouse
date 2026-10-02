/**
 * The files `dor open` with no path offers (`docs/specs/dor-tool.md` ->
 * Choosing a file), streamed in batches so the picker never waits on a large
 * tree: git's view of `cwd` when it is in a work tree, otherwise a concurrent
 * walk that hands each work tree it reaches to git.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveBinaryPath, spawnAndCapture } from 'dor-lib-common';

const FILE_LIST_LIMIT = 200_000;
const GIT_TIMEOUT_MS = 15_000;
const WALK_CONCURRENCY = 16;
const SKIPPED_DIRECTORIES = new Set(['node_modules']);

export interface FileListOptions {
  /** Receives `/`-separated paths relative to `cwd`, batch by batch. */
  onFiles(paths: string[]): void;
  /** The home directory, whose macOS `Library` the walk skips. */
  home?: string;
}

/** Resolves when the listing ends; `truncated` when the limit cut it short. */
export async function listFiles(cwd: string, { onFiles, home }: FileListOptions): Promise<{ truncated: boolean }> {
  // PATH-resolved, never the bare name, which Windows also searches for in the
  // cwd (docs/specs/dor-cli.md -> "Spawning External Binaries").
  const git = resolveBinaryPath('git', process.env);
  let count = 0;
  let truncated = false;
  const emit = (paths: string[]) => {
    if (truncated || paths.length === 0) return;
    if (paths.length > FILE_LIST_LIMIT - count) {
      paths = paths.slice(0, FILE_LIST_LIMIT - count);
      truncated = true;
    }
    count += paths.length;
    onFiles(paths);
  };

  const own = git ? await gitFiles(git, cwd) : null;
  if (own) {
    emit(own);
    return { truncated };
  }
  // macOS app data: most of a home tree, and reading inside it can raise the
  // system's prompts for access to other apps' data.
  const library = process.platform === 'darwin' && home ? join(home, 'Library') : undefined;
  const queue = [''];

  /** One directory: a work tree goes to git whole, else its files are listed
   *  and its directories queued, dot-entries and `node_modules` skipped. */
  const visit = async (directory: string) => {
    const absolute = join(cwd, directory);
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    // `.git` is a directory in a clone and a file in a worktree or submodule.
    const repo = git && directory && entries.some(entry => entry.name === '.git') ? await gitFiles(git, absolute) : null;
    if (repo) {
      emit(repo.map(path => `${directory}/${path}`));
      return;
    }
    entries.sort((a, b) => byPath(a.name, b.name));
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && join(cwd, path) !== library) queue.push(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(path);
      }
    }
    emit(files);
  };

  // Breadth-first with bounded concurrency, so shallow files come first.
  let active = 0;
  await new Promise<void>((resolve) => {
    const pump = () => {
      while (!truncated && active < WALK_CONCURRENCY && queue.length > 0) {
        active++;
        void visit(queue.shift()!).finally(() => { active--; pump(); });
      }
      if (active === 0 && (truncated || queue.length === 0)) resolve();
    };
    pump();
  });
  return { truncated };
}

/** Code-unit order, as git sorts its index. */
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Tracked and untracked-but-not-ignored files under `cwd`, less deleted ones;
 *  dot-folders included. Null outside a work tree. */
async function gitFiles(git: string, cwd: string): Promise<string[] | null> {
  // Reading the index runs `core.fsmonitor`, which the listed repo's own config may name.
  const run = (args: string[]) => spawnAndCapture(git, ['-c', 'core.fsmonitor=false', 'ls-files', '-z', ...args], {
    cwd, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 256 * 1024 * 1024,
  });
  const [listed, deleted] = await Promise.all([run(['--cached', '--others', '--exclude-standard']), run(['--deleted'])]);
  if (!listed.ok || listed.exitCode !== 0) return null;
  const gone = new Set(deleted.ok && deleted.exitCode === 0 ? deleted.stdout.split('\0') : []);
  // An unmerged path is listed once per stage.
  return [...new Set(listed.stdout.split('\0'))].filter(path => path && !gone.has(path)).sort(byPath);
}
