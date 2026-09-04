import { useEffect, useSyncExternalStore } from 'react';
import { RemotePairingModal } from './RemotePairingModal';
import {
  getPairingApprovalSnapshot,
  subscribePairingApproval,
} from './pairing-approval';
import { installBurrowConsoleHook } from './activation';

/**
 * Renders the head of the pairing-approval queue and, on mount, wires this
 * webview to the Burrow service and installs the console hook. Wired next to the
 * other modal burrows in the wall — additive, and inert unless the user has
 * enrolled a Burrow.
 */
export function RemotePairingModalHost({
  onKeyboardActiveChange,
}: {
  onKeyboardActiveChange?: (active: boolean) => void;
}) {
  const pending = useSyncExternalStore(subscribePairingApproval, getPairingApprovalSnapshot);
  const head = pending[0] ?? null;

  // Idempotent, because StrictMode mounts this twice.
  useEffect(() => installBurrowConsoleHook(), []);

  useEffect(() => {
    onKeyboardActiveChange?.(head !== null);
    return () => onKeyboardActiveChange?.(false);
  }, [onKeyboardActiveChange, head]);

  if (!head) return null;

  return (
    <RemotePairingModal
      // Keyed on the immutable ceremony id: a re-sent pairing under the same
      // clientId replaces its predecessor, so the same client can name a
      // different device — which has to remount rather than re-render into
      // whatever the previous one left, typed digits included.
      key={head.pairingId}
      label={head.label}
      onApprove={(code) => head.approve(code)}
      onDeny={() => head.deny()}
    />
  );
}
