/**
 * Tool-file discovery and the repo-trust record
 * (`docs/specs/dor-tool.md` -> Trust).
 *
 * `dormouse.yml` is repo-controlled and its entries execute, so it is inert
 * until the project is granted — by its upstream remote URL, or by its folder.
 *
 * Granting is *not* implemented here: only a gesture in Dormouse's own chrome
 * may grant trust (`ToolApproval.tsx`). This module records the decision a
 * gesture produced and answers "is it trusted yet?".
 */
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { ToolFileError, parseToolFile, type ToolEntry, type ToolFile } from './tool-registry';
import { resolveUpstreamUrl } from './git-upstream';

export const TOOL_FILE_NAME = 'dormouse.yml';
/**
 * Cap on a `dormouse.yml`. This read happens before the trust check —
 * deliberately, so the approval dialog can name the command — so both the file
 * type and the bytes read are controlled by a repo nobody has approved yet. A
 * real tool file is a few hundred bytes.
 */
const TOOL_FILE_MAX_BYTES = 256 * 1024;

/** Read one regular tool file through one no-follow descriptor, with a hard cap. */
async function readToolFile(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
const TRUST_FILE_NAME = 'tool-trust.json';

/**
 * What a grant covers. `upstream` is the canonical remote URL the project's
 * branch tracks, so every worktree and clone of one repo shares it; `folder` is
 * a single project root, for a repo with no resolvable remote or one the user
 * wants scoped to this checkout only.
 */
export type TrustGrantKind = 'upstream' | 'folder';

/** A grant key: kind-prefixed so one map holds both without collisions. */
export function upstreamGrantKey(canonicalUrl: string): string {
  return `upstream:${canonicalUrl}`;
}
export function folderGrantKey(root: string): string {
  return `folder:${resolve(root)}`;
}

interface TrustGrant {
  readonly kind: TrustGrantKind;
  /** ISO timestamp. Not read by anything yet; see the schema note below. */
  readonly grantedAt: string;
}

/**
 * There is no `denied`. A refusal closes the tool's pane and writes nothing, so
 * a reflexive decline cannot permanently disable tools for every checkout of a
 * repo — which would be unrecoverable, since nothing can revoke or even list a
 * decision (`docs/specs/dor-tool.md` -> Trust).
 *
 * The entry is an object rather than a bare `true` on purpose:
 * `docs/specs/remote-security-model.md` designed revocation into its ACL record
 * from the start and still shipped without callers, but the *field* was there.
 * A flat boolean map has nowhere to put one, so adding revocation later would be
 * a schema change on a security file.
 */
interface TrustFile {
  readonly version: 1;
  readonly grants: Record<string, TrustGrant>;
}

function emptyTrust(): TrustFile {
  return { version: 1, grants: {} };
}

/**
 * Read a stored file, migrating the pre-versioned shape.
 *
 * v0 was `{ roots: Record<absPath, 'trusted' | 'denied'> }`. Its trusted entries
 * become folder grants; its denials are dropped, because the state no longer
 * exists and a stored denial would otherwise be permanent and invisible.
 */
function parseTrustFile(parsed: unknown): TrustFile {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyTrust();
  const record = parsed as { version?: unknown; grants?: unknown; roots?: unknown };

  if (record.version === 1 && record.grants && typeof record.grants === 'object' && !Array.isArray(record.grants)) {
    const grants: Record<string, TrustGrant> = {};
    for (const [key, value] of Object.entries(record.grants as Record<string, unknown>)) {
      const grant = value as { kind?: unknown; grantedAt?: unknown };
      if (grant?.kind !== 'upstream' && grant?.kind !== 'folder') continue;
      grants[key] = { kind: grant.kind, grantedAt: typeof grant.grantedAt === 'string' ? grant.grantedAt : '' };
    }
    return { version: 1, grants };
  }

  if (record.roots && typeof record.roots === 'object' && !Array.isArray(record.roots)) {
    const grants: Record<string, TrustGrant> = {};
    for (const [root, decision] of Object.entries(record.roots as Record<string, unknown>)) {
      if (decision !== 'trusted') continue;
      grants[folderGrantKey(root)] = { kind: 'folder', grantedAt: '' };
    }
    return { version: 1, grants };
  }

  return emptyTrust();
}

/** Records grants. One small JSON file, written temp-then-rename so a crash
 *  mid-write cannot leave a truncated file that reads as "nothing is trusted". */
export class FileToolTrustStore {
  readonly #dir: string;
  readonly #path: string;
  #cache: TrustFile | null = null;

  constructor(stateDir: string) {
    this.#dir = stateDir;
    this.#path = join(stateDir, TRUST_FILE_NAME);
  }

  /** Whether any of these keys has been granted. Callers pass every key that
   *  would cover this project — the upstream and the folder — so one lookup
   *  answers "may this run?". */
  async isTrusted(keys: readonly string[]): Promise<boolean> {
    const { grants } = await this.#read();
    return keys.some((key) => grants[key] !== undefined);
  }

  /** Record a grant a human made in Dormouse's chrome. */
  async grant(key: string, kind: TrustGrantKind): Promise<void> {
    const current = await this.#read();
    const next: TrustFile = {
      version: 1,
      grants: { ...current.grants, [key]: { kind, grantedAt: new Date().toISOString() } },
    };
    await this.#write(next);
    this.#cache = next;
  }

  async #read(): Promise<TrustFile> {
    if (this.#cache) return this.#cache;
    try {
      this.#cache = parseTrustFile(JSON.parse(await readFile(this.#path, 'utf-8')));
    } catch {
      // A missing file is the common case (nothing trusted yet). A corrupt one
      // starts empty rather than throwing: failing closed here means every tool
      // stops working, and the cost of starting empty is one more approval.
      this.#cache = emptyTrust();
    }
    return this.#cache;
  }

  async #write(state: TrustFile): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(this.#dir, 0o700).catch(() => {});
    const tmp = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await rename(tmp, this.#path);
  }
}

/** An in-memory store, for hosts with no state directory and for tests. */
export class MemoryToolTrustStore {
  readonly #grants = new Map<string, TrustGrant>();

  async isTrusted(keys: readonly string[]): Promise<boolean> {
    return keys.some((key) => this.#grants.has(key));
  }

  async grant(key: string, kind: TrustGrantKind): Promise<void> {
    this.#grants.set(key, { kind, grantedAt: new Date().toISOString() });
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
      run: string;
      /** Canonical upstream URL, or null when there is no resolvable remote —
       *  the approval UI then offers only the folder grant. */
      upstreamUrl: string | null;
    }
  | { status: 'error'; message: string }
  | { status: 'ok'; projectRoot: string; path: string; file: ToolFile; entry: ToolEntry };

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
  readTextFile?: (path: string) => Promise<string>,
  resolveUpstream: (dir: string) => Promise<string | null> = resolveUpstreamUrl,
): Promise<ToolLookup> {
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

  // Either grant covers this project: the upstream every worktree shares, or
  // this folder alone. Resolved before the check so the approval UI can offer
  // both, and so a hit on either short-circuits identically.
  const upstreamUrl = await resolveUpstream(found.dir);
  const keys = [folderGrantKey(found.dir), ...(upstreamUrl ? [upstreamGrantKey(upstreamUrl)] : [])];
  if (await trust.isTrusted(keys)) {
    return { status: 'ok', projectRoot: found.dir, path: found.path, file, entry };
  }
  return {
    status: 'untrusted',
    projectRoot: found.dir,
    path: found.path,
    name: entry.name,
    run: entry.run,
    upstreamUrl,
  };
}
