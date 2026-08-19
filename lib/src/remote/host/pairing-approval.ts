/**
 * The pairing-approval queue: an external store (same shape as
 * `external-link-confirmation.ts`) that backs the React approval modal.
 *
 * The ceremony itself runs in the Host service, which is where the ACL is
 * (`lib/src/host/remote/service.ts`). This is the webview's mirror of its
 * queue: the service pushes a snapshot, `activation.ts` projects it here, and
 * `approve`/`deny` send a command back keyed by `clientId` — so the closures
 * that can actually write the ACL never leave that process.
 */

import type { PairingRequest } from 'server-lib-common';

export interface PendingPairing {
  /** Server-assigned client socket id; the approve/deny reply is keyed by it. */
  clientId: string;
  request: PairingRequest;
  requestedAt: number;
  /** Approve locally on the Host — writes the ACL and replies `pair-result`. */
  approve: (label?: string) => void;
  /** Deny locally — the ACL is untouched. */
  deny: (error?: string) => void;
}

let queue: readonly PendingPairing[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function enqueuePairingApproval(pending: PendingPairing): void {
  // Coalesce by clientId: a re-sent pair for the same client replaces the old.
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
