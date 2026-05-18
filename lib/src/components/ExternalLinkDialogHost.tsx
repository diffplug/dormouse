import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { ExternalLinkDialog } from './ExternalLinkDialog';
import {
  clearExternalLinkConfirmation,
  getExternalLinkConfirmationSnapshot,
  subscribeExternalLinkConfirmation,
} from '../lib/external-link-confirmation';
import { getPlatform } from '../lib/platform';

export function ExternalLinkDialogHost({
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
    <ExternalLinkDialog
      request={pending}
      onCancel={close}
      onConfirm={confirm}
    />
  );
}
