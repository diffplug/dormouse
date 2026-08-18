import { useEffect, useSyncExternalStore } from 'react';
import { RemotePairingModal } from './RemotePairingModal';
import {
  getPairingApprovalSnapshot,
  subscribePairingApproval,
} from './pairing-approval';
import { installRemoteHostConsoleHook } from './activation';
import { hostStoreReady } from './store';

/**
 * Renders the head of the pairing-approval queue and, on mount, activates the
 * remote Host (from any persisted enrollment) and installs the console hook.
 * Wired next to the other modal hosts in the wall — additive, and inert unless
 * the user has enrolled a Host.
 */
export function RemotePairingModalHost({
  onKeyboardActiveChange,
}: {
  onKeyboardActiveChange?: (active: boolean) => void;
}) {
  const pending = useSyncExternalStore(subscribePairingApproval, getPairingApprovalSnapshot);
  const head = pending[0] ?? null;

  useEffect(() => {
    // The Host's enrollment and ACL may live outside the webview (VS Code), in
    // which case boot started an async read that must land before anything
    // reads those keys. First paint deliberately does not wait on it, so this
    // is where the ordering is enforced.
    let cancelled = false;
    void hostStoreReady().then(() => {
      if (!cancelled) installRemoteHostConsoleHook();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    onKeyboardActiveChange?.(head !== null);
    return () => onKeyboardActiveChange?.(false);
  }, [onKeyboardActiveChange, head]);

  if (!head) return null;

  return (
    <RemotePairingModal
      key={head.clientId}
      request={head.request}
      onApprove={() => head.approve()}
      onDeny={() => head.deny()}
    />
  );
}
