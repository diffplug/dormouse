/** JSON-file state stores; `docs/specs/server.md` → "State files" owns their schemas and invariants. */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  E2E_ID_BYTE_LENGTH,
  SELFHOST_ACCOUNT_ID,
  base64UrlLength,
  isE2eId,
  isExactBase64Url,
  toBase64Url,
} from 'server-lib-common';
import type { PushSubscriptionPayload } from 'server-lib-common';

import { secretEquals } from './secrets.js';
import { isSetupPassword } from './setup-password.js';

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
 * A state file that is present but does not hold what its store expects.
 *
 * Thrown rather than read as first boot, because the caller's next move is to
 * mint a replacement *over* it: a `vapid.json` holding `null` that reads as
 * absence costs every phone its push subscription, and an `account.json` that
 * does the same starts a fresh account under the next registration.
 */
export class CorruptStateError extends Error {
  constructor(
    readonly path: string,
    what: string,
  ) {
    super(`${path} does not contain a valid ${what}`);
    this.name = 'CorruptStateError';
  }
}

/**
 * What {@link JsonFileStore.loadRecord} needs to know about a *singleton
 * record* — a file that is either there and whole or not there at all, as
 * opposed to the collection files whose rows are filtered individually.
 */
interface RecordShape<T> {
  /** Names the record in the error an operator reads, e.g. `VAPID keypair`. */
  readonly what: string;
  isValid(value: unknown): value is T;
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
  /** The last parse {@link readCached} served, keyed by the stat behind it. */
  #cached: { key: string; value: unknown } | null = null;

  constructor(stateDir: string, fileName: string, now: () => number) {
    this.#stateDir = stateDir;
    this.#path = join(stateDir, fileName);
    this.now = now;
  }

  /**
   * Read and parse the file, or `null` if it is not there.
   *
   * Separate from {@link read} because one caller needs the distinction that
   * one erases: a file that is absent for an instant — a rename in flight —
   * is not the same fact as a file that lists nobody.
   */
  protected async readIfPresent<T>(): Promise<T | null> {
    return (await this.readIfExists<T>()) ?? null;
  }

