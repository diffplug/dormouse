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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostAclRecord } from 'server-lib-common';
import type { HostEnrollment } from '../../remote/host/enrollment';

export interface HostStateStore {
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

function isEnrollment(value: unknown): value is HostEnrollment {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.serverUrl === 'string' &&
    typeof v.hostId === 'string' &&
    typeof v.hostToken === 'string' &&
    typeof v.origin === 'string' &&
    typeof v.rpId === 'string'
  );
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
  readonly #dir: string;
  readonly #path: string;
  #state: Promise<HostStateFile> | null = null;

  constructor(stateDir: string) {
    this.#dir = stateDir;
    this.#path = join(stateDir, FILE_NAME);
  }

  async loadEnrollment(): Promise<HostEnrollment | null> {
    return (await this.#read()).enrollment;
  }

  async saveEnrollment(enrollment: HostEnrollment): Promise<void> {
    const state = await this.#read();
    state.enrollment = enrollment;
    await this.#write(state);
  }

  async clearEnrollment(): Promise<void> {
    const state = await this.#read();
    state.enrollment = null;
    await this.#write(state);
  }

  async loadAcl(hostId: string): Promise<HostAclRecord[]> {
    const records = (await this.#read()).acl[hostId] ?? [];
    // `HostAcl.fromRecords` rejects a mismatched hostId, so drop foreign rows
    // rather than fail the whole load over one.
    return records.filter((record) => !!record && record.hostId === hostId);
  }

  async saveAcl(hostId: string, records: readonly HostAclRecord[]): Promise<void> {
    const state = await this.#read();
    state.acl[hostId] = [...records];
    await this.#write(state);
  }

  #read(): Promise<HostStateFile> {
    // Read once and keep it: this process is the only writer, so the in-memory
    // copy is the file, and a save is a full rewrite of what we already hold.
    this.#state ??= (async () => {
      try {
        return parseState(await readFile(this.#path, 'utf8'));
      } catch (error) {
        if ((error as { code?: string } | null)?.code !== 'ENOENT') {
          // Fail closed but loudly, like `loadHostAcl`: starting empty silently
          // de-pairs every device, so it must at least be explicable from a log.
          console.warn(`[remote-host] could not read ${this.#path}; starting empty`, error);
        }
        return emptyState();
      }
    })();
    return this.#state;
  }

  async #write(state: HostStateFile): Promise<void> {
    // 0700 dir + 0600 file: the enrollment is a bearer credential, and the app
    // data directory is not otherwise private on a shared machine.
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    // Temp-then-rename in the same directory, so a crash mid-write leaves the
    // previous state intact rather than a truncated file that reads as "no Host".
    const tmp = `${this.#path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await rename(tmp, this.#path);
  }
}

/**
 * The store for a run with no state directory (the browser dev harness). Reads
 * answer empty and writes are dropped, so a Host can be enrolled and used for
 * the session but nothing survives a restart.
 */
export function createEphemeralHostStateStore(onWarn: (message: string) => void): HostStateStore {
  let warned = false;
  const warnOnce = (): void => {
    if (warned) return;
    warned = true;
    onWarn('[remote-host] no state directory; enrollment will not survive a restart');
  };
  return {
    loadEnrollment: async () => null,
    saveEnrollment: async () => warnOnce(),
    clearEnrollment: async () => {},
    loadAcl: async () => [],
    saveAcl: async () => warnOnce(),
  };
}
