/**
 * Tool-file discovery and the repo-trust record
 * (`docs/specs/dor-tool.md` -> Trust).
 *
 * `dormouse.yml` is repo-controlled and its entries execute, so it is inert
 * until the project is granted — by its upstream remote URL, or by its folder.
 *
 * Granting is *not* implemented here: only a gesture in Dormouse's own chrome
 * may grant trust (`ToolApproval.tsx`). This module records the decision a
 * gesture produced — one file per grant, so two hosts sharing the state
 * directory need no lock between them — and answers "is it trusted yet?".
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { writeJsonAtomic } from './atomic-json-file';
import { ToolFileError, parseToolFile, type ToolEntry, type ToolFile } from './tool-registry';
import { resolveUpstreamUrl } from './git-upstream';
import { resolveToolInput, type ToolInput } from './tool-input';

export const TOOL_FILE_NAME = 'dormouse.yml';
/**
 * Cap on a `dormouse.yml`. This read happens before the trust check —
 * deliberately, so the approval dialog can name the command — so both the file
 * type and the bytes read are controlled by a repo nobody has approved yet. A
 * real tool file is a few hundred bytes.
 */
const TOOL_FILE_MAX_BYTES = 256 * 1024;

/** Refuse repo-config symlinks; user config may follow a dotfiles link
 *  (`followSymlink`). Both paths fstat and cap one descriptor, and open
 *  non-blocking so a FIFO at the path fails the fstat check instead of hanging.
 *  POSIX also opens no-follow, closing the lstat/open replacement race there. */
export async function readToolFile(path: string, options: { followSymlink?: boolean } = {}): Promise<string> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() && !options.followSymlink) {
    throw new ToolFileError(`${path}: tool file must be a regular file, not a symbolic link`);
  }
  // Avoid opening known devices/FIFOs; fstat below also checks the actual
  // descriptor after a symlink follow or concurrent path replacement.
  if (!entry.isSymbolicLink() && !entry.isFile()) throw new ToolFileError(`${path}: tool file must be a regular file`);

  let file;
  try {
    const noFollow = options.followSymlink ? 0 : (constants.O_NOFOLLOW ?? 0);
    file = await open(path, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new ToolFileError(`${path}: tool file must be a regular file, not a symbolic link`);
    }
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) {
      throw new ToolFileError(`${path}: tool file must be a regular file`);
    }
    if (info.size > TOOL_FILE_MAX_BYTES) {
      throw new ToolFileError(`${path}: tool file is larger than ${TOOL_FILE_MAX_BYTES} bytes`);
    }

    // The file may grow after fstat. Read at most cap + 1 so that race is
    // detected without ever allowing an unbounded allocation or readFile.
    const bytes = Buffer.allocUnsafe(TOOL_FILE_MAX_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > TOOL_FILE_MAX_BYTES) {
      throw new ToolFileError(`${path}: tool file is larger than ${TOOL_FILE_MAX_BYTES} bytes`);
    }
    return bytes.subarray(0, offset).toString('utf-8');
  } finally {
    await file.close();
  }
}

/** Directory under the state dir; one file inside it per recorded grant. */
const TRUST_DIR_NAME = 'tool-trust';

/**
 * What a grant covers. `upstream` is the canonical remote URL the project's
 * branch tracks, so every worktree and clone of one repo shares it; `folder` is
 * a single project root, for a repo with no resolvable remote or one the user
 * wants scoped to this checkout only.
 */
export type TrustGrantKind = 'upstream' | 'folder';

/** A grant key: kind-prefixed so one directory holds both without collisions. */
export function upstreamGrantKey(canonicalUrl: string): string {
  return `upstream:${canonicalUrl}`;
}
export function folderGrantKey(root: string): string {
  return `folder:${resolve(root)}`;
}

