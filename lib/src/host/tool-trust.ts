/**
 * Tool-file discovery and the repo-trust record
 * (`docs/specs/dor-tool.md` -> Trust).
 *
 * `dormouse.yml` is repo-controlled and its entries execute, so it is inert
 * until the repo root is trusted — path-level, both answers remembered.
 *
 * Granting is *not* implemented here: only a gesture in Dormouse's own chrome
 * may grant trust (`ToolTrustDialog.tsx`). This module records the decision a
 * gesture produced and answers "is it trusted yet?".
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { ToolFileError, parseToolFile, type ToolEntry, type ToolFile } from './tool-registry';

export const TOOL_FILE_NAME = 'dormouse.yml';
const TRUST_FILE_NAME = 'tool-trust.json';

export type TrustState = 'trusted' | 'denied' | 'unknown';

interface TrustFile {
  /** Absolute repo roots, each mapped to the decision a human made there. */
  roots: Record<string, 'trusted' | 'denied'>;
}

function emptyTrust(): TrustFile {
  return { roots: {} };
}

/** Records the trust decision for a repo root. One small JSON file, written
 *  temp-then-rename so a crash mid-write cannot leave a truncated file that
 *  reads as "nothing is trusted". */
export class FileToolTrustStore {
  readonly #dir: string;
  readonly #path: string;
  #cache: TrustFile | null = null;

  constructor(stateDir: string) {
    this.#dir = stateDir;
    this.#path = join(stateDir, TRUST_FILE_NAME);
  }

  async get(root: string): Promise<TrustState> {
    return (await this.#read()).roots[resolve(root)] ?? 'unknown';
  }

  /** Record a decision a human made in Dormouse's chrome. */
  async set(root: string, decision: 'trusted' | 'denied'): Promise<void> {
    const current = await this.#read();
    const next: TrustFile = { roots: { ...current.roots, [resolve(root)]: decision } };
    await this.#write(next);
    this.#cache = next;
  }

  async #read(): Promise<TrustFile> {
    if (this.#cache) return this.#cache;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, 'utf-8'));
      const roots =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as { roots?: unknown }).roots
          : null;
      this.#cache =
        roots && typeof roots === 'object' && !Array.isArray(roots)
          ? { roots: roots as TrustFile['roots'] }
          : emptyTrust();
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
  readonly #roots = new Map<string, 'trusted' | 'denied'>();

  async get(root: string): Promise<TrustState> {
    return this.#roots.get(resolve(root)) ?? 'unknown';
  }

  async set(root: string, decision: 'trusted' | 'denied'): Promise<void> {
    this.#roots.set(resolve(root), decision);
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
  readTextFile: (path: string) => Promise<string> = (path) => readFile(path, 'utf-8'),
): Promise<{ path: string; dir: string; text: string } | null> {
  let dir = resolve(startDir);
  // Bounded by the filesystem root; `dirname('/') === '/'` is the terminator.
  for (;;) {
    const path = join(dir, TOOL_FILE_NAME);
    try {
      return { path, dir, text: await readTextFile(path) };
    } catch {
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
  | { status: 'untrusted'; projectRoot: string; path: string; name: string; run: string }
  | { status: 'denied'; projectRoot: string; path: string }
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
): Promise<ToolLookup> {
  const found = await findToolFile(cwd, readTextFile);
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

  const state = await trust.get(found.dir);
  if (state === 'denied') return { status: 'denied', projectRoot: found.dir, path: found.path };
  if (state === 'unknown') {
    return {
      status: 'untrusted',
      projectRoot: found.dir,
      path: found.path,
      name: entry.name,
      run: entry.run,
    };
  }
  return { status: 'ok', projectRoot: found.dir, path: found.path, file, entry };
}
