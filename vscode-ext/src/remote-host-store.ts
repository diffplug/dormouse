/**
 * Extension-host storage for the webview's remote-Host keys
 * (docs/specs/vscode.md → "Host store").
 *
 * The webview cannot keep these in `localStorage`: VS Code's persistence story
 * is `setState`/`workspaceState`/`globalState`, and the enrollment blob carries
 * `hostToken` — a bearer credential that grants the `/ws/host` socket — so it
 * belongs in `SecretStorage` (OS keychain), not in a webview-origin store.
 *
 * Split by sensitivity: the enrollment blob goes to `SecretStorage`, the ACL
 * (public key records, no secret) to `globalState`. Both are global rather than
 * workspace-scoped, because a Host identity belongs to the machine, not to a
 * folder.
 *
 * Everything here is prefix-gated. The webview names keys, so an untrusted
 * message must never be able to read or write extension state outside the
 * Host's own namespace.
 */

import type * as vscode from 'vscode';

/** Mirrors `lib/src/remote/host/store.ts`; both sides gate on it. */
export const REMOTE_HOST_STORE_PREFIX = 'dormouse.remote-host.';

/** Mirrors `lib/src/remote/host/enrollment.ts`; the one secret-backed key. */
const ENROLLMENT_KEY = 'dormouse.remote-host.enrollment';

/**
 * Enough for an enrollment blob or a sizable ACL, small enough that a
 * compromised webview cannot bloat the keychain or globalState.
 */
const MAX_VALUE_BYTES = 64 * 1024;

let context: vscode.ExtensionContext | null = null;

export function initRemoteHostStore(ctx: vscode.ExtensionContext): void {
  context = ctx;
}

function allowed(key: string): boolean {
  return key.startsWith(REMOTE_HOST_STORE_PREFIX);
}

/**
 * Every stored value whose key starts with `prefix`. Returns `{}` for any
 * prefix outside the Host namespace, so a webview asking for something else
 * learns nothing.
 */
export async function readStore(prefix: string): Promise<Record<string, string>> {
  if (!context || !allowed(prefix)) return {};
  const entries: Record<string, string> = {};

  const enrollment = await context.secrets.get(ENROLLMENT_KEY);
  if (enrollment !== undefined && ENROLLMENT_KEY.startsWith(prefix)) {
    entries[ENROLLMENT_KEY] = enrollment;
  }

  for (const key of context.globalState.keys()) {
    if (!allowed(key) || !key.startsWith(prefix) || key === ENROLLMENT_KEY) continue;
    const value = context.globalState.get<string>(key);
    if (typeof value === 'string') entries[key] = value;
  }

  return entries;
}

/** Write (or, with `null`, delete) one Host-namespace key. */
export async function writeStore(key: string, value: string | null): Promise<void> {
  if (!context || !allowed(key)) return;
  if (value !== null && Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) return;

  if (key === ENROLLMENT_KEY) {
    if (value === null) await context.secrets.delete(key);
    else await context.secrets.store(key, value);
    return;
  }

  await context.globalState.update(key, value === null ? undefined : value);
}
