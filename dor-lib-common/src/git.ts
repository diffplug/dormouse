import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import nodePath from 'node:path';
import { isUncOrDevicePath } from './browser-providers.js';
import { localRealpath, localRealpathIfExists, NonLocalPathError, type LocalPath, type LocalPathFs, type LocalPathModule } from './local-path.js';

/**
 * The arguments that lead every git run in a repository the user has not
 * vouched for: a terminal-reported cwd, a Tool's project root before trust, a
 * folder `dor open` lists or the folder viewer browses
 * (`docs/specs/security-local.md` -> "Spawned programs").
 *
 * A repository's own `.git/config` can name a program for git to run.
 * `core.fsmonitor` is the one such key the queries Dormouse runs can reach —
 * `config --get`, `remote get-url`, and the index readers `ls-files` and
 * `check-ignore` — since none runs a hook, reads contents
 * through a filter or textconv, pages to a pipe, or fetches. A subcommand that
 * does any of those needs its own override here before it runs untrusted.
 */
export const UNTRUSTED_REPO_GIT_ARGS: readonly string[] = ['-c', 'core.fsmonitor=false'];

/** Where git finds a repository: its git directory, the common directory a
 *  linked worktree shares, and the work tree (null for a bare repository). */
export interface LocalGitRepository {
  gitDir: string;
  commonDir: string;
  workTree: string | null;
}

export interface GitRepositoryOptions {
  /** Test seams. `readFile` answers a regular file's text, and throws past `limit` bytes. */
  fs?: LocalPathFs & { readFile?(path: string, limit: number): Promise<string>; readdir?(path: string): Promise<string[]> };
  path?: LocalPathModule & Pick<typeof nodePath, 'dirname'>;
  home?: string;
}

/** What git opens in a git or common directory for the queries above. */
const REPOSITORY_ENTRIES = ['HEAD', 'commondir', 'objects', 'refs', 'packed-refs', 'index', 'config', 'config.worktree', 'info/exclude', 'info/sparse-checkout'];
/** Directories of git's legacy remote files, which `remote get-url` opens
 *  for a remote its config gives no URL. */
const LEGACY_REMOTE_DIRS = ['remotes', 'branches'];
const LEGACY_REMOTE_LIMIT = 256;
/** Config keys whose value is a path git opens for those queries. */
const PATH_KEYS = new Set(['core.worktree', 'core.excludesfile', 'core.attributesfile']);
const GITFILE_LIMIT = 4096;
const CONFIG_LIMIT = 1024 * 1024;

/**
 * The repository git finds from `dir`, or null when there is none, or when a
 * path git would follow to find or open it is a share or device path or a
 * link to one: a `.git` entry, the `gitdir:` a `.git` file names, a
 * `commondir`, an entry git opens inside, or a path the repository's config
 * names. Any `include` in that config refuses it too, since an included file
 * can name anything. Every git run in a repository the user has not vouched
 * for asks this first, skips the run on null, and otherwise runs with
 * `untrustedGitEnv`: git follows each of these before anything could check
 * where it went.
 */
export async function localGitRepository(dir: string, options: GitRepositoryOptions = {}): Promise<LocalGitRepository | null> {
  const path = options.path ?? nodePath;
  try {
    const start = await localRealpath(dir, options);
    if (!start.stats.isDirectory()) return null;
    // Nearest first, as git's own discovery goes: `<level>/.git`, then
    // `<level>` itself as a bare repository.
    for (let level = start.path; ;) {
      const found = await repositoryAt(level, options);
      if (found) {
        await checkRepository(found, options);
        return found;
      }
      const parent = path.dirname(level);
      if (parent === level) return null;
      level = parent;
    }
  } catch {
    return null;
  }
}

/** What git takes at `level`: `<level>/.git`, else `<level>` as a bare
 *  repository. Both candidates are checked whichever it takes, since git
 *  judges a candidate more strictly than this does and may pass over one
 *  this takes; `untrustedGitEnv` stops it going higher. */
