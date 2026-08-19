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
import { ACL_KEY_PREFIX } from '../../lib/src/remote/host/acl';
import type { HostEnrollment } from '../../lib/src/remote/host/enrollment';
// Imported, not mirrored: a key that drifted between the two sides would strand
// an enrollment that is still on disk.
import { ENROLLMENT_KEY } from '../../lib/src/remote/host/store';

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

export class VsCodeHostStateStore implements HostStateStore {
  readonly #context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.#context = context;
  }

  async loadEnrollment(): Promise<HostEnrollment | null> {
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

  async saveEnrollment(enrollment: HostEnrollment): Promise<void> {
    await this.#context.secrets.store(ENROLLMENT_KEY, JSON.stringify(enrollment));
  }

  async clearEnrollment(): Promise<void> {
    await this.#context.secrets.delete(ENROLLMENT_KEY);
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
    // `HostAcl.fromRecords` rejects a mismatched hostId, so drop foreign rows
    // rather than fail the whole load over one.
    return parsed.filter(
      (record): record is HostAclRecord =>
        !!record && typeof record === 'object' && (record as HostAclRecord).hostId === hostId,
    );
  }

  async saveAcl(hostId: string, records: readonly HostAclRecord[]): Promise<void> {
    await this.#context.globalState.update(aclKey(hostId), JSON.stringify(records));
  }
}

/** Keyed per host so a re-enrollment cannot inherit a stale ACL. */
function aclKey(hostId: string): string {
  return `${ACL_KEY_PREFIX}${hostId}`;
}
