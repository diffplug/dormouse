/**
 * The pairing-approval queue: an external store (same shape as
 * `external-link-confirmation.ts`) that backs the React approval modal.
 *
 * The ceremony itself runs in the Host service, which is where the ACL is
 * (`lib/src/host/remote/service.ts`). This is the webview's mirror of its
 * queue: the service pushes a snapshot, `activation.ts` projects it here, and
 * `approve`/`deny` send a command back keyed by both `clientId` and the
 * immutable `pairingId` the modal displayed — so the closures that can
 * actually write the ACL never leave that process, and a stale modal cannot
 * answer a replacement request under the same client id.
 *
 * **The expected two-digit code is not here and cannot be.** The webview echoes
 * the digits a person typed; the Host compares them. A mirrored code would make
 * the confirmation a formality any webview-side attacker could satisfy
 * (`docs/specs/remote-security-model.md` → Pairing).
 */

export interface PendingPairing {
  /** Relay-assigned client socket id. */
  clientId: string;
  /** Immutable ceremony id; approve/deny must name this exact request. */
  pairingId: string;
  /** The Client's own name for itself, already bounded and stripped. */
  label: string;
  requestedAt: number;
  /** Confirm with the digits the phone is showing — the only path that writes the ACL. */
  approve: (code: string) => void;
  /** Deny locally — the ACL is untouched. */
  deny: () => void;
}

let queue: readonly PendingPairing[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function enqueuePairingApproval(pending: PendingPairing): void {
  // Coalesce by clientId: a re-sent pairing for the same client replaces the old.
  queue = [...queue.filter((p) => p.clientId !== pending.clientId), pending];
  emit();
}

export function resolvePairingApproval(clientId: string): void {
  const next = queue.filter((p) => p.clientId !== clientId);
  if (next.length === queue.length) return;
  queue = next;
  emit();
}

export function getPairingApprovalSnapshot(): readonly PendingPairing[] {
  return queue;
}

export function subscribePairingApproval(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
