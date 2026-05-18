import { inspectExternalUri, type ExternalUriDecision } from './external-links';

export interface PendingExternalLink {
  uri: string;
  decision: ExternalUriDecision;
}

let pendingExternalLink: PendingExternalLink | null = null;
const listeners = new Set<() => void>();

export function requestExternalLinkConfirmation(uri: string): void {
  pendingExternalLink = {
    uri,
    decision: inspectExternalUri(uri),
  };
  emitExternalLinkConfirmationChange();
}

export function clearExternalLinkConfirmation(): void {
  if (!pendingExternalLink) return;
  pendingExternalLink = null;
  emitExternalLinkConfirmationChange();
}

export function getExternalLinkConfirmationSnapshot(): PendingExternalLink | null {
  return pendingExternalLink;
}

export function subscribeExternalLinkConfirmation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitExternalLinkConfirmationChange(): void {
  for (const listener of listeners) listener();
}
