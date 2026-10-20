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
  /** What the dialog adds below the target. */
  note?: string;
  /** Set when another flow awaits the decision: the dialog only answers, and
   *  that flow opens. Called once; a cancel, replacement, or abort answers false. */
  answer?: (confirmed: boolean) => void;
}

let nextId = 0;
let pendingExternalLink: PendingExternalLink | null = null;
const listeners = new Set<() => void>();

export function requestExternalLinkConfirmation(uri: string, displayText: string = '', source?: ExternalLinkSource): void {
  replacePending({
    id: ++nextId,
    source,
    uri,
    displayText,
    verdict: classifyDisplayMatch(uri, displayText),
    decision: inspectExternalUri(uri),
  });
}

/** What the dialog shows for a document link to the local file `path`. */
export function documentLinkRequest(path: string): Omit<PendingExternalLink, 'id' | 'answer'> {
  return {
    uri: path,
    displayText: '',
    verdict: 'match',
    decision: { status: 'openable', rawUri: path, uri: path, scheme: 'file', displayUri: path, otherApp: false },
    note: 'A link in the document you are viewing opens this file, which runs its own scripts and can read files beside it. Open it only if you expected this file.',
  };
}

/**
 * Ask, in the same dialog, before a Tool's document link opens the local file
 * `path`, shown in full; resolves whether the user confirmed. The caller does
 * the open. Aborting `signal` withdraws the question.
 */
export function confirmDocumentLinkOpen(path: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve(false);
    let answered = false;
    const request: PendingExternalLink = {
      id: ++nextId,
      ...documentLinkRequest(path),
      answer: confirmed => {
        if (answered) return;
        answered = true;
        signal?.removeEventListener('abort', withdraw);
        resolve(confirmed);
      },
    };
    const withdraw = () => {
      if (pendingExternalLink === request) clearExternalLinkConfirmation();
      else request.answer!(false);
    };
    signal?.addEventListener('abort', withdraw, { once: true });
    replacePending(request);
  });
}

export function clearExternalLinkConfirmation(): void {
  if (!pendingExternalLink) return;
  replacePending(null);
}

function replacePending(next: PendingExternalLink | null): void {
  const previous = pendingExternalLink;
  pendingExternalLink = next;
  previous?.answer?.(false);
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
