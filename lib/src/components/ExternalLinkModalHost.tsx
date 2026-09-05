import { useCallback, useSyncExternalStore } from 'react';
import { ExternalLinkModal } from './ExternalLinkModal';
import {
  clearExternalLinkConfirmation,
  getExternalLinkConfirmationSnapshot,
  subscribeExternalLinkConfirmation,
} from '../lib/external-link-confirmation';
import { getPlatform } from '../lib/platform';
import { useDialogKeyboardOwner } from './wall/wall-context';

export function ExternalLinkModalHost() {
  const pending = useSyncExternalStore(
    subscribeExternalLinkConfirmation,
    getExternalLinkConfirmationSnapshot,
  );

  useDialogKeyboardOwner(pending !== null);

  const close = useCallback(() => {
    clearExternalLinkConfirmation();
  }, []);

  const confirm = useCallback(() => {
    const current = getExternalLinkConfirmationSnapshot();
    if (current?.decision.status === 'openable') {
      getPlatform().openExternal?.(current.decision.uri);
    }
    clearExternalLinkConfirmation();
  }, []);

  if (!pending) return null;

  return (
    <ExternalLinkModal
      request={{
        uri: pending.uri,
        displayText: pending.displayText,
        verdict: pending.verdict,
        decision: pending.decision,
      }}
      onCancel={close}
      onConfirm={confirm}
    />
  );
}
