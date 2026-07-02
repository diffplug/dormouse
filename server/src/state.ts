/**
 * Persistent state for the selfhost POC (docs/specs/server.md, "State files"):
 *
 *   $DORMOUSE_STATE_DIR/account.json
 *     { accountId: "owner", passkeys: [{ credentialId, publicKey, label, createdAt }] }
 *   $DORMOUSE_STATE_DIR/hosts.json
 *     [{ hostId, hostToken, label, enrolledAt }]
 *
 * Deliberately not a database: one account, a handful of passkeys and hosts,
 * hand-editable for revocation. Writes go through a temp-file-plus-rename so a
 * crash mid-write can never leave a half-written (and therefore unparseable)
 * file, and mutations are serialized through a promise chain so two concurrent
 * appends cannot clobber each other (read-modify-write races).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { SELFHOST_ACCOUNT_ID, toBase64Url } from 'server-lib-common';

/** A registered passkey as stored on disk. `publicKey` is base64url SPKI. */
export interface StoredPasskey {
  readonly credentialId: string;
  readonly publicKey: string;
  readonly label: string;
  readonly createdAt: number;
}

/** The whole of `account.json`. */
export interface Account {
  readonly accountId: string;
  readonly passkeys: StoredPasskey[];
}

/** Thrown by {@link AccountStore.appendPasskey} when the credential id is already registered. */
export class DuplicateCredentialError extends Error {
  constructor(credentialId: string) {
    super(`credential ${credentialId} is already registered`);
    this.name = 'DuplicateCredentialError';
  }
}

export class AccountStore {
  readonly #stateDir: string;
  readonly #path: string;
  readonly #now: () => number;
  /** Serializes mutations so overlapping appends do not lose writes. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string, now: () => number = () => Date.now()) {
    this.#stateDir = stateDir;
    this.#path = join(stateDir, 'account.json');
    this.#now = now;
  }

  /** Read `account.json`, or `null` if the account has not been created yet. */
  async load(): Promise<Account | null> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return JSON.parse(raw) as Account;
  }

  /** Look up a stored passkey by its base64url credential id. */
  async findPasskey(credentialId: string): Promise<StoredPasskey | undefined> {
    const account = await this.load();
    return account?.passkeys.find((p) => p.credentialId === credentialId);
  }

  /**
   * Append a passkey to the account, creating the account on first
   * registration. Rejects with {@link DuplicateCredentialError} if the
   * credential id already exists. Runs under the mutex.
   */
  appendPasskey(passkey: Omit<StoredPasskey, 'createdAt'>): Promise<Account> {
    const run = async (): Promise<Account> => {
      const account: Account = (await this.load()) ?? {
        accountId: SELFHOST_ACCOUNT_ID,
        passkeys: [],
      };
      if (account.passkeys.some((p) => p.credentialId === passkey.credentialId)) {
        throw new DuplicateCredentialError(passkey.credentialId);
      }
      account.passkeys.push({ ...passkey, createdAt: this.#now() });
      await this.#writeAtomic(account);
      return account;
    };
    // Chain onto the tail regardless of whether the previous op resolved or
    // rejected, so one failed append does not wedge the queue.
    const result = this.#tail.then(run, run);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #writeAtomic(account: Account): Promise<void> {
    await mkdir(this.#stateDir, { recursive: true });
    const tmp = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(account, null, 2)}\n`, 'utf8');
    await rename(tmp, this.#path);
  }
}

/** An enrolled Host as stored in `hosts.json`. `hostToken` is the WS bearer secret. */
export interface StoredHost {
  readonly hostId: string;
  readonly hostToken: string;
  readonly label: string;
  readonly enrolledAt: number;
}

/**
 * Persistent host enrollment (`hosts.json`). Mirrors {@link AccountStore}: an
 * append-only JSON array, atomic writes, and a mutex so concurrent enrollments
 * cannot lose a write. Revocation is deleting a line by hand (POC guardrail).
 */
export class HostStore {
  readonly #stateDir: string;
  readonly #path: string;
  readonly #now: () => number;
  /** Serializes mutations so overlapping enrollments do not lose writes. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string, now: () => number = () => Date.now()) {
    this.#stateDir = stateDir;
    this.#path = join(stateDir, 'hosts.json');
    this.#now = now;
  }

  /** Read `hosts.json`, or `[]` if no host has been enrolled yet. */
  async list(): Promise<StoredHost[]> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return JSON.parse(raw) as StoredHost[];
  }

  /** Look up an enrolled host by its bearer token (the `/ws/host` credential). */
  async findByToken(hostToken: string): Promise<StoredHost | undefined> {
    const hosts = await this.list();
    return hosts.find((h) => h.hostToken === hostToken);
  }

  /**
   * Enroll a new host: mint a random `hostId` (16 bytes) and `hostToken`
   * (32 bytes), both base64url, append them, and return the record. Runs under
   * the mutex.
   */
  enroll(label: string): Promise<StoredHost> {
    const run = async (): Promise<StoredHost> => {
      const hosts = await this.list();
      const host: StoredHost = {
        hostId: toBase64Url(randomBytes(16)),
        hostToken: toBase64Url(randomBytes(32)),
        label,
        enrolledAt: this.#now(),
      };
      hosts.push(host);
      await this.#writeAtomic(hosts);
      return host;
    };
    // Chain regardless of prior resolve/reject so one failure cannot wedge the queue.
    const result = this.#tail.then(run, run);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #writeAtomic(hosts: StoredHost[]): Promise<void> {
    await mkdir(this.#stateDir, { recursive: true });
    const tmp = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(hosts, null, 2)}\n`, 'utf8');
    await rename(tmp, this.#path);
  }
}
