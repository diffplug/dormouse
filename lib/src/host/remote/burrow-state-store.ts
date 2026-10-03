/**
 * Where a Node-resident Burrow keeps the two things it must survive a restart
 * with: the enrollment (which carries `burrowToken`, a bearer credential) and the
 * ACL (the authorization primitive, which per the security model lives on the
 * Burrow and nowhere else — docs/specs/remote-security-model.md). The network
 * policy rides beside them (`docs/specs/remote-network.md` -> "Policy").
 *
 * The interface is async because the hosts that implement it are: files the
 * sidecar owns here, `VsCodeBurrowStateStore` there (enrollment in
 * `SecretStorage`, ACL in `globalState` — `docs/specs/vscode.md`). {@link FileBurrowStateStore}
 * is the sidecar's: private JSON state under a directory the app passes in
 * only after establishing owner-only access (POSIX modes or a Windows DACL).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BurrowAclRecord } from 'remote-lib-common';
import { filterAclRecords } from '../../remote/burrow/acl';
import { isEnrollment, type BurrowEnrollment } from '../../remote/burrow/enrollment';
import { nothingPolicy, storedNetworkPolicy, type NetworkPolicy } from '../../remote/network-policy';
import { writeJsonAtomic } from '../atomic-json-file';
import { createSerialQueue } from './serial-queue';

// Re-exported so an implementor can name the record type without depending on
// `remote-lib-common` itself; vscode-ext's project does not resolve it.
export type { BurrowAclRecord };

export interface BurrowStateStore {
  /**
   * Whether a write survives this process. A host without a usable private
   * state directory uses an ephemeral store and reports `false`. Required
   * rather than optional: an implementor must state its durability before
   * a consumer can rely on it.
   */
  readonly persistent: boolean;
  loadEnrollment(): Promise<BurrowEnrollment | null>;
  saveEnrollment(enrollment: BurrowEnrollment): Promise<void>;
  clearEnrollment(): Promise<void>;
  loadAcl(burrowId: string): Promise<BurrowAclRecord[]>;
  saveAcl(burrowId: string, records: readonly BurrowAclRecord[]): Promise<void>;
  /**
   * `null` where none was ever saved, which the service turns into this build's
   * default and saves; a record that is not a policy reads as Nothing
   * (`storedNetworkPolicy`).
   */
  loadNetworkPolicy(): Promise<NetworkPolicy | null>;
  saveNetworkPolicy(policy: NetworkPolicy): Promise<void>;
}

const FILE_NAME = 'burrow.json';

/**
 * The network policy's own file, beside {@link FILE_NAME} and never in it: a
 * build from before the policy rewrites that file with only the fields it
 * knows, and a policy it dropped would let the default recompute.
 */
const NETWORK_POLICY_FILE_NAME = 'network-policy.json';

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
 * can never end up describing different Burrows. The network policy, which
 * describes no Burrow, has its own ({@link NETWORK_POLICY_FILE_NAME}).
 */
export class FileBurrowStateStore implements BurrowStateStore {
  readonly persistent = true;

  readonly #dir: string;
  readonly #path: string;
  readonly #policyPath: string;
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
    this.#policyPath = join(stateDir, NETWORK_POLICY_FILE_NAME);
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

  /**
   * Not memoized: the service, its one reader, keeps what it read.
   * `null` for no file, which the service turns into the default and saves.
   * **A file that is there but not a policy reads as Nothing** — never `null`,
   * which would let a damaged file's default reopen what the user turned off.
   */
  async loadNetworkPolicy(): Promise<NetworkPolicy | null> {
    const raw = await readIfPresent(this.#policyPath);
    if (raw === null) return null;
    try {
      return storedNetworkPolicy(JSON.parse(raw));
    } catch (error) {
      console.warn(`[burrow] could not read ${this.#policyPath}; reading it as Nothing`, error);
      return nothingPolicy();
    }
  }

  saveNetworkPolicy(policy: NetworkPolicy): Promise<void> {
    // A whole-record replace, so no read first; on the same chain as `#mutate`,
    // so two saves land in the order they were made.
    return this.#serialize(() => writeJsonAtomic(this.#dir, this.#policyPath, policy));
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
    const raw = await readIfPresent(this.#path);
    // Nothing written yet is the ordinary state of a machine that never
    // enrolled, and it is the one failure that genuinely means "empty".
    if (raw === null) return emptyState();
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

  /** The enrollment is a bearer credential and a truncated file reads as "no
   *  Burrow", so the write is the shared owner-only atomic one. `#mutate`
   *  already keeps this process's saves apart. */
  #write(state: BurrowStateFile): Promise<void> {
    return writeJsonAtomic(this.#dir, this.#path, state);
  }
}

/** `path`'s contents, or `null` where there is no file; any other failure rejects. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The store for a run whose host could not create a state directory — the
 * browser dev harness is *not* this case, since it passes a per-run temp
 * `DORMOUSE_STATE_DIR` (docs/specs/standalone.md -> "Burrow service").
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
  let network: NetworkPolicy | null = null;
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
    loadNetworkPolicy: async () => network,
    saveNetworkPolicy: async (policy) => {
      warnOnce();
      network = { ...policy, allowed: [...policy.allowed] };
    },
  };
}
