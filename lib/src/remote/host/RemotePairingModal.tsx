import { useRef } from 'react';
import { ModalFrame, ModalReviewBlock, modalActionButton } from '../../components/design';
import type { PairingRequest } from 'server-lib-common';

/**
 * The Host's local pairing-approval modal (server.md → "Pairing approval
 * modal"; same pattern as KillConfirm). Approving here is the only path that
 * writes the ACL, so the dialog shows exactly who is asking: the requested
 * label, the account, and a short fingerprint of the requesting browser's
 * device key.
 */
export function RemotePairingModal({
  request,
  onApprove,
  onDeny,
}: {
  request: PairingRequest;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const denyButtonRef = useRef<HTMLButtonElement>(null);
  const fingerprint = request.devicePublicKey.slice(0, 8);

  return (
    <ModalFrame
      titleId="remote-pairing-title"
      padding="spacious"
      align="start"
      initialFocusRef={denyButtonRef}
      onEscape={onDeny}
    >
      <h2 id="remote-pairing-title" className="mb-1 text-base font-bold text-foreground">
        Pair a new device
      </h2>
      <p className="mb-3 text-sm text-muted">
        A device is requesting remote access to this terminal.
      </p>

      <ModalReviewBlock density="default" className="mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <span className="text-muted">Device</span>
        <span className="break-words text-foreground">{request.requestedLabel || '(unnamed)'}</span>
        <span className="text-muted">Account</span>
        <span className="break-words text-foreground">{request.accountId}</span>
        <span className="text-muted">Key</span>
        <span className="text-foreground">{fingerprint}…</span>
      </ModalReviewBlock>

      <div className="flex justify-end gap-2">
        <button
          ref={denyButtonRef}
          type="button"
          onClick={onDeny}
          className={modalActionButton({ tone: 'secondary' })}
        >
          Deny
        </button>
        <button
          type="button"
          onClick={onApprove}
          className={modalActionButton({ tone: 'primary' })}
        >
          Approve
        </button>
      </div>
    </ModalFrame>
  );
}
