import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { ExternalLinkModal } from './ExternalLinkModal';
import {
  clearExternalLinkConfirmation,
  getExternalLinkConfirmationSnapshot,
  subscribeExternalLinkConfirmation,
} from '../lib/external-link-confirmation';
import { getPlatform } from '../lib/platform';

export function ExternalLinkModalHost({
  onKeyboardActiveChange,
}: {
  onKeyboardActiveChange: (active: boolean) => void;
}) {
  const pending = useSyncExternalStore(
    subscribeExternalLinkConfirmation,
    getExternalLinkConfirmationSnapshot,
  );

  useEffect(() => {
    onKeyboardActiveChange(pending !== null);
    return () => onKeyboardActiveChange(false);
  }, [onKeyboardActiveChange, pending]);

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
