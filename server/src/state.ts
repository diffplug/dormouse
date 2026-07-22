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
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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

/**
 * A tiny JSON-file store: the whole file is one JSON value, written through a
 * temp-file-plus-rename so a crash mid-write can never leave a half-written
 * (unparseable) file, with mutations serialized through a promise chain so two
 * concurrent read-modify-writes cannot clobber each other. Subclasses layer
 * their find/append logic on top. Deliberately not a database (see the module
 * header).
 */
abstract class JsonFileStore {
  readonly #stateDir: string;
  readonly #path: string;
  /** Wall clock, injectable for deterministic tests. */
  protected readonly now: () => number;
  /** Serializes mutations so overlapping writes do not lose each other. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string, fileName: string, now: () => number) {
    this.#stateDir = stateDir;
    this.#path = join(stateDir, fileName);
    this.now = now;
  }

  /** Read and parse the file, or `fallback` if it does not exist yet. */
  protected async read<T>(fallback: T): Promise<T> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw err;
    }
    return JSON.parse(raw) as T;
  }

  /**
   * Overwrite the whole file atomically (temp file + rename). `hosts.json`
   * holds `hostToken` in plaintext, so the directory is owner-only (`0o700`)
   * and every file owner-read/write (`0o600`) — without an explicit mode both
   * inherit the umask, which on a typical Linux box yields world-readable
   * `0o755`/`0o644` and leaks live host tokens to every other local account.
   * The mode only applies when the file is created, so `rename` onto an
   * existing path keeps the temp file's `0o600`.
   */
  protected async writeAtomic(value: unknown): Promise<void> {
    await mkdir(this.#stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.#path);
  }

  /**
   * Run `mutate` under the mutex. It is chained onto the tail regardless of
   * whether the previous op resolved or rejected, so one failure cannot wedge
   * the queue.
   */
  protected mutate<R>(mutate: () => Promise<R>): Promise<R> {
    const result = this.#tail.then(mutate, mutate);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

/** Fixed-length SHA-256 digest, so timing-safe compares never branch on length. */
function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

export class AccountStore extends JsonFileStore {
  constructor(stateDir: string, now: () => number = () => Date.now()) {
    super(stateDir, 'account.json', now);
  }

  /** Read `account.json`, or `null` if the account has not been created yet. */
  load(): Promise<Account | null> {
    return this.read<Account | null>(null);
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
    return this.mutate(async () => {
      const account: Account = (await this.load()) ?? {
        accountId: SELFHOST_ACCOUNT_ID,
        passkeys: [],
      };
      if (account.passkeys.some((p) => p.credentialId === passkey.credentialId)) {
        throw new DuplicateCredentialError(passkey.credentialId);
      }
      account.passkeys.push({ ...passkey, createdAt: this.now() });
      await this.writeAtomic(account);
      return account;
    });
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
export class HostStore extends JsonFileStore {
  constructor(stateDir: string, now: () => number = () => Date.now()) {
    super(stateDir, 'hosts.json', now);
  }

  /** Read `hosts.json`, or `[]` if no host has been enrolled yet. */
  list(): Promise<StoredHost[]> {
    return this.read<StoredHost[]>([]);
  }

  /**
   * Look up an enrolled host by its bearer token (the `/ws/host` credential).
   * The token is a secret, so it is compared with a constant-time digest
   * compare (mirroring the setup-password path in app.ts) rather than `===`,
   * whose early-exit leaks byte positions. Every host is checked without an
   * early break so the work does not depend on which entry matches.
   */
  async findByToken(hostToken: string): Promise<StoredHost | undefined> {
    const hosts = await this.list();
    const providedHash = sha256(hostToken);
    let match: StoredHost | undefined;
    for (const h of hosts) {
      if (timingSafeEqual(sha256(h.hostToken), providedHash)) match = h;
    }
    return match;
  }

  /**
   * Enroll a new host: mint a random `hostId` (16 bytes) and `hostToken`
   * (32 bytes), both base64url, append them, and return the record. Runs under
   * the mutex.
   */
  enroll(label: string): Promise<StoredHost> {
    return this.mutate(async () => {
      const hosts = await this.list();
      const host: StoredHost = {
        hostId: toBase64Url(randomBytes(16)),
        hostToken: toBase64Url(randomBytes(32)),
        label,
        enrolledAt: this.now(),
      };
      hosts.push(host);
      await this.writeAtomic(hosts);
      return host;
    });
  }
}
