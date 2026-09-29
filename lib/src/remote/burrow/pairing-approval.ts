/**
 * The pairing-approval queue: an external store (same shape as
 * `external-link-confirmation.ts`) that backs the React approval modal.
 *
 * The ceremony itself runs in the Burrow service, which is where the ACL is
 * (`lib/src/host/remote/service.ts`). This is the webview's mirror of its
 * queue: the service pushes a snapshot, `activation.ts` projects it here, and
 * `approve`/`deny` send a command back keyed by both `clientId` and the
 * immutable `pairingId` the modal displayed — so the closures that can
 * actually write the ACL never leave that process, and a stale modal cannot
 * answer a replacement request under the same client id.
 *
 * **The expected two-digit code is not here and cannot be.** The webview echoes
 * the digits a person typed; the Burrow compares them. A mirrored code would make
 * the confirmation a formality any webview-side attacker could satisfy
 * (`docs/specs/remote-security-model.md` → Pairing).
 *
 * A one-time connection's request rides the same queue under `kind:
 * 'one-time'`, so **every request is named by `(kind, clientId)`**: a one-time
 * request has no Relay and so no client id (`''`), and must never be taken for,
 * or coalesce with, a pairing.
 */

import type { ApprovalKind } from '../../host/remote/service-protocol';

export interface PendingPairing {
  /** Which ceremony: the modal's copy, and where its answer goes. */
  kind: ApprovalKind;
  /** Relay-assigned client socket id; `''` for a one-time request. */
  clientId: string;
  /** Immutable ceremony id; approve/deny must name this exact request. */
  pairingId: string;
  /** The Client's own name for itself, already bounded and stripped. */
  label: string;
  requestedAt: number;
  /**
   * Confirm with the digits the phone is showing — for a pairing, the only
   * path that writes the ACL; for a one-time request, the one attempt.
   */
  approve: (code: string) => void | Promise<void>;
  /** Deny locally — the ACL is untouched. */
  deny: () => void;
}

/** The one identity a request has in this queue and in the service's. */
export function sameRequest(
  a: Pick<PendingPairing, 'kind' | 'clientId'>,
  b: Pick<PendingPairing, 'kind' | 'clientId'>,
): boolean {
  return a.kind === b.kind && a.clientId === b.clientId;
}

let queue: readonly PendingPairing[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function enqueuePairingApproval(pending: PendingPairing): void {
  // Coalesce by request: a re-sent pairing for the same client replaces the old.
  queue = [...queue.filter((p) => !sameRequest(p, pending)), pending];
  emit();
}

export function resolvePairingApproval(request: Pick<PendingPairing, 'kind' | 'clientId'>): void {
  const next = queue.filter((p) => !sameRequest(p, request));
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
