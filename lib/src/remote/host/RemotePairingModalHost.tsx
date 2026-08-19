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
      key={head.clientId}
      request={head.request}
      onApprove={() => head.approve()}
      onDeny={() => head.deny()}
    />
  );
}
