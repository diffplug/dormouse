/**
 * Resolving a path someone else named — a terminal-reported directory, a
 * planted file or link, a document's reference — without reaching another
 * machine.
 *
 * `realpath` cannot do this: it reaches each link's target while resolving it
 * (the native one opens it, the JS one `stat`s it), so a local symlink or
 * junction to `\\host\share` would reach that host, which on Windows can offer
 * it the user's credentials, before its result could be checked. This
 * resolves one component at a time with `lstat` and `readlink`, which never
 * follow a link, and refuses a share or device path, as the input or as a
 * link's target, before anything follows it.
 */
import type { Stats } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import nodePath from 'node:path';
import { isUncOrDevicePath } from './browser-providers.js';

/** Links followed before giving up, as `ELOOP` does. */
const MAX_LINKS = 40;

/** The filesystem calls resolution makes; a test seam. */
export interface LocalPathFs {
  lstat(path: string): Promise<Stats>;
  readlink(path: string): Promise<string>;
  /** Run only on a path with no link left on it, for its stored spelling. */
  realpath?(path: string): Promise<string>;
}

export type LocalPathModule = Pick<typeof nodePath, 'isAbsolute' | 'join' | 'parse' | 'resolve' | 'sep'>;

export interface LocalPathOptions {
  fs?: LocalPathFs;
  /** `path.win32` lets a test resolve with Windows semantics anywhere. */
  path?: LocalPathModule;
}

/** An existing path, link-free, and its own `lstat`. */
export interface LocalPath {
  path: string;
  stats: Stats;
}

/** Refused before any filesystem call reached it: a share or device path, a
 *  link to one, or a relative input. Carries no path, which may hold controls. */
export class NonLocalPathError extends Error {
  readonly code = 'ENONLOCAL';
  constructor() {
    super('not a path on this machine');
  }
}

const NODE_FS: LocalPathFs = { lstat, readlink, realpath };

/**
 * `realpath` that never reaches another machine: the canonical, link-free
 * spelling of the existing absolute `input`. Rejects with
 * `NonLocalPathError` for a share or device path or a link to one, and as
 * `lstat` does (`ENOENT`, `ENOTDIR`) for a missing component.
 */
export async function localRealpath(input: string, { fs = NODE_FS, path = nodePath }: LocalPathOptions = {}): Promise<LocalPath> {
  if (!path.isAbsolute(input) || isUncOrDevicePath(input)) throw new NonLocalPathError();
  // `..` is resolved lexically first, as `realpath` does.
  const start = path.resolve(input);
  let current = path.parse(start).root;
  let pending = components(start, current, path.sep);
  let stats: Stats | undefined;
  let links = 0;
  while (pending.length > 0) {
    const next = path.join(current, pending.shift()!);
    const entry = await fs.lstat(next);
    if (!entry.isSymbolicLink()) {
      current = next;
      stats = entry;
      continue;
    }
    if (++links > MAX_LINKS) throw Object.assign(new Error('too many symbolic links'), { code: 'ELOOP' });
    const target = await fs.readlink(next);
    if (isUncOrDevicePath(target)) throw new NonLocalPathError();
    // A relative target resolves against the link's own directory, which
    // `current` already is, free of links.
    const resolved = path.resolve(current, target);
    // The target may itself pass through links, so walk it from its root.
    current = path.parse(resolved).root;
    pending = [...components(resolved, current, path.sep), ...pending];
    stats = undefined;
  }
  stats ??= await fs.lstat(current);
  // With no link left on the path, the native `realpath` follows nothing: it
  // only answers the spelling the volume stores (case, an 8.3 name's long
  // form), as `realpath` always did here. A mapped drive, which it answers as
  // its share, keeps the walked spelling.
  const stored = fs.realpath ? await fs.realpath(current).catch(() => current) : current;
  return { path: isUncOrDevicePath(stored) ? current : stored, stats };
}

/** `localRealpath`, or null where nothing exists; a refusal still rejects. */
export async function localRealpathIfExists(input: string, options?: LocalPathOptions): Promise<LocalPath | null> {
  try {
    return await localRealpath(input, options);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/** The canonical path of an existing local directory, or null: the terminal
 *  context directory actions and Workspace auto-naming take it from a
 *  terminal-reported cwd, which any program names. */
export async function canonicalLocalDirectory(input: unknown, options?: LocalPathOptions): Promise<string | null> {
  if (typeof input !== 'string') return null;
  try {
    const local = await localRealpath(input, options);
    return local.stats.isDirectory() ? local.path : null;
  } catch {
    return null;
  }
}

function components(absolute: string, root: string, sep: string): string[] {
  return absolute.slice(root.length).split(sep).filter(Boolean);
}