/**
 * One recorded grant — the whole content of one file.
 *
 * There is no `denied`. A refusal closes the tool's pane and writes nothing, so
 * a reflexive decline cannot permanently disable tools for every checkout of a
 * repo — which would be unrecoverable, since nothing can revoke or even list a
 * decision (`docs/specs/dor-tool.md` -> Trust).
 *
 * A file rather than a bare marker on purpose:
 * `docs/specs/remote-security-model.md` designed revocation into its ACL record
 * from the start and still shipped without callers, but the *field* was there.
 * An empty marker file has nowhere to put one, so adding revocation later would
 * be a schema change on a security file. `key` is here for the same reason: the
 * name on disk is a hash, so only the file itself can say what was granted.
 */
interface TrustGrant {
  readonly version: 1;
  readonly key: string;
  readonly kind: TrustGrantKind;
  /** ISO timestamp, retained for display; grants do not expire. */
  readonly grantedAt: string;
}

function newGrant(key: string, kind: TrustGrantKind): TrustGrant {
  return { version: 1, key, kind, grantedAt: new Date().toISOString() };
}

/**
 * Records grants, one file per grant under `<stateDir>/tool-trust/`, named for
 * the SHA-256 of its key.
 *
 * Grants are add-only and idempotent, so nothing here merges and nothing here
 * locks: two hosts granting at once write two different paths, and two hosts
 * granting the same key record the same authority. The write is still
 * temp-then-rename, so a crash mid-write cannot publish a truncated record.
 * Reads validate the receipt; a filename alone never grants trust.
 */
export class FileToolTrustStore {
  readonly #dir: string;

  constructor(stateDir: string) {
    this.#dir = join(stateDir, TRUST_DIR_NAME);
  }

