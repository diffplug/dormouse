/**
 * Where the VS Code Burrow keeps the two things it must survive a restart with:
 * the enrollment and the ACL (`lib/src/host/remote/burrow-state-store.ts`), and
 * the network policy beside them.
 *
 * Split by sensitivity. The enrollment blob carries `burrowToken` — a bearer
 * credential that grants the `/ws/burrow` socket — so it goes to `SecretStorage`
 * (OS keychain); the ACL is public-key records with no secret in them, so it
 * goes to `globalState`. Both are global rather than workspace-scoped, because
 * a Burrow identity belongs to the machine, not to a folder.
 *
 * Both keys are this store's own. Records written before the end-to-end
 * cutover are dropped on read by `isBurrowAclRecord`, which is the whole of the
 * Burrow-state version: the machine shows the enrollment form again and every
 * phone pairs once more.
 *
 * One more `SecretStorage` entry rides here, and it is not a credential: the
 * one-time serving marker ({@link ONE_TIME_SERVING_KEY}), which lives in
 * `SecretStorage` only because that is the store whose changes every window of
 * the extension hears.
 */

import type * as vscode from 'vscode';

import type { BurrowAclRecord, BurrowStateStore } from '../../lib/src/host/remote/burrow-state-store';
import { createSerialQueue } from '../../lib/src/host/remote/serial-queue';
import { filterAclRecords } from '../../lib/src/remote/burrow/acl';
import { isEnrollment, type BurrowEnrollment } from '../../lib/src/remote/burrow/enrollment';
import { storedNetworkPolicy, type NetworkPolicy } from '../../lib/src/remote/network-policy';
// Imported, not mirrored: a key that drifted between the two sides would strand
// an enrollment that is still on disk.
import { ENROLLMENT_KEY } from '../../lib/src/remote/burrow/store';

/**
 * Present while the broker window's one-time connection is serving
 * (`docs/specs/vscode.md` → "Burrow: a service in the extension host"), so a
 * window with no enrollment still joins the peer net and its terminals reach
 * the phone. Its value means nothing; the broker writes it on the flip and
 * deletes it when serving stops and whenever a service starts.
 */
export const ONE_TIME_SERVING_KEY = 'dormouse.burrow.one-time-serving';

export class VsCodeBurrowStateStore implements BurrowStateStore {
  /** Writes here survive a restart (`BurrowStateStore.persistent`). */
  readonly persistent = true;

  readonly #context: vscode.ExtensionContext;
  #enrollment: Promise<BurrowEnrollment | null> | null = null;
  #watch: vscode.Disposable | undefined;
  /**
   * Preserve call order across asynchronous keychain/Memento writes. The Burrow
   * updates its ACL from snapshots, so letting two approvals write together
   * could allow the older snapshot to finish last and silently de-pair the
   * newer Client after a restart.
   */
  readonly #mutate = createSerialQueue();

