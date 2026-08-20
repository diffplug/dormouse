/**
 * Where a Node-resident Host keeps the two things it must survive a restart
 * with: the enrollment (which carries `hostToken`, a bearer credential) and the
 * ACL (the authorization primitive, which per the security model lives on the
 * Host and nowhere else — docs/specs/remote-security-model.md).
 *
 * The interface is async because the hosts that implement it are: a file the
 * sidecar owns here, VS Code `SecretStorage` later. {@link FileHostStateStore}
 * is the sidecar's: one file, 0600, under a directory the app passes in.
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostAclRecord } from 'server-lib-common';
import { filterAclRecords } from '../../remote/host/acl';
import { isEnrollment, type HostEnrollment } from '../../remote/host/enrollment';
import { createSerialQueue } from './serial-queue';

// Re-exported so an implementor can name the record type without depending on
// `server-lib-common` itself; vscode-ext's project does not resolve it.
export type { HostAclRecord };

export interface HostStateStore {
  /**
   * Whether a write survives this process. Only the dev-harness store (no state
   * directory) says `false`, and an adopting webview reads it to decide whether
   * it may drop its own copy of the Host (`service.ts` → `#adopt`). Required
   * rather than optional: a store that forgot to answer would be read as durable
   * and could cost the webview the only copy that outlives the process.
   */
  readonly persistent: boolean;
  loadEnrollment(): Promise<HostEnrollment | null>;
  saveEnrollment(enrollment: HostEnrollment): Promise<void>;
  clearEnrollment(): Promise<void>;
  loadAcl(hostId: string): Promise<HostAclRecord[]>;
  saveAcl(hostId: string, records: readonly HostAclRecord[]): Promise<void>;
}

const FILE_NAME = 'remote-host.json';

interface HostStateFile {
  version: 1;
  enrollment: HostEnrollment | null;
  /** Keyed by hostId so a re-enrollment cannot inherit a stale ACL. */
  acl: Record<string, HostAclRecord[]>;
}

function emptyState(): HostStateFile {
  return { version: 1, enrollment: null, acl: {} };
}

function parseState(raw: string): HostStateFile {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
  const { enrollment, acl } = parsed as { enrollment?: unknown; acl?: unknown };
  const state = emptyState();
  if (isEnrollment(enrollment)) state.enrollment = enrollment;
  if (acl && typeof acl === 'object') {
    for (const [hostId, records] of Object.entries(acl as Record<string, unknown>)) {
      if (Array.isArray(records)) state.acl[hostId] = records as HostAclRecord[];
    }
  }
  return state;
}

/**
 * One JSON file holding both values. A single file rather than one per value so
 * a write is one atomic rename: the enrollment and the records approved under it
 * can never end up describing different Hosts.
 */
export class FileHostStateStore implements HostStateStore {
  readonly persistent = true;

  readonly #dir: string;
  readonly #path: string;
  #state: Promise<HostStateFile> | null = null;
  /**
   * Serializes mutations, the way `server/src/state.ts` does: every save is a
   * read-modify-write of the whole file, so two of them running together can
   * interleave their writes and renames and land the older one last.
   */
  readonly #serialize = createSerialQueue();

  constructor(stateDir: string) {
    this.#dir = stateDir;
    this.#path = join(stateDir, FILE_NAME);
  }

  async loadEnrollment(): Promise<HostEnrollment | null> {
    return (await this.#read()).enrollment;
  }

  saveEnrollment(enrollment: HostEnrollment): Promise<void> {
    return this.#mutate((state) => {
      state.enrollment = enrollment;
    });
  }

  clearEnrollment(): Promise<void> {
    return this.#mutate((state) => {
      state.enrollment = null;
    });
  }

  async loadAcl(hostId: string): Promise<HostAclRecord[]> {
    return filterAclRecords(hostId, (await this.#read()).acl[hostId] ?? []);
  }

  saveAcl(hostId: string, records: readonly HostAclRecord[]): Promise<void> {
    return this.#mutate((state) => {
      state.acl[hostId] = [...records];
    });
  }

  /** Apply one change to the in-memory state and flush it, one at a time. */
  #mutate(change: (state: HostStateFile) => void): Promise<void> {
    return this.#serialize(async () => {
      // A read that failed rejects here and takes the whole save with it: every
      // change is a read-modify-write of the whole file, so writing without
      // having read it would replace state we could not see with state we
      // invented (`#read`).
      const current = await this.#read();
      // Do not expose a mutation through later reads until its atomic rename
      // has succeeded. In particular, a failed enrollment save must not make a
      // later adoption believe the Host is durable and discard the webview's
      // only surviving copy. Changes replace top-level enrollment / ACL slots,
      // so a shallow copy of the map is the required transaction boundary.
      const next: HostStateFile = { ...current, acl: { ...current.acl } };
      change(next);
      await this.#write(next);
      this.#state = Promise.resolve(next);
    });
  }

  #read(): Promise<HostStateFile> {
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

  async #readOnce(): Promise<HostStateFile> {
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
      // empty but loudly, like `loadHostAcl`: an empty ACL silently de-pairs
      // every device, so it must at least be explicable from a log.
      console.warn(`[remote-host] could not read ${this.#path}; starting empty`, error);
      return emptyState();
    }
  }

  async #write(state: HostStateFile): Promise<void> {
    // 0700 dir + 0600 file: the enrollment is a bearer credential, and the app
    // data directory is not otherwise private on a shared machine.
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    // `mkdir` applies its mode only when it creates the final component. Tauri
    // creates app_data_dir before spawning us, commonly under a 0755 umask, so
    // tighten an existing directory too. Windows ACLs are not Unix modes.
    // Best-effort, like `peer-link.ts`'s: on a filesystem with no POSIX modes
    // the 0600 on the file below is the protection that matters, and failing
    // the whole save over the directory would lose the Host instead.
    if (process.platform !== 'win32') await chmod(this.#dir, 0o700).catch(() => {});
    // Temp-then-rename in the same directory, so a crash mid-write leaves the
    // previous state intact rather than a truncated file that reads as "no Host".
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
 * Held in memory rather than dropped: a Host enrolled here has to keep working
 * for the rest of the session — its ACL is what authorizes every pairing it
 * then approves, and reads that answered empty would de-pair each device the
 * moment it was approved. Nothing survives the process, which `persistent`
 * says out loud so the webview keeps its own copy of an adopted Host.
 */
export function createEphemeralHostStateStore(onWarn: (message: string) => void): HostStateStore {
  let warned = false;
  const warnOnce = (): void => {
    if (warned) return;
    warned = true;
    onWarn('[remote-host] no state directory; the Host is in memory and will not survive a restart');
  };
  let enrollment: HostEnrollment | null = null;
  const acl = new Map<string, HostAclRecord[]>();
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
    loadAcl: async (hostId) => filterAclRecords(hostId, acl.get(hostId) ?? []),
    saveAcl: async (hostId, records) => {
      warnOnce();
      acl.set(hostId, [...records]);
    },
  };
}
