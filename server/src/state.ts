/** JSON-file state stores; `docs/specs/server.md` → "State files" owns their schemas and invariants. */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { E2E_ID_BYTE_LENGTH, SELFHOST_ACCOUNT_ID, isE2eId, toBase64Url } from 'server-lib-common';
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

  /**
   * Read and parse the file, or `null` if it is not there.
   *
   * Separate from {@link read} because one caller needs the distinction that
   * one erases: a file that is absent for an instant — a rename in flight —
   * is not the same fact as a file that lists nobody.
   */
  protected async readIfPresent<T>(): Promise<T | null> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return JSON.parse(raw) as T;
  }

  /** Read and parse the file, or `fallback` if it does not exist yet. */
  protected async read<T>(fallback: T): Promise<T> {
    return (await this.readIfPresent<T>()) ?? fallback;
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
    const rows = await this.readIfPresent<unknown[]>();
    if (rows === null) return null;
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
      const host: StoredHost = {
        hostId: toBase64Url(randomBytes(E2E_ID_BYTE_LENGTH)),
        hostToken: toBase64Url(randomBytes(32)),
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
      const kept = all.filter(
        (s) =>
          !(s.hostId === record.hostId && s.deliveryId === record.deliveryId) &&
          !replacedEndpoints.has(s.endpoint),
      );
      kept.push(stored);
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
   * one (`SELFHOST_ACCOUNT_ID`, which `SECURITY.md` pins). A delivery id is
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