  /**
   * @param onServingChanged Some window of this extension wrote or cleared the
   * enrollment or the one-time serving marker. Fires after the enrollment memo
   * is dropped, so a reader called from it sees the new value.
   */
  constructor(context: vscode.ExtensionContext, onServingChanged?: () => void) {
    this.#context = context;
    // Cross-window invalidation. `SecretStorage` is shared by every window of
    // an extension and `onDidChange` fires in all of them, so without this a
    // window that read the enrollment once could keep serving a Burrow another
    // window cleared — or miss one another window created.
    this.#watch = context.secrets.onDidChange?.((event) => {
      if (event.key === ENROLLMENT_KEY) this.#enrollment = null;
      else if (event.key !== ONE_TIME_SERVING_KEY) return;
      onServingChanged?.();
    });
  }

  /** Stop listening; the store is otherwise stateless and can be dropped. */
  dispose(): void {
    this.#watch?.dispose();
    this.#watch = undefined;
  }

  async loadEnrollment(): Promise<BurrowEnrollment | null> {
    // Read once and keep it, like `FileBurrowStateStore`: `SecretStorage` is a
    // keychain round trip, and the activation probe and the service both want
    // the same answer. The memo is only safe because a write from any window
    // invalidates it — see the constructor.
    //
    // A read that *failed* says nothing about what the keychain holds, so it is
    // forgotten rather than memoized (the same fail-closed guard as
    // `FileBurrowStateStore#read`). A locked or keyring-less keychain rejects
    // here, and a memoized rejection would leave an enrolled window silently
    // Burrow-less for its whole life — `onDidChange` only fires on a write, so
    // nothing else would ever retry the read.
    this.#enrollment ??= this.#readEnrollment().catch((error: unknown) => {
      this.#enrollment = null;
      throw error;
    });
    return this.#enrollment;
  }

  saveEnrollment(enrollment: BurrowEnrollment): Promise<void> {
    return this.#mutate(async () => {
      await this.#context.secrets.store(ENROLLMENT_KEY, JSON.stringify(enrollment));
      this.#enrollment = Promise.resolve(enrollment);
    });
  }

  clearEnrollment(): Promise<void> {
    return this.#mutate(async () => {
      await this.#context.secrets.delete(ENROLLMENT_KEY);
      this.#enrollment = Promise.resolve(null);
    });
  }

  async #readEnrollment(): Promise<BurrowEnrollment | null> {
    const raw = await this.#context.secrets.get(ENROLLMENT_KEY);
    if (raw === undefined) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isEnrollment(parsed) ? parsed : null;
    } catch {
      // A keychain entry we cannot parse is the same as none: the Burrow idles
      // rather than connecting with half an enrollment.
      return null;
    }
  }

  /** Whether some window's one-time connection is serving; never memoized, since it flips. */
  async loadOneTimeServing(): Promise<boolean> {
    return (await this.#context.secrets.get(ONE_TIME_SERVING_KEY)) !== undefined;
  }

  /**
   * Set or clear the marker, in call order with every other write here. A
   * clear reads first, so clearing an absent marker — every service start —
   * announces nothing to the other windows.
   */
  saveOneTimeServing(serving: boolean): Promise<void> {
    return this.#mutate(async () => {
      if (serving) {
        await this.#context.secrets.store(ONE_TIME_SERVING_KEY, '1');
        return;
      }
      if ((await this.#context.secrets.get(ONE_TIME_SERVING_KEY)) === undefined) return;
      await this.#context.secrets.delete(ONE_TIME_SERVING_KEY);
    });
  }

  async loadAcl(burrowId: string): Promise<BurrowAclRecord[]> {
    const raw = this.#context.globalState.get<string>(aclKey(burrowId));
    if (typeof raw !== 'string') return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return filterAclRecords(burrowId, parsed);
  }

  saveAcl(burrowId: string, records: readonly BurrowAclRecord[]): Promise<void> {
    return this.#mutate(() =>
      this.#context.globalState.update(aclKey(burrowId), JSON.stringify(records)),
    );
  }

  /** Not memoized, like the ACL: `globalState` is in-process, and shared by every window. */
  async loadNetworkPolicy(): Promise<NetworkPolicy | null> {
    return storedNetworkPolicy(this.#context.globalState.get<unknown>(NETWORK_POLICY_KEY));
  }

  saveNetworkPolicy(policy: NetworkPolicy): Promise<void> {
    return this.#mutate(() => this.#context.globalState.update(NETWORK_POLICY_KEY, policy));
  }
}

/**
 * The network policy's `globalState` key (`docs/specs/remote-network.md` ->
 * "Policy"): no secret in it, so not the keychain, and machine-wide like the
 * enrollment.
 */
export const NETWORK_POLICY_KEY = 'dormouse.burrow.network-policy';

/**
 * This store's own `globalState` key prefix. It lives here rather than in `lib`
 * because nothing else writes these entries any more: the webview-resident Burrow
 * that once shared the name is gone.
 */
const ACL_KEY_PREFIX = 'dormouse.burrow.acl.';

/** Keyed per burrow so a re-enrollment cannot inherit a stale ACL. */
function aclKey(burrowId: string): string {
  return `${ACL_KEY_PREFIX}${burrowId}`;
}
