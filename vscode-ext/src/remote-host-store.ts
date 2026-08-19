/**
 * Where the VS Code Host keeps the two things it must survive a restart with:
 * the enrollment and the ACL (`lib/src/host/remote/host-state-store.ts`).
 *
 * Split by sensitivity. The enrollment blob carries `hostToken` — a bearer
 * credential that grants the `/ws/host` socket — so it goes to `SecretStorage`
 * (OS keychain); the ACL is public-key records with no secret in them, so it
 * goes to `globalState`. Both are global rather than workspace-scoped, because
 * a Host identity belongs to the machine, not to a folder.
 *
 * The keys are the ones the webview-resident Host wrote through this module
 * before the service existed, and the values are the same JSON strings, so an
 * already-enrolled installation is picked up with no migration step.
 */

import type * as vscode from 'vscode';

import type { HostAclRecord, HostStateStore } from '../../lib/src/host/remote/host-state-store';
import { ACL_KEY_PREFIX, filterAclRecords } from '../../lib/src/remote/host/acl';
import { isEnrollment, type HostEnrollment } from '../../lib/src/remote/host/enrollment';
// Imported, not mirrored: a key that drifted between the two sides would strand
// an enrollment that is still on disk.
import { ENROLLMENT_KEY } from '../../lib/src/remote/host/store';

export class VsCodeHostStateStore implements HostStateStore {
  readonly #context: vscode.ExtensionContext;
  #enrollment: Promise<HostEnrollment | null> | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.#context = context;
  }

  async loadEnrollment(): Promise<HostEnrollment | null> {
    // Read once and keep it, like `FileHostStateStore`: `SecretStorage` is a
    // keychain round trip, this extension host is the only writer of the key,
    // and the activation probe and the service both want the same answer.
    this.#enrollment ??= this.#readEnrollment();
    return this.#enrollment;
  }

  async saveEnrollment(enrollment: HostEnrollment): Promise<void> {
    await this.#context.secrets.store(ENROLLMENT_KEY, JSON.stringify(enrollment));
    this.#enrollment = Promise.resolve(enrollment);
  }

  async clearEnrollment(): Promise<void> {
    await this.#context.secrets.delete(ENROLLMENT_KEY);
    this.#enrollment = Promise.resolve(null);
  }

  async #readEnrollment(): Promise<HostEnrollment | null> {
    const raw = await this.#context.secrets.get(ENROLLMENT_KEY);
    if (raw === undefined) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isEnrollment(parsed) ? parsed : null;
    } catch {
      // A keychain entry we cannot parse is the same as none: the Host idles
      // rather than connecting with half an enrollment.
      return null;
    }
  }

  async loadAcl(hostId: string): Promise<HostAclRecord[]> {
    const raw = this.#context.globalState.get<string>(aclKey(hostId));
    if (typeof raw !== 'string') return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return filterAclRecords(hostId, parsed);
  }

  async saveAcl(hostId: string, records: readonly HostAclRecord[]): Promise<void> {
    await this.#context.globalState.update(aclKey(hostId), JSON.stringify(records));
  }
}

/** Keyed per host so a re-enrollment cannot inherit a stale ACL. */
function aclKey(hostId: string): string {
  return `${ACL_KEY_PREFIX}${hostId}`;
}
