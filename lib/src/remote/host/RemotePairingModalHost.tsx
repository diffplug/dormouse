import { useEffect, useSyncExternalStore } from 'react';
import { RemotePairingModal } from './RemotePairingModal';
import {
  getPairingApprovalSnapshot,
  subscribePairingApproval,
} from './pairing-approval';
import { installRemoteHostConsoleHook } from './activation';

/**
 * Renders the head of the pairing-approval queue and, on mount, wires this
 * webview to the Host service and installs the console hook. Wired next to the
 * other modal hosts in the wall — additive, and inert unless the user has
 * enrolled a Host.
 */
export function RemotePairingModalHost({
  onKeyboardActiveChange,
}: {
  onKeyboardActiveChange?: (active: boolean) => void;
}) {
  const pending = useSyncExternalStore(subscribePairingApproval, getPairingApprovalSnapshot);
  const head = pending[0] ?? null;

  // Idempotent, because StrictMode mounts this twice.
  useEffect(() => installRemoteHostConsoleHook(), []);

  useEffect(() => {
    onKeyboardActiveChange?.(head !== null);
    return () => onKeyboardActiveChange?.(false);
  }, [onKeyboardActiveChange, head]);

  if (!head) return null;

  return (
    <RemotePairingModal
      // Keyed on the immutable ceremony ticket: the Host coalesces a re-sent
      // pair under the same clientId by replacing its contents, so the same
      // client can name a different device — which has to remount rather than
      // re-render into whatever the previous one left.
      key={head.pairingId}
      request={head.request}
      onApprove={() => head.approve()}
      onDeny={() => head.deny()}
    />
  );
}