async function repositoryAt(level: string, options: GitRepositoryOptions): Promise<LocalGitRepository | null> {
  const path = options.path ?? nodePath;
  const dotGit = await localRealpathIfExists(path.join(level, '.git'), options);
  if (dotGit?.stats.isFile()) {
    // A linked worktree's or a submodule's `.git` file, where git stops
    // whether or not it names a repository.
    const named = /^gitdir: (.*?)[\r\n]*$/s.exec(await readFile(dotGit.path, GITFILE_LIMIT, options))?.[1];
    if (!named) throw new Error('not a .git file');
    if (isUncOrDevicePath(named)) throw new NonLocalPathError();
    const dirs = await gitDirectory(path.resolve(level, named), options);
    if (!dirs) throw new Error('the .git file names no repository');
    return { ...dirs, workTree: level };
  }
  const dirs = dotGit && await gitDirectory(dotGit.path, options);
  const bare = await gitDirectory(level, options);
  if (dirs) return { ...dirs, workTree: level };
  return bare && { ...bare, workTree: null };
}

/** `candidate`'s git and common directories when it holds `HEAD`, and
 *  `objects` and `refs` directories where its `commondir` points. Each path
 *  git reads to judge it is checked before the answer, as git reads them all. */
async function gitDirectory(candidate: string, options: GitRepositoryOptions): Promise<{ gitDir: string; commonDir: string } | null> {
  const path = options.path ?? nodePath;
  const gitDir = await localRealpathIfExists(candidate, options);
  if (!gitDir?.stats.isDirectory()) return null;
  const head = await localRealpathIfExists(path.join(gitDir.path, 'HEAD'), options);
  const commondir = await localRealpathIfExists(path.join(gitDir.path, 'commondir'), options);
  let commonDir: LocalPath | null = gitDir;
  if (commondir) {
    const named = (await readFile(commondir.path, GITFILE_LIMIT, options)).replace(/[\r\n]*$/, '');
    if (isUncOrDevicePath(named)) throw new NonLocalPathError();
    commonDir = await localRealpathIfExists(path.resolve(gitDir.path, named), options);
    if (!commonDir?.stats.isDirectory()) return null;
  }
  const objects = await localRealpathIfExists(path.join(commonDir.path, 'objects'), options);
  const refs = await localRealpathIfExists(path.join(commonDir.path, 'refs'), options);
  if (!head || !objects?.stats.isDirectory() || !refs?.stats.isDirectory()) return null;
  return { gitDir: gitDir.path, commonDir: commonDir.path };
}

/**
 * The environment a git run in `repository` takes: git searches no higher
 * than the directory `localGitRepository` found it in, so it opens nothing
 * that was not checked — it finds that repository or none — and keeps its
 * own ownership check, which a `--git-dir` would skip. A `GIT_DIR`,
 * `GIT_COMMON_DIR`, or `GIT_WORK_TREE` the host inherited is dropped for the
 * same reason.
 */
export function untrustedGitEnv(repository: LocalGitRepository, env: NodeJS.ProcessEnv = process.env, path: Pick<typeof nodePath, 'dirname'> = nodePath): NodeJS.ProcessEnv {
  const { GIT_DIR: _dir, GIT_COMMON_DIR: _common, GIT_WORK_TREE: _tree, ...rest } = env;
  const level = repository.workTree ?? repository.gitDir;
  const above = path.dirname(level);
  return above === level ? rest : { ...rest, GIT_CEILING_DIRECTORIES: above };
}

/** Throws unless each entry git opens in `repository`, and each path its config names, is local. */
async function checkRepository({ gitDir, commonDir, workTree }: LocalGitRepository, options: GitRepositoryOptions): Promise<void> {
  const path = options.path ?? nodePath;
  for (const base of new Set([gitDir, commonDir])) {
    for (const name of REPOSITORY_ENTRIES) await localRealpathIfExists(path.join(base, name), options);
  }
  for (const name of LEGACY_REMOTE_DIRS) {
    const dir = await localRealpathIfExists(path.join(commonDir, name), options);
    if (!dir?.stats.isDirectory()) continue;
    const files = await (options.fs?.readdir ?? readdir)(dir.path);
    if (files.length > LEGACY_REMOTE_LIMIT) throw new Error('too many legacy remotes');
    for (const file of files) await localRealpathIfExists(path.join(dir.path, file), options);
  }
  for (const config of [path.join(commonDir, 'config'), path.join(gitDir, 'config.worktree')]) {
    const file = await localRealpathIfExists(config, options);
    if (!file?.stats.isFile()) continue;
    const entries = gitConfigEntries(await readFile(file.path, CONFIG_LIMIT, options));
    if (!entries) throw new Error('a config git would refuse');
    for (const { section, key, value } of entries) {
      if (section === 'include' || section.startsWith('includeif.')) throw new NonLocalPathError();
      if (!PATH_KEYS.has(`${section}.${key}`)) continue;
      if (isUncOrDevicePath(value) || /^~[^/\\]/.test(value)) throw new NonLocalPathError();
      // `core.worktree` is relative to the git directory, the others to the work tree.
      const base = key === 'worktree' ? gitDir : workTree ?? gitDir;
      const named = value.startsWith('~') ? path.join(options.home ?? homedir(), value.slice(1)) : path.resolve(base, value);
      await localRealpathIfExists(named, options);
    }
  }
}