  /**
   * {@link readIfPresent}, reporting absence as `undefined` so it stays distinct
   * from a file whose whole content is the JSON value `null`. JSON cannot encode
   * `undefined`, so the two can never collide.
   *
   * For a store whose record is always an object, `null` on disk is corrupt
   * state rather than first boot, and telling them apart with a second `stat`
   * would read the filesystem at a different instant than the read it explains.
   */
  protected async readIfExists<T>(): Promise<T | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    return JSON.parse(raw) as T;
  }

  /** Read and parse the file, or `fallback` if it does not exist yet. */
  protected async read<T>(fallback: T): Promise<T> {
    return (await this.readIfPresent<T>()) ?? fallback;
  }

  /**
   * {@link readIfPresent}, reusing the last parse while the file is unchanged.
   *
   * For the reads an unauthenticated caller provokes: `findByToken` runs on
   * every host-gated request and every `/ws/host` upgrade, so without this a
   * well-shaped guess buys a `readFile` and a `JSON.parse` for the price of one
   * request — and the origin may be public
   * (`docs/specs/security-remote.md` -> "Network posture (self-hosted)").
   *
   * **Hand-editing the file is the revocation mechanism**, so the gate is a
   * stat rather than a TTL: an edit changes size or mtime, and `writeAtomic`
   * renames a fresh temp file over the path, changing the inode as well as
   * dropping this outright. A read that races a write caches content under the
   * stat that preceded it and re-reads on the next call, which is the same
   * resolution an uncached read has.
   */
  protected async readCached<T>(): Promise<T | null> {
    let key: string;
    try {
      const meta = await stat(this.#path);
      key = `${meta.ino}:${meta.size}:${meta.mtimeMs}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#cached = null;
        return null;
      }
      throw err;
    }
    if (this.#cached?.key === key) return this.#cached.value as T;
    const value = await this.readIfPresent<T>();
    this.#cached = value === null ? null : { key, value };
    return value;
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
    this.#cached = null;
  }

  /** Whether this store's durable file has ever been written. */
  protected exists(): Promise<boolean> {
    return stat(this.#path).then(
      () => true,
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return false;
        throw err;
      },
    );
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

  /**
   * Read a singleton record, validating it on the way in. `undefined` means the
   * file is not there; a present file that fails `shape` throws
   * {@link CorruptStateError}.
   *
   * `readIfExists`, not `readIfPresent`: a file whose whole content is `null`
   * is corrupt state, and the two are indistinguishable once absence is `null`
   * too.
   */
  protected async loadRecord<T>(shape: RecordShape<T>): Promise<T | undefined> {
    let stored: unknown;
    try {
      stored = await this.readIfExists<unknown>();
    } catch (err) {
      // Hand-editing is the documented revocation mechanism, so malformed JSON
      // is the same operator mistake as a parsed value with the wrong shape.
      if (err instanceof SyntaxError) throw new CorruptStateError(this.#path, shape.what);
      throw err;
    }
    if (stored === undefined) return undefined;
    if (!shape.isValid(stored)) throw new CorruptStateError(this.#path, shape.what);
    return stored;
  }

  /**
   * Return the persisted record, minting and saving one on first boot. Under
   * the mutex like every other write — note it is per-process, so two servers
   * sharing a state dir would still race; sharing one is already unsupported.
   *
   * The mint is validated against the same shape the read uses, so a regression
   * in a generator cannot persist a record the next boot would refuse. A
   * refused mint writes nothing.
   */
  protected loadOrCreateRecord<T extends { readonly createdAt: number }>(
    shape: RecordShape<T>,
    create: () => Omit<T, 'createdAt'>,
  ): Promise<T> {
    return this.mutate(async () => {
      const existing = await this.loadRecord(shape);
      if (existing !== undefined) return existing;
      const created = { ...create(), createdAt: this.now() } as T;
      if (!shape.isValid(created)) {
        throw new Error(`the generated ${shape.what} is not valid; nothing was written`);
      }
      await this.writeAtomic(created);
      return created;
    });
  }
}

/** The server-owned Host-enrollment credential stored in `setup-password.json`. */
export interface StoredSetupPassword {
  readonly password: string;
  readonly createdAt: number;
}

/**
 * Setup-password custody. The value is generated inside the Server on first
 * boot, not accepted as configuration, so a public deployment cannot be
 * weakened by a memorable or placeholder operator-supplied password.
 */
export class SetupPasswordStore extends JsonFileStore {
  constructor(stateDir: string, now: () => number = () => Date.now()) {
    super(stateDir, 'setup-password.json', now);
  }

  /** Load and validate the durable credential, or `null` before first boot. */
  async load(): Promise<StoredSetupPassword | null> {
    return (await this.loadRecord(SETUP_PASSWORD_RECORD)) ?? null;
  }

  /** Return the persisted credential, minting and saving it on first boot. */
  async loadOrCreate(generate: () => string): Promise<string> {
    const stored = await this.loadOrCreateRecord(SETUP_PASSWORD_RECORD, () => ({
      password: generate(),
    }));
    return stored.password;
  }
}

const SETUP_PASSWORD_RECORD: RecordShape<StoredSetupPassword> = {
  what: 'setup password',
  isValid: isStoredSetupPassword,
};

function isStoredSetupPassword(value: unknown): value is StoredSetupPassword {
  if (!value || typeof value !== 'object') return false;
  const stored = value as Record<string, unknown>;
  // An array fails on `password` alone, and `Number.isFinite` does not coerce,
  // so it carries the `typeof` too.
  return isSetupPassword(stored.password) && Number.isFinite(stored.createdAt);
}

export class AccountStore extends JsonFileStore {
  constructor(stateDir: string, now: () => number = () => Date.now()) {
    super(stateDir, 'account.json', now);
  }

  /** Read `account.json`, or `null` if the account has not been created yet. */
  async load(): Promise<Account | null> {
    return (await this.loadRecord(ACCOUNT_RECORD)) ?? null;
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

/**
 * The envelope only. Passkey rows are left as they are found: this file is a
 * documented hand-edit target (Guardrails) and deleting a row is how a passkey
 * is revoked, so the shape check belongs around the array rather than inside
 * it. What the envelope catches is the file being replaced wholesale — `null`
 * most of all, which would otherwise read as "no account yet" and let the next
 * registration start a fresh one over it.
 */
function isAccount(value: unknown): value is Account {
  if (!value || typeof value !== 'object') return false;
  const stored = value as Record<string, unknown>;
  return typeof stored.accountId === 'string' && Array.isArray(stored.passkeys);
}

const ACCOUNT_RECORD: RecordShape<Account> = { what: 'account record', isValid: isAccount };

/**
 * An enrolled Host as stored in `hosts.json`. `hostToken` is the WS bearer
 * secret. **No label**: the name a Host presents is its own, and a Client only
 * ever learns it inside an encrypted ceremony outcome
 * (`docs/specs/remote-security-model.md` → Host identity). A row written before
 * that cutover carries one; it is simply ignored.
 */
export interface StoredHost {
  readonly hostId: string;
  readonly hostToken: string;
  readonly enrolledAt: number;
}

/**
 * The one shape a `hostToken` has: 32 random bytes, base64url. Minted here and
 * required at every lookup, the way `hostId` is pinned to `isE2eId`
 * (`docs/specs/server.md` -> State files).
 */
const HOST_TOKEN_BYTE_LENGTH = 32;
export const HOST_TOKEN_LENGTH = base64UrlLength(HOST_TOKEN_BYTE_LENGTH);

/** Whether `value` could be a token this Server minted. */
export function isHostToken(value: unknown): value is string {
  return isExactBase64Url(value, HOST_TOKEN_LENGTH);
}

/**
 * How many Hosts one account may have enrolled.
 *
 * Enrollment is credential-gated, so this is not a flood defense — it is the
 * bound on a file that is otherwise append-only and is re-read, re-parsed and
 * compared row by row on every host-gated request and every `/ws/host`
 * upgrade. Far above the machines a person owns; revocation (deleting a row by
 * hand) is what makes room.
 */
export const MAX_ENROLLED_HOSTS = 32;

/** Thrown by {@link HostStore.enroll} when {@link MAX_ENROLLED_HOSTS} is reached. */
export class HostLimitReachedError extends Error {
  constructor() {
    super(`this server already has ${MAX_ENROLLED_HOSTS} hosts enrolled`);
    this.name = 'HostLimitReachedError';
  }
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
    return (await this.listIfPresent()) ?? [];
  }

  /**
   * The enrolled set, or `null` when `hosts.json` is not there at all.
   *
   * **An absent file is not an empty one.** The relay's revocation sweep closes
   * the socket of every Host the answer omits, and a file is briefly absent
   * whenever it is replaced by rename rather than truncated in place — which is
   * how an editor saves. Reading that instant as "nobody is enrolled" would
   * drop every live session over it. Revoking is emptying the *array*, which
   * still answers an enrolled set of zero and still closes everything.
   */
  async listIfPresent(): Promise<StoredHost[] | null> {
    const rows = await this.readCached<unknown[]>();
    if (rows === null) return null;
    return Array.isArray(rows) ? rows.filter(isStoredHost) : [];
  }

  /**
   * Look up an enrolled host by its bearer token (the `/ws/host` credential).
   * The token is a secret, so it is compared with `secretEquals` rather than
   * `===`, whose early-exit leaks byte positions. Every host is checked without
   * an early break so the work does not depend on which entry matches.
   *
   * **A value of the wrong shape never reaches the file.** This runs
   * unauthenticated, on `requireHost` and on every `/ws/host` upgrade, and the
   * lookup costs a `readFile` + `JSON.parse` + two SHA-256 per row — so a probe
   * that cannot possibly be a token this Server minted must not buy any of it.
   * The same reasoning `isDeliveryId` applies at the push routes.
   */
  async findByToken(hostToken: string): Promise<StoredHost | undefined> {
    if (!isHostToken(hostToken)) return undefined;
    const hosts = await this.list();
    let match: StoredHost | undefined;
    for (const h of hosts) {
      if (secretEquals(h.hostToken, hostToken)) match = h;
    }
    return match;
  }

  /**
   * Whether `hostId` is still enrolled, read fresh off disk like
   * {@link findByToken}: deleting a row from `hosts.json` is the documented
   * revocation mechanism, so anything gating on a Host's continued existence —
   * redeeming a setup token it minted, accepting a push subscription for it —
   * must see that edit without a restart. A plain compare: a `hostId` is an
   * identifier the account can already list, not a secret.
   */
  async has(hostId: string): Promise<boolean> {
    return (await this.list()).some((h) => h.hostId === hostId);
  }

  /**
   * Enroll a new host: run `beforeEnroll` with whether this is the first Host
   * ever persisted, mint a random `hostId` ({@link E2E_ID_BYTE_LENGTH} bytes)
   * and `hostToken` (32 bytes), append them, and return the record. The
   * callback and write share the mutex, so two credential paths cannot both
   * authorize themselves as the first enrollment.
   *
   * File existence, not the current row count, is the durable boundary: hand-
   * editing every row away revokes those Hosts but does not reopen bootstrap.
   */
  enroll(
    beforeEnroll: (firstEnrollment: boolean) => void | Promise<void> = () => {},
  ): Promise<StoredHost> {
    return this.mutate(async () => {
      await beforeEnroll(!(await this.exists()));
      const hosts = await this.list();
      // After the credential gate, never before: a caller that has not proved
      // anything must not learn from the refusal whether the server is full.
      // Inside the mutex, so two concurrent enrollments cannot both pass it.
      if (hosts.length >= MAX_ENROLLED_HOSTS) throw new HostLimitReachedError();
      const host: StoredHost = {
        hostId: toBase64Url(randomBytes(E2E_ID_BYTE_LENGTH)),
        hostToken: toBase64Url(randomBytes(HOST_TOKEN_BYTE_LENGTH)),
        enrolledAt: this.now(),
      };
      hosts.push(host);
      await this.writeAtomic(hosts);
      return host;
    });
  }
}

// Minted and read at the one shape `isE2eId` accepts, since a `hostId` is the
// routing id every `e2e` envelope carries (docs/specs/server.md -> State files).
function isStoredHost(row: unknown): row is StoredHost {
  if (!row || typeof row !== 'object') return false;
  const candidate = row as Record<string, unknown>;
  return (
    isE2eId(candidate.hostId) &&
    typeof candidate.hostToken === 'string' &&
    typeof candidate.enrolledAt === 'number'
  );
}

/** A Web Push subscription as stored in `push-subscriptions.json`. */
export interface StoredPushSubscription {
  readonly hostId: string;
  /**
   * The bearer capability the Host minted for this Client at pairing;
   * possession of it is the whole authorization for this row
   * (`docs/specs/remote-security-model.md` → Host Authorization).
   */
  readonly deliveryId: string;
  readonly endpoint: string;
  readonly keys: PushSubscriptionPayload['keys'];
  /** Public VAPID key this endpoint was minted and registered under. */
  readonly vapidPublicKey: string;
  readonly subscribedAt: number;
}

export interface PushSubscriptionUpsertResult {
  readonly subscription: StoredPushSubscription;
  /**
   * Every Host whose surviving rows carry the presented endpoint under the same
   * VAPID key — the state the mutation left behind, not the delta. Computed
   * inside the mutex, so it is the whole truth at the instant it was committed,
   * which is what makes a lost response repairable by an idempotent retry.
   */
  readonly endpointHostIds: readonly string[];
}

/**
 * Push subscriptions (`push-subscriptions.json`), keyed on the PAIR
 * (`hostId`, `deliveryId`) — one Client subscribes once per Host it is paired
 * with, and a Host can only ever see or reach its own subscribers.
 *
 * Unlike its append-only siblings this store deletes: a push service reports a
 * dead subscription with 404/410, and re-subscribing after a browser rotates
 * the endpoint must replace the stale row rather than accumulate one per
 * rotation. Every path runs under the inherited mutex.
 *
 * No secret of ours lives here, but the endpoint plus its keys IS a bearer
 * capability to notify that phone, so the inherited `0o600` still matters.
 *
 * **Removing a `hosts.json` row cascades.** {@link list} drops every row whose
 * Host is no longer enrolled, so the read boundary that already handles
 * malformed rows handles orphans too, and the next mutation writes the pruned
 * set back. Deleting a Host by hand is the documented revocation mechanism, so
 * this is read fresh rather than cached — the same rule `HostStore.has`
 * follows. An *absent* `hosts.json` cascades to nothing: it is a file in
 * flight, not a revocation.
 */
export class PushSubscriptionStore extends JsonFileStore {
  /** Which Hosts are still enrolled. Required, so no caller can skip the join. */
  readonly #hosts: HostStore;

  constructor(stateDir: string, now: () => number, hosts: HostStore) {
    super(stateDir, 'push-subscriptions.json', now);
    this.#hosts = hosts;
  }

  /**
   * The rows this Server can act on.
   *
   * Malformed rows — and rows written before the end-to-end cutover, which
   * carry a `devicePublicKey` and no `deliveryId` — are dropped here rather
   * than defended against at each consumer: this file is hand-editable by
   * design, so a half-finished edit is a real case, and one guard at the read
   * boundary is what lets {@link StoredPushSubscription} be true for every
   * caller downstream. A dropped row reads as a missing registration, which
   * Pocket repairs by re-offering Enable, instead of as a live one that
   * cannot be delivered to.
   *
   * A row naming a Host that is no longer in `hosts.json` is dropped the same
   * way — silently, because a deleted Host is a deliberate revocation rather
   * than an edit to complain about, and the Client repairs it by re-registering
   * against a Host that exists.
   */
  async list(): Promise<StoredPushSubscription[]> {
    const rows = await this.read<unknown>([]);
    if (!Array.isArray(rows)) return [];
    const kept = rows.filter(isStoredPushSubscription);
    if (kept.length !== rows.length) warnOnceAboutDroppedRows();
    // An absent `hosts.json` is not an empty one — the same distinction the
    // relay's revocation sweep makes, and it matters more here because
    // `upsert` writes this answer back: joining against `[]` inside the rename
    // window of a hand edit would make the truncation durable.
    const hosts = await this.#hosts.listIfPresent();
    if (hosts === null) return kept;
    const enrolled = new Set(hosts.map((h) => h.hostId));
    return kept.filter((s) => enrolled.has(s.hostId));
  }

  async listForHost(hostId: string): Promise<StoredPushSubscription[]> {
    const all = await this.list();
    return all.filter((s) => s.hostId === hostId);
  }

  /**
   * The rows for delivery ids the caller PRESENTED. Never a listing: the caller
   * must already hold each id it asks about, so this is proof of possession
   * rather than an enumeration primitive.
   */
  async listForDeliveryIds(deliveryIds: readonly string[]): Promise<StoredPushSubscription[]> {
    const named = new Set(deliveryIds);
    return (await this.list()).filter((s) => named.has(s.deliveryId));
  }

  /**
   * Replace any existing subscription for this (host, delivery), or add one.
   *
   * A service-worker scope has one subscription shared by every Host, so an
   * address this delivery is moving off is dead under every Host at once and
   * goes in the same mutation. Two keys, because they reach different rows:
   *
   * * **Read the replaced addresses from every row carrying this
   *   `deliveryId`**, not only this Host's — one delivery id speaks for one
   *   worker scope.
   * * **Drop rows matched on the endpoint**, which is what reaches siblings
   *   holding delivery ids this request never names.
   *
   * The committed set is then capped ({@link capSubscriptions}), because a
   * self-chosen `deliveryId` makes every request a fresh row otherwise.
   *
   * `docs/specs/server.md` -> State files owns the rule and the gap it leaves.
   */
  upsert(
    record: Omit<StoredPushSubscription, 'subscribedAt'>,
  ): Promise<PushSubscriptionUpsertResult> {
    return this.mutate(async () => {
      const all = await this.list();
      const stored: StoredPushSubscription = { ...record, subscribedAt: this.now() };
      const replacedEndpoints = new Set(
        all
          .filter((s) => s.deliveryId === record.deliveryId && s.endpoint !== record.endpoint)
          .map((s) => s.endpoint),
      );
      const kept = capSubscriptions(
        all.filter(
          (s) =>
            !(s.hostId === record.hostId && s.deliveryId === record.deliveryId) &&
            !replacedEndpoints.has(s.endpoint),
        ),
        stored,
      );
      await this.writeAtomic(kept);
      const endpointHostIds = [
        ...new Set(
          kept
            .filter(
              (s) => s.endpoint === record.endpoint && s.vapidPublicKey === record.vapidPublicKey,
            )
            .map((s) => s.hostId),
        ),
      ];
      return { subscription: stored, endpointHostIds };
    });
  }

  /**
   * Forget every row carrying `deliveryId`, across Hosts. The Client holding
   * the capability is the normal lifecycle initiator; the route answers 204
   * whatever this returns, so the count is for tests and logs only.
   *
   * **Not scoped to an account**, and correct only because selfhost has exactly
   * one (`SELFHOST_ACCOUNT_ID`, which `docs/specs/security-remote.md` -> "Trust boundary" pins). A delivery id is
   * unguessable, so possession is the authorization — but multi-tenant would
   * still have to key the delete on the calling account, since a leaked id
   * would otherwise reach across tenants (`docs/specs/server.md` `## Future`).
   */
  removeDelivery(deliveryId: string): Promise<number> {
    return this.mutate(async () => {
      const all = await this.list();
      const kept = all.filter((s) => s.deliveryId !== deliveryId);
      if (kept.length === all.length) return 0;
      await this.writeAtomic(kept);
      return all.length - kept.length;
    });
  }

  /**
   * Drop subscriptions the push service reported as gone. Matched on endpoint
   * rather than delivery so a stale row cannot outlive its endpoint even if the
   * same phone has since re-subscribed with a new one.
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

/**
 * How many subscription rows one Host, and the whole file, may hold.
 *
 * `POST /api/push/subscribe` needs a session token and a `deliveryId` the
 * caller picks for itself — the Server cannot check one against a Host's ACL,
 * by design — so without a cap one signed-in caller appends a durable row per
 * request, and every push route thereafter re-reads and re-parses the file.
 * Every sibling transient store is capped (`MAX_PENDING_REAUTH_NONCES_PER_SESSION`,
 * `MAX_TOKENS_PER_HOST`); this is the durable one, so it matters more.
 *
 * Far above any real use: the per-Host cap is phones paired with one laptop,
 * the total is that across every laptop an account enrolled.
 */
export const MAX_PUSH_SUBSCRIPTIONS_PER_HOST = 32;
export const MAX_PUSH_SUBSCRIPTIONS_TOTAL = 256;

/**
 * Drop the oldest rows until both caps hold, never `keep` — the row this
 * mutation just committed, which the caller is about to be told about.
 *
 * Oldest `subscribedAt` first, and applied to every Host rather than only
 * `keep`'s, so a hand-edited file over the cap converges on the next write. An
 * evicted Client reads as un-registered and repairs by pressing Enable again,
 * which is the same recovery a dropped row already has
 * (`docs/specs/server.md` -> State files).
 */
function capSubscriptions(
  rows: readonly StoredPushSubscription[],
  keep: StoredPushSubscription,
): StoredPushSubscription[] {
  const all = [...rows, keep];
  if (all.length <= MAX_PUSH_SUBSCRIPTIONS_PER_HOST) return all;
  const perHost = new Map<string, number>();
  for (const row of all) perHost.set(row.hostId, (perHost.get(row.hostId) ?? 0) + 1);
  let total = all.length;
  const dropped = new Set<StoredPushSubscription>();
  for (const row of [...all].sort((a, b) => a.subscribedAt - b.subscribedAt)) {
    if (row === keep) continue;
    const forHost = perHost.get(row.hostId) ?? 0;
    if (total <= MAX_PUSH_SUBSCRIPTIONS_TOTAL && forHost <= MAX_PUSH_SUBSCRIPTIONS_PER_HOST) {
      continue;
    }
    dropped.add(row);
    perHost.set(row.hostId, forHost - 1);
    total -= 1;
  }
  return all.filter((row) => !dropped.has(row));
}

/**
 * Whether an on-disk row is a subscription this Server can use. Guards
 * {@link PushSubscriptionStore.list}, which is the only way rows enter the
 * process — so every field the type declares is present past that point.
 *
 * **`deliveryId` is the whole file version.** A row written before the
 * end-to-end cutover carries `devicePublicKey` instead and fails here, which is
 * the reset-and-re-register the scope requires; there is no migration reader.
 */
function isStoredPushSubscription(row: unknown): row is StoredPushSubscription {
  const s = row as Partial<StoredPushSubscription> | null;
  return (
    typeof s?.hostId === 'string' &&
    typeof s.deliveryId === 'string' &&
    typeof s.endpoint === 'string' &&
    typeof s.keys?.p256dh === 'string' &&
    typeof s.keys.auth === 'string' &&
    typeof s.vapidPublicKey === 'string' &&
    typeof s.subscribedAt === 'number'
  );
}

/**
 * Once per process, whatever dropped and however often it is read: the file is
 * read on every push route, and an operator needs the instruction once, not on
 * a loop under a phone that retries.
 */
let warnedAboutDroppedRows = false;

function warnOnceAboutDroppedRows(): void {
  if (warnedAboutDroppedRows) return;
  warnedAboutDroppedRows = true;
  console.warn(
    'push-subscriptions.json: dropped rows this server cannot use (pre-end-to-end or ' +
      'hand-edited). Re-register push on each phone to replace them.',
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

  async load(): Promise<StoredVapidKeys | null> {
    return (await this.loadRecord(VAPID_RECORD)) ?? null;
  }

  /** Return the persisted keypair, generating and saving one on first call. */
  loadOrCreate(generate: () => { publicKey: string; privateKey: string }): Promise<StoredVapidKeys> {
    return this.loadOrCreateRecord(VAPID_RECORD, generate);
  }
}

/**
 * The envelope only: two non-empty strings and a timestamp. Whether they are a
 * real P-256 keypair is `assertVapidKeyPair`'s question, asked once at the
 * entrypoint over the configured pair and this record alike — duplicating it
 * here would be a second definition of a valid key.
 */
function isStoredVapidKeys(value: unknown): value is StoredVapidKeys {
  if (!value || typeof value !== 'object') return false;
  const stored = value as Record<string, unknown>;
  return (
    typeof stored.publicKey === 'string' &&
    stored.publicKey.length > 0 &&
    typeof stored.privateKey === 'string' &&
    stored.privateKey.length > 0 &&
    Number.isFinite(stored.createdAt)
  );
}

const VAPID_RECORD: RecordShape<StoredVapidKeys> = {
  what: 'VAPID keypair',
  isValid: isStoredVapidKeys,
};
