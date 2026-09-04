/**
 * Where a Node-resident Burrow keeps the two things it must survive a restart
 * with: the enrollment (which carries `burrowToken`, a bearer credential) and the
 * ACL (the authorization primitive, which per the security model lives on the
 * Burrow and nowhere else — docs/specs/remote-security-model.md).
 *
 * The interface is async because the burrows that implement it are: a file the
 * sidecar owns here, `VsCodeBurrowStateStore` there (enrollment in
 * `SecretStorage`, ACL in `globalState` — `docs/specs/vscode.md`). {@link FileBurrowStateStore}
 * is the sidecar's: one file, 0600, under a directory the app passes in.
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BurrowAclRecord } from 'remote-lib-common';
import { filterAclRecords } from '../../remote/burrow/acl';
import { isEnrollment, type BurrowEnrollment } from '../../remote/burrow/enrollment';
import { createSerialQueue } from './serial-queue';

// Re-exported so an implementor can name the record type without depending on
// `remote-lib-common` itself; vscode-ext's project does not resolve it.
export type { BurrowAclRecord };

export interface BurrowStateStore {
  /**
   * Whether a write survives this process. Only the dev-harness store (no state
   * directory) says `false`. Required rather than optional so a store that
   * forgot to answer is not silently read as durable.
   *
   * Nothing reads it today — its consumer went with the webview-persisted Burrow
   * hand-off — and it is kept as the store contract's own statement of
   * durability, which an implementor must make before anything can rely on it.
   */
  readonly persistent: boolean;
  loadEnrollment(): Promise<BurrowEnrollment | null>;
  saveEnrollment(enrollment: BurrowEnrollment): Promise<void>;
  clearEnrollment(): Promise<void>;
  loadAcl(burrowId: string): Promise<BurrowAclRecord[]>;
  saveAcl(burrowId: string, records: readonly BurrowAclRecord[]): Promise<void>;
}

const FILE_NAME = 'burrow.json';

/**
 * What this file was called before the Burrow rename. Nothing reads it — it is
 * deleted unread, because it holds a live `burrowToken` and an install upgraded
 * across the rename would otherwise leave that credential on disk forever with
 * no code left that knows the name.
 */
const RETIRED_FILE_NAME = 'remote-host.json';

interface BurrowStateFile {
  version: 1;
  enrollment: BurrowEnrollment | null;
  /** Keyed by burrowId so a re-enrollment cannot inherit a stale ACL. */
  acl: Record<string, BurrowAclRecord[]>;
}

function emptyState(): BurrowStateFile {
  return { version: 1, enrollment: null, acl: {} };
}

function parseState(raw: string): BurrowStateFile {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
  const { enrollment, acl } = parsed as { enrollment?: unknown; acl?: unknown };
  const state = emptyState();
  if (isEnrollment(enrollment)) state.enrollment = enrollment;
  if (acl && typeof acl === 'object') {
    for (const [burrowId, records] of Object.entries(acl as Record<string, unknown>)) {
      if (Array.isArray(records)) state.acl[burrowId] = records as BurrowAclRecord[];
    }
  }
  return state;
}

/**
 * One JSON file holding both values. A single file rather than one per value so
 * a write is one atomic rename: the enrollment and the records approved under it
 * can never end up describing different Burrows.
 */
export class FileBurrowStateStore implements BurrowStateStore {
  readonly persistent = true;

  readonly #dir: string;
  readonly #path: string;
  #state: Promise<BurrowStateFile> | null = null;
  /**
   * Serializes mutations, the way `relay/src/state.ts` does: every save is a
   * read-modify-write of the whole file, so two of them running together can
   * interleave their writes and renames and land the older one last.
   */
  readonly #serialize = createSerialQueue();

  constructor(stateDir: string) {
    this.#dir = stateDir;
    this.#path = join(stateDir, FILE_NAME);
  }

