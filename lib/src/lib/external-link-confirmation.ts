import {
  classifyDisplayMatch,
  inspectExternalUri,
  type DisplayMatchVerdict,
  type ExternalUriDecision,
} from './external-links';

export interface ExternalLinkSource {
  surfaceId: string;
  cwd?: string;
}

export interface PendingExternalLink {
  id: number;
  source?: ExternalLinkSource;
  uri: string;
  displayText: string;
  verdict: DisplayMatchVerdict;
  decision: ExternalUriDecision;
}

let nextId = 0;
let pendingExternalLink: PendingExternalLink | null = null;
const listeners = new Set<() => void>();

export function requestExternalLinkConfirmation(uri: string, displayText: string = '', source?: ExternalLinkSource): void {
  pendingExternalLink = {
    id: ++nextId,
    source,
    uri,
    displayText,
    verdict: classifyDisplayMatch(uri, displayText),
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
