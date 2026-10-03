import { useEffect, useState, useSyncExternalStore } from 'react';
import type { OpenHandler } from 'dor/commands/types';
import { ExternalLinkModal } from './ExternalLinkModal';
import {
  clearExternalLinkConfirmation,
  getExternalLinkConfirmationSnapshot,
  subscribeExternalLinkConfirmation,
  type PendingExternalLink,
} from '../lib/external-link-confirmation';
import { messageOf } from '../lib/errors';
import { getPlatform } from '../lib/platform';
import { fileLinkSource, fileLinkViewers, openFileLink } from './wall/confirmed-file-open';
import { useDialogKeyboardOwner } from './wall/wall-context';

export function ExternalLinkModalHost() {
  const pending = useSyncExternalStore(
    subscribeExternalLinkConfirmation,
    getExternalLinkConfirmationSnapshot,
  );
  useDialogKeyboardOwner(pending !== null);
  // Each click owns its lookup, selection and launch result, even for the same URL.
  return pending ? <PendingLinkDialog key={pending.id} request={pending} /> : null;
}

function PendingLinkDialog({ request }: { request: PendingExternalLink }) {
  const decision = request.decision.status === 'openable' && request.verdict !== 'deceptive' ? request.decision : null;
  // A `file:` link opens through `dor open`, never the system URL opener.
  const [source] = useState(() => decision?.scheme === 'file' ? fileLinkSource(request.source) : null);
  const fileSource = typeof source === 'object' ? source : null;
  const [handlers, setHandlers] = useState<OpenHandler[]>([]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState(typeof source === 'string' ? source : undefined);
  const [busy, setBusy] = useState(fileSource !== null);
  // A cancelled or replaced dialog ignores its outstanding replies and callbacks.
  const current = () => getExternalLinkConfirmationSnapshot() === request;
  const fail = (err: unknown) => {
    if (!current()) return;
    setBusy(false);
    setError(messageOf(err));
  };

  useEffect(() => {
    if (!decision || !fileSource) return;
    fileLinkViewers(decision.uri, fileSource).then(found => {
      if (!current()) return;
      setBusy(false);
      setHandlers(found);
    }, fail);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed per request
  }, []);

  const confirm = () => {
    if (!decision || !current() || busy) return;
    if (source === null) {
      const platform = getPlatform();
      if (!platform.openExternal) return setError('This host cannot open external links.');
      platform.openExternal(decision.uri);
      clearExternalLinkConfirmation();
      return;
    }
    if (typeof source === 'string') return setError(source);
    setError(undefined);
    setBusy(true);
    openFileLink(decision.uri, source, selected > 0 ? handlers[selected].tool : undefined).then(() => {
      if (current()) clearExternalLinkConfirmation();
    }, fail);
  };

  return (
    <ExternalLinkModal
      request={request}
      onCancel={clearExternalLinkConfirmation}
      onConfirm={confirm}
      handlers={handlers}
      selected={selected}
      onSelect={setSelected}
      busy={busy}
      error={error}
    />
  );
}