  async loadEnrollment(): Promise<BurrowEnrollment | null> {
    return (await this.#read()).enrollment;
  }

  saveEnrollment(enrollment: BurrowEnrollment): Promise<void> {
    return this.#mutate((state) => {
      state.enrollment = enrollment;
    });
  }

  clearEnrollment(): Promise<void> {
    return this.#mutate((state) => {
      state.enrollment = null;
    });
  }

  async loadAcl(burrowId: string): Promise<BurrowAclRecord[]> {
    return filterAclRecords(burrowId, (await this.#read()).acl[burrowId] ?? []);
  }

  saveAcl(burrowId: string, records: readonly BurrowAclRecord[]): Promise<void> {
    return this.#mutate((state) => {
      state.acl[burrowId] = [...records];
    });
  }

  /** Apply one change to the in-memory state and flush it, one at a time. */
  #mutate(change: (state: BurrowStateFile) => void): Promise<void> {
    return this.#serialize(async () => {
      // A read that failed rejects here and takes the whole save with it: every
      // change is a read-modify-write of the whole file, so writing without
      // having read it would replace state we could not see with state we
      // invented (`#read`).
      const current = await this.#read();
      // Do not expose a mutation through later reads until its atomic rename
      // has succeeded. In particular, a failed enrollment save must not make a
      // later adoption believe the Burrow is durable and discard the webview's
      // only surviving copy. Changes replace top-level enrollment / ACL slots,
      // so a shallow copy of the map is the required transaction boundary.
      const next: BurrowStateFile = { ...current, acl: { ...current.acl } };
      change(next);
      await this.#write(next);
      this.#state = Promise.resolve(next);
    });
  }

  #read(): Promise<BurrowStateFile> {
    // Read once and keep it: this process is the only writer, so the in-memory
    // copy is the file, and a save is a full rewrite of what we already hold.
    this.#state ??= this.#readOnce().catch((error: unknown) => {
      // A read that failed for a reason other than "there is no file yet" says
      // nothing about what the file holds — EACCES, EIO, an open handle on
      // Windows. Memoizing empty for it would make the very next `#mutate`
      // read-modify-write from nothing and durably overwrite the enrollment and
      // every ACL record with it, de-pairing every device for good. So forget
      // the attempt instead: the caller fails closed, `#mutate` refuses to
      // write because it never got a state to modify, and a later read of the
      // same file can still recover.
      this.#state = null;
      throw error;
    });
    return this.#state;
  }

  async #readOnce(): Promise<BurrowStateFile> {
    // Never read, only removed: the retired file's `burrowToken` is a credential
    // this build can no longer revoke. A failure here is not fatal — the state
    // this store owns is elsewhere — so it is logged and stepped over.
    await rm(join(this.#dir, RETIRED_FILE_NAME), { force: true }).catch((error: unknown) => {
      console.warn(`[burrow] could not remove the retired ${RETIRED_FILE_NAME}`, error);
    });
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (error) {
      // Nothing written yet is the ordinary state of a machine that never
      // enrolled, and it is the one failure that genuinely means "empty".
      if ((error as { code?: string } | null)?.code === 'ENOENT') return emptyState();
      throw error;
    }
    try {
      return parseState(raw);
    } catch (error) {
      // We did read the file and there is nothing in it to preserve. Start
      // empty but loudly, like `loadBurrowAcl`: an empty ACL silently de-pairs
      // every device, so it must at least be explicable from a log.
      console.warn(`[burrow] could not read ${this.#path}; starting empty`, error);
      return emptyState();
    }
  }

  async #write(state: BurrowStateFile): Promise<void> {
    // 0700 dir + 0600 file: the enrollment is a bearer credential, and the app
    // data directory is not otherwise private on a shared machine.
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    // `mkdir` applies its mode only when it creates the final component. Tauri
    // creates app_data_dir before spawning us, commonly under a 0755 umask, so
    // tighten an existing directory too. Best-effort, like `peer-link.ts`'s:
    // failing the whole save over the directory would lose the Burrow instead.
    //
    // Skipped on Windows because there is nothing here to skip *to* — a Unix
    // mode is a silent no-op on that platform, and so is the 0600 on the file
    // below, so neither call protects anything. What protects it there is the
    // owner-only DACL that `burrow_state_dir` in
    // `standalone/src-tauri/src/lib.rs` applies to this directory before
    // spawning us; the files written below inherit it. Node cannot set an ACL,
    // which is why the guarantee lives on the Rust side rather than here.
    if (process.platform !== 'win32') await chmod(this.#dir, 0o700).catch(() => {});
    // Temp-then-rename in the same directory, so a crash mid-write leaves the
    // previous state intact rather than a truncated file that reads as "no Burrow".
    // Unique per write rather than per process: `#mutate` already keeps this
    // process's saves apart, and a second Dormouse sharing the state directory
    // would otherwise rename a file the first one is still writing.
    const tmp = `${this.#path}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
      await rename(tmp, this.#path);
      renamed = true;
    } finally {
      // A failed rename must not accumulate bearer-credential temp files.
      if (!renamed) await rm(tmp, { force: true }).catch(() => {});
    }
  }
}

/**
 * The store for a run with no state directory (the browser dev harness).
 *
 * Held in memory rather than dropped: a Burrow enrolled here has to keep working
 * for the rest of the session — its ACL is what authorizes every pairing it
 * then approves, and reads that answered empty would de-pair each device the
 * moment it was approved. Nothing survives the process, which `persistent` says
 * out loud and the dev loop warns about once.
 */
export function createEphemeralBurrowStateStore(onWarn: (message: string) => void): BurrowStateStore {
  let warned = false;
  const warnOnce = (): void => {
    if (warned) return;
    warned = true;
    onWarn('[burrow] no state directory; the Burrow is in memory and will not survive a restart');
  };
  let enrollment: BurrowEnrollment | null = null;
  const acl = new Map<string, BurrowAclRecord[]>();
  return {
    persistent: false,
    loadEnrollment: async () => enrollment,
    saveEnrollment: async (next) => {
      warnOnce();
      enrollment = next;
    },
    clearEnrollment: async () => {
      enrollment = null;
    },
    loadAcl: async (burrowId) => filterAclRecords(burrowId, acl.get(burrowId) ?? []),
    saveAcl: async (burrowId, records) => {
      warnOnce();
      acl.set(burrowId, [...records]);
    },
  };
}
