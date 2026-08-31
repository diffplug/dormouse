/** JSON-file state stores; `docs/specs/server.md` → "State files" owns their schemas and invariants. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { SELFHOST_ACCOUNT_ID, toBase64Url } from 'server-lib-common';
import type { PushSubscriptionPayload } from 'server-lib-common';

import { secretEquals } from './secrets.js';

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

  /**
   * Read `hosts.json`, or `[]` if no host has been enrolled yet, dropping any
   * row that is not a well-formed enrollment.
   *
   * Validated on read for the same reason `PushSubscriptionStore.list` is:
   * hand-editing this file is the *documented* revocation mechanism
   * (Guardrails), so a half-finished edit is an expected state, not a
   * corruption. Unguarded, a row with a null `hostToken` makes `findByToken`'s
   * `secretEquals` throw, which 500s every `/ws/host` upgrade and every push
   * route — the whole server, over one bad line. Dropping the row instead
   * makes that host un-enrolled, which is what the person editing it was
   * reaching for anyway.
   */
  async list(): Promise<StoredHost[]> {
    const rows = await this.read<unknown[]>([]);
    return Array.isArray(rows) ? rows.filter(isStoredHost) : [];
  }

  /**
   * Look up an enrolled host by its bearer token (the `/ws/host` credential).
   * The token is a secret, so it is compared with `secretEquals` rather than
   * `===`, whose early-exit leaks byte positions. Every host is checked without
   * an early break so the work does not depend on which entry matches.
   */
  async findByToken(hostToken: string): Promise<StoredHost | undefined> {
    const hosts = await this.list();
    let match: StoredHost | undefined;
    for (const h of hosts) {
      if (secretEquals(h.hostToken, hostToken)) match = h;
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

function isStoredHost(row: unknown): row is StoredHost {
  if (!row || typeof row !== 'object') return false;
  const candidate = row as Record<string, unknown>;
  return (
    typeof candidate.hostId === 'string' &&
    typeof candidate.hostToken === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.enrolledAt === 'number'
  );
}

/** A Web Push subscription as stored in `push-subscriptions.json`. */
export interface StoredPushSubscription {
  readonly hostId: string;
  readonly devicePublicKey: string;
  readonly endpoint: string;
  readonly keys: PushSubscriptionPayload['keys'];
  /** Public VAPID key this endpoint was minted and registered under. */
  readonly vapidPublicKey: string;
  readonly subscribedAt: number;
}

export interface PushSubscriptionUpsertResult {
  readonly subscription: StoredPushSubscription;
  /**
   * Every Host this device is registered with after the mutation, including the
   * one just written. Computed inside the mutex, so it is the whole truth for
   * the device at the instant it was committed rather than a delta the caller
   * has to reconstruct.
   */
  readonly deviceHostIds: readonly string[];
}

/**
 * Push subscriptions (`push-subscriptions.json`), keyed on the PAIR
 * (`hostId`, `devicePublicKey`) — one Client subscribes once per Host it is
 * paired with, and a Host can only ever see or reach its own subscribers.
 *
 * Unlike its append-only siblings this store deletes: a push service reports a
 * dead subscription with 404/410, and re-subscribing after a browser rotates
 * the endpoint must replace the stale row rather than accumulate one per
 * rotation. Both paths run under the inherited mutex.
 *
 * No secret of ours lives here, but the endpoint plus its keys IS a bearer
 * capability to notify that phone, so the inherited `0o600` still matters.
 */
export class PushSubscriptionStore extends JsonFileStore {
  constructor(stateDir: string, now: () => number = () => Date.now()) {
    super(stateDir, 'push-subscriptions.json', now);
  }

  /**
   * The rows this Server can act on.
   *
   * Malformed rows are dropped here rather than defended against at each
   * consumer: this file is hand-editable by design — revoking a device is
   * deleting its rows — so a half-finished edit is a real case, and one guard
   * at the read boundary is what lets {@link StoredPushSubscription} be true
   * for every caller downstream. A mangled row therefore reads as a missing
   * registration, which re-offers Enable and repairs itself, instead of as a
   * live one that cannot be delivered to.
   */
  async list(): Promise<StoredPushSubscription[]> {
    const rows = await this.read<unknown>([]);
    return Array.isArray(rows) ? rows.filter(isStoredPushSubscription) : [];
  }

  async listForHost(hostId: string): Promise<StoredPushSubscription[]> {
    const all = await this.list();
    return all.filter((s) => s.hostId === hostId);
  }

  /**
   * Replace any existing subscription for this (host, device), or add one.
   *
   * A service-worker scope has one subscription shared by every Host. If its
   * endpoint, encryption keys, or VAPID key changes, every row for this device
   * points at the old delivery address. Drop those sibling rows atomically so
   * readback cannot claim they are still active.
   */
  upsert(
    record: Omit<StoredPushSubscription, 'subscribedAt'>,
  ): Promise<PushSubscriptionUpsertResult> {
    return this.mutate(async () => {
      const all = await this.list();
      const stored: StoredPushSubscription = { ...record, subscribedAt: this.now() };
      const deviceRegistrationsReset = all.some(
        (s) => s.devicePublicKey === record.devicePublicKey && !samePushAddress(s, record),
      );
      const kept = all.filter((s) =>
        deviceRegistrationsReset
          ? s.devicePublicKey !== record.devicePublicKey
          : !(s.hostId === record.hostId && s.devicePublicKey === record.devicePublicKey),
      );
      kept.push(stored);
      await this.writeAtomic(kept);
      // Every surviving row for this device necessarily shares `stored`'s
      // address, and `samePushAddress` compares the VAPID key too — so a row
      // minted under a rotated key is never among these, and the caller needs
      // no further filtering to know they are all deliverable.
      const deviceHostIds = kept
        .filter((s) => s.devicePublicKey === record.devicePublicKey)
        .map((s) => s.hostId);
      return { subscription: stored, deviceHostIds };
    });
  }

  /**
   * Drop subscriptions the push service reported as gone. Matched on endpoint
   * rather than device so a stale row cannot outlive its endpoint even if the
   * same device has since re-subscribed with a new one.
   *
   * Takes the whole set because a fan-out can expire several at once, and one
   * rewrite is both cheaper and less code than a serialized call per endpoint.
   */
  removeEndpoints(endpoints: readonly string[]): Promise<number> {
    return this.mutate(async () => {
      const gone = new Set(endpoints);
      const all = await this.list();
      const kept = all.filter((s) => !gone.has(s.endpoint));
      if (kept.length === all.length) return 0;
      await this.writeAtomic(kept);
      return all.length - kept.length;
    });
  }
}

function samePushAddress(
  left: Omit<StoredPushSubscription, 'subscribedAt'>,
  right: Omit<StoredPushSubscription, 'subscribedAt'>,
): boolean {
  return (
    left.endpoint === right.endpoint &&
    left.keys.p256dh === right.keys.p256dh &&
    left.keys.auth === right.keys.auth &&
    left.vapidPublicKey === right.vapidPublicKey
  );
}

/**
 * Whether an on-disk row is a subscription this Server can use. Guards
 * {@link PushSubscriptionStore.list}, which is the only way rows enter the
 * process — so every field the type declares is present past that point.
 */
function isStoredPushSubscription(row: unknown): row is StoredPushSubscription {
  const s = row as Partial<StoredPushSubscription> | null;
  return (
    typeof s?.hostId === 'string' &&
    typeof s.devicePublicKey === 'string' &&
    typeof s.endpoint === 'string' &&
    typeof s.keys?.p256dh === 'string' &&
    typeof s.keys.auth === 'string' &&
    typeof s.vapidPublicKey === 'string' &&
    typeof s.subscribedAt === 'number'
  );
}

/** The VAPID keypair as stored in `vapid.json`. Both values are base64url. */
export interface StoredVapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly createdAt: number;
}

/**
 * VAPID keypair custody (`vapid.json`). Only used when the keys are not
 * supplied by env: a selfhost POC should not need a key ceremony before push
 * works, but the keypair must still survive a restart or every phone's
 * subscription is silently invalidated.
 *
 * This file holds a private key, which is exactly what the inherited
 * `0o700`/`0o600` handling exists for.
 */
export class VapidStore extends JsonFileStore {
  constructor(stateDir: string, now: () => number = () => Date.now()) {
    super(stateDir, 'vapid.json', now);
  }

  load(): Promise<StoredVapidKeys | null> {
    return this.read<StoredVapidKeys | null>(null);
  }

  /**
   * Return the persisted keypair, generating and saving one on first call.
   * Serialized with this store's other writes like every other mutation — note
   * the mutex is per-process, so two servers sharing a state dir would still
   * race; sharing one is already unsupported.
   */
  loadOrCreate(generate: () => { publicKey: string; privateKey: string }): Promise<StoredVapidKeys> {
    return this.mutate(async () => {
      const existing = await this.load();
      if (existing) return existing;
      const created: StoredVapidKeys = { ...generate(), createdAt: this.now() };
      await this.writeAtomic(created);
      return created;
    });
  }
}