async function readFile(path: string, limit: number, options: GitRepositoryOptions): Promise<string> {
  if (options.fs?.readFile) return options.fs.readFile(path, limit);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await file.stat()).isFile()) throw new Error('not a regular file');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error('file too large');
    return bytes.subarray(0, length).toString('utf8');
  } finally {
    await file.close();
  }
}

export interface GitConfigEntry {
  /** Lowercased, then a quoted subsection as written after a dot. */
  section: string;
  /** Lowercased. */
  key: string;
  value: string;
}

/**
 * The entries of git config `text`, decoded as git's own parser does
 * (`git_parse_source` in git's `config.c`), or null where git would refuse
 * the file. A key with no `=` is a boolean true and reads as an empty value.
 */
export function gitConfigEntries(text: string): GitConfigEntry[] | null {
  const source = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const entries: GitConfigEntry[] = [];
  let section: string | null = null;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (isSpace(c)) {
      i++;
    } else if (c === '#' || c === ';') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '[') {
      i++;
      let name = '';
      while (isKeyChar(source[i]) || source[i] === '.') name += source[i++];
      name = name.toLowerCase();
      if (source[i] === ' ' || source[i] === '\t') {
        while (source[i] === ' ' || source[i] === '\t') i++;
        if (source[i++] !== '"') return null;
        let sub = '';
        for (let s = source[i++]; s !== '"'; s = source[i++]) {
          if (s === '\\') s = source[i++];
          if (s === undefined || s === '\n') return null;
          sub += s;
        }
        name += `.${sub}`;
      }
      if (!name || source[i++] !== ']') return null;
      section = name;
    } else {
      if (section === null || !/[A-Za-z]/.test(c)) return null;
      let key = '';
      while (isKeyChar(source[i])) key += source[i++];
      while (source[i] === ' ' || source[i] === '\t') i++;
      let value = '';
      if (source[i] === '=') {
        const parsed = configValue(source, i + 1);
        if (!parsed) return null;
        [value, i] = parsed;
      } else if (i < source.length && source[i] !== '\n') {
        return null;
      }
      entries.push({ section, key: key.toLowerCase(), value });
    }
  }
  return entries;
}

const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
const isKeyChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9-]/.test(c);
const ESCAPES = new Map([['t', '\t'], ['b', '\b'], ['n', '\n'], ['\\', '\\'], ['"', '"']]);

/** The value from `start` and the index past its line; null for an
 *  unterminated quote or an unknown escape, which git refuses. */
function configValue(source: string, start: number): [string, number] | null {
  let value = '';
  let spaces = 0;
  let quoted = false;
  let comment = false;
  for (let i = start; ; i++) {
    const c = source[i];
    if (c === undefined || c === '\n') return quoted ? null : [value, i + 1];
    if (comment) continue;
    if (!quoted && isSpace(c)) {
      if (value) spaces++;
      continue;
    }
    if (!quoted && (c === ';' || c === '#')) {
      comment = true;
      continue;
    }
    value += ' '.repeat(spaces);
    spaces = 0;
    if (c === '\\') {
      const escaped = source[++i];
      if (escaped === '\n') continue;
      const decoded = escaped === undefined ? undefined : ESCAPES.get(escaped);
      if (decoded === undefined) return null;
      value += decoded;
    } else if (c === '"') {
      quoted = !quoted;
    } else {
      value += c;
    }
  }
}
