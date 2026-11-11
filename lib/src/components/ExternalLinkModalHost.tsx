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
  if (!pending) return null;
  return pending.answer ? <PendingAnswerDialog key={pending.id} request={pending} /> : <PendingLinkDialog key={pending.id} request={pending} />;
}

/** A question another flow awaits: confirming only answers it. */
function PendingAnswerDialog({ request }: { request: PendingExternalLink }) {
  const confirm = () => {
    if (getExternalLinkConfirmationSnapshot() !== request) return;
    request.answer!(true);
    clearExternalLinkConfirmation();
  };
  return <ExternalLinkModal request={request} onCancel={clearExternalLinkConfirmation} onConfirm={confirm} />;
}

/** The request as this host can act on it: a host that cannot hand a link to
 *  another app shows that link blocked. */
function forHost(request: PendingExternalLink): PendingExternalLink {
  const d = request.decision;
  if (d.status !== 'openable' || !d.otherApp || getPlatform().opensOtherApps !== false) return request;
  // `tel:` is outside STANDARD_SCHEMES but inside standalone's shell-open scope.
  if (d.scheme === 'tel') return request;
  const reason = `This app cannot hand ${d.scheme}: links to another app.`;
  return { ...request, decision: { status: 'blocked', scheme: d.scheme, displayUri: d.displayUri, reason } };
}

function PendingLinkDialog({ request }: { request: PendingExternalLink }) {
  const [shown] = useState(() => forHost(request));
  const decision = shown.decision.status === 'openable' && shown.verdict !== 'deceptive' ? shown.decision : null;
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
      const opened = platform.openExternal(decision.uri);
      if (!opened) return clearExternalLinkConfirmation();
      // A host that answers keeps the dialog until the opener has, so a refusal shows here.
      setError(undefined);
      setBusy(true);
      void opened.then((refusal) => {
        if (refusal !== undefined) fail(refusal);
        else if (current()) clearExternalLinkConfirmation();
      });
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
      request={shown}
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