  /** Hashed rather than escaped: a key is an arbitrary URL or absolute path,
   *  and a hash is a filename on every platform with no length limit to hit. */
  #pathFor(key: string): string {
    return join(this.#dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  /** Whether any of these keys has been granted. Callers pass every key that
   *  would cover this project — the upstream and the folder — so one lookup
   *  answers "may this run?". */
  async isTrusted(keys: readonly string[]): Promise<boolean> {
    for (const key of keys) {
      try {
        const path = this.#pathFor(key);
        // Reject special entries before opening: a FIFO must not block lookup.
        if (!(await lstat(path)).isFile()) continue;
        const grant = JSON.parse(await readToolFile(path)) as Partial<TrustGrant> | null;
        if (grant?.version === 1 && grant.key === key
          && (grant.kind === 'folder' || grant.kind === 'upstream')
          && key.startsWith(`${grant.kind}:`) && typeof grant.grantedAt === 'string') return true;
      } catch {
        // Missing, unreadable, oversized, or malformed receipts grant nothing.
        // Another key may still cover this project.
      }
    }
    return false;
  }

  /** Record a grant a human made in Dormouse's chrome. */
  async grant(key: string, kind: TrustGrantKind): Promise<void> {
    await writeJsonAtomic(this.#dir, this.#pathFor(key), newGrant(key, kind));
  }
}

/** An in-memory store, for hosts with no state directory and for tests. */
export class MemoryToolTrustStore {
  readonly #grants = new Map<string, TrustGrant>();

  async isTrusted(keys: readonly string[]): Promise<boolean> {
    return keys.some((key) => this.#grants.has(key));
  }

  async grant(key: string, kind: TrustGrantKind): Promise<void> {
    this.#grants.set(key, newGrant(key, kind));
  }
}

export type ToolTrustStore = FileToolTrustStore | MemoryToolTrustStore;

/**
 * Walk up from `startDir` for the nearest `dormouse.yml`. Its directory is
 * `$PROJECT_ROOT` — free, since the host knows where it found the file, and
 * more robust than shelling out to git (it works in a non-git directory).
 */
export async function findToolFile(
  startDir: string,
  readTextFile: (path: string) => Promise<string> = readToolFile,
): Promise<{ path: string; dir: string; text: string } | null> {
  let dir = resolve(startDir);
  // Bounded by the filesystem root; `dirname('/') === '/'` is the terminator.
  for (;;) {
    const path = join(dir, TOOL_FILE_NAME);
    try {
      const text = await readTextFile(path);
      // Backstop for an injected reader that caps nothing; the default reader
      // refuses at `stat` first. Distinct wording so a test can name which
      // check fired. `byteLength`, not `.length` — the cap is bytes, and
      // multi-byte characters would slip past a UTF-16 count.
      if (Buffer.byteLength(text, 'utf-8') > TOOL_FILE_MAX_BYTES) {
        throw new ToolFileError(
          `${path}: tool file content exceeds ${TOOL_FILE_MAX_BYTES} bytes after reading`,
        );
      }
      return { path, dir, text };
    } catch (error) {
      if (error instanceof ToolFileError) throw error;
      // Not here (or unreadable) — keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export type ToolLookup =
  | { status: 'no-file' }
  | { status: 'unknown-tool'; projectRoot: string; path: string; names: string[] }
  | {
      status: 'untrusted';
      projectRoot: string;
      path: string;
      name: string;
      run: string | readonly string[];
      /** Canonical upstream URL, or null when there is no resolvable remote —
       *  the approval UI then offers only the folder grant. */
      upstreamUrl: string | null;
      /** The parsed file's lint warnings, the same set the `ok` arm carries:
       *  the untrusted answer is the one the first run of a tool sees. */
      warnings: string[];
    }
  | { status: 'error'; message: string }
  | { status: 'ok'; projectRoot: string; path: string; file: ToolFile; entry: ToolEntry; input: ToolInput };

/**
 * Find, parse, and trust-check the entry named `name` for a caller in `cwd`.
 *
 * Parsing precedes the trust check on purpose: parsing is inert, and the
 * approval dialog has to name the command it is approving. Nothing from the
 * file executes on this path.
 */
export async function lookupTool(
  name: string,
  cwd: string,
  trust: ToolTrustStore,
  options: {
    /** Invocation inputs for `$ARGS` / `$TARGET`; none by default. */
    args?: readonly string[];
    /** Test seams. */
    readTextFile?: (path: string) => Promise<string>;
    resolveUpstream?: (dir: string) => Promise<string | null>;
  } = {},
): Promise<ToolLookup> {
  const { args = [], readTextFile, resolveUpstream = resolveUpstreamUrl } = options;
  let found;
  try {
    found = await findToolFile(cwd, readTextFile);
  } catch (error) {
    // An oversized file: report it rather than letting it reach the parser.
    if (error instanceof ToolFileError) return { status: 'error', message: error.message };
    throw error;
  }
  if (!found) return { status: 'no-file' };

  let file: ToolFile;
  try {
    file = parseToolFile(found.text, { path: found.path, dir: found.dir, scope: 'repo' });
  } catch (error) {
    if (error instanceof ToolFileError) return { status: 'error', message: error.message };
    throw error;
  }

  const entry = file.tools.get(name);
  if (!entry) {
    return {
      status: 'unknown-tool',
      projectRoot: found.dir,
      path: found.path,
      names: [...file.tools.keys()].sort(),
    };
  }

  let input: ToolInput;
  try {
    input = await resolveToolInput(entry, { projectRoot: found.dir, cwd, args });
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }

  // Either grant covers this project: this folder alone, or the upstream every
  // worktree shares. The folder key is free, so it is checked first — a granted
  // folder answers without spawning git at all.
  const ok = { status: 'ok', projectRoot: found.dir, path: found.path, file, entry, input } as const;
  if (await trust.isTrusted([folderGrantKey(found.dir)])) return ok;

  // Only now pay for git, which the untrusted answer needs anyway so the
  // approval UI can offer the upstream grant.
  const upstreamUrl = await resolveUpstream(found.dir);
  if (upstreamUrl && await trust.isTrusted([upstreamGrantKey(upstreamUrl)])) return ok;

  return {
    status: 'untrusted',
    projectRoot: found.dir,
    path: found.path,
    name: entry.name,
    run: input.run,
    upstreamUrl,
    warnings: [...file.warnings],
  };
}
