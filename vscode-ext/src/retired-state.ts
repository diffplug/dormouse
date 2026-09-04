/**
 * One sweep of what the Host→Burrow rename left behind, run at activation
 * (`extension.ts`). Every name here held a live credential under a key no
 * shipped build reads any more; `docs/specs/security-remote.md` → "Credentials
 * at rest" states the rule.
 *
 * Deleted unread, never migrated. `SecretStorage` cannot be enumerated, so a
 * key nothing removes *by name* outlives every build that knew it existed —
 * which is the whole reason this exists rather than nothing.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type * as vscode from 'vscode';

import { log } from './log';

/** The retired `SecretStorage` key: an enrollment carrying a `burrowToken`. */
const RETIRED_ENROLLMENT_KEY = 'dormouse.remote-host.enrollment';
/** The retired `globalState` prefix: one ACL entry per burrowId. */
const RETIRED_ACL_KEY_PREFIX = 'dormouse.remote-host.acl.';
/** The retired peer-link token file, under `globalStorageUri`. */
const RETIRED_TOKEN_FILE = 'remote-host.peer-token';

/**
 * Set once the sweep has run. Without it the keychain delete would run on every
 * window of every launch forever, in front of the `secrets.get` that decides
 * whether this window brings up the Burrow at all.
 */
const SWEPT_KEY = 'dormouse.burrow.retiredStateForgotten';

/**
 * Drop every pre-rename credential this extension can reach. Idempotent, and a
 * no-op after its first success.
 *
 * **Never fatal**: what it deletes is unreachable either way, so a locked
 * keyring or a read-only directory is logged and stepped over — and the flag
 * stays unset, so the next launch tries again.
 */
export async function forgetRetiredState(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(SWEPT_KEY)) return;
  try {
    // Independent stores with no ordering between them, and the keychain call
    // is the slow one — it must not hold up the two local deletions.
    await Promise.all([
      context.secrets.delete(RETIRED_ENROLLMENT_KEY),
      rm(join(context.globalStorageUri.fsPath, RETIRED_TOKEN_FILE), { force: true }),
      ...context.globalState
        .keys()
        .filter((key) => key.startsWith(RETIRED_ACL_KEY_PREFIX))
        .map((key) => context.globalState.update(key, undefined)),
    ]);
    await context.globalState.update(SWEPT_KEY, true);
  } catch (error) {
    log.error(`[burrow] could not drop the retired remote-host state: ${String(error)}`);
  }
}
