import { useRef } from 'react';
import { ModalFrame, ModalReviewBlock, modalActionButton } from '../../components/design';
import { pairingFingerprint } from 'server-lib-common';
import type { MirroredPairingRequest } from './pairing-approval';

/**
 * The Host's local pairing-approval modal (server.md → "Pairing approval
 * modal"; same pattern as KillConfirm). Approving here is the only path that
 * writes the ACL, so the dialog shows exactly who is asking: the requested
 * label, the account, and a short fingerprint of the requesting browser's
 * device key.
 *
 * Two variants, and the difference is what the human is being asked to do.
 * Unverified, the fingerprint is the control: the ceremony verifies no
 * assertion, so a person comparing eight characters against the phone is what
 * stands between the ACL and a substituted request. Verified, that comparison
 * has already happened by other means — the phone returned a proof under the
 * nonce on this machine's own screen, computed over this very device key — so
 * the dialog says so and asks for one confirm
 * (`docs/specs/remote-security-model.md` → Pairing Ceremony).
 */
export function RemotePairingModal({
  request,
  verified = false,
  onApprove,
  onDeny,
}: {
  request: MirroredPairingRequest;
  /**
   * The Client's setup proof matched a nonce this machine minted and displayed;
   * see the module note. The proof itself is not here and cannot be — the type
   * of `request` is what says so.
   */
  verified?: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const denyButtonRef = useRef<HTMLButtonElement>(null);
  const fingerprint = pairingFingerprint(request.devicePublicKey);

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
      {verified ? (
        /* Displaying the code on this screen was the local-presence act, and
           only a phone that scanned it can be holding the token — so the ask is
           "you just did this", not "check this stranger". */
        <p className="mb-3 text-sm leading-relaxed text-muted">
          This device scanned the setup code shown on this machine, so it is the phone you just set
          up. Approve it to let it reach this machine’s terminals.
        </p>
      ) : (
        /* Signing in is not enough to reach this machine — approving here is.
           Saying so is the whole point of the prompt: every browser is a
           separate device even on hardware already paired, so this must not read
           as a formality (`docs/specs/remote-security-model.md`). */
        <p className="mb-3 text-sm leading-relaxed text-muted">
          This device signed in to your account and is asking to reach this
          machine's terminals. Approve only if you are the one asking.
        </p>
      )}

      <ModalReviewBlock density="default" className="mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <span className="text-muted">Device</span>
        <span className="break-words text-foreground">{request.requestedLabel || '(unnamed)'}</span>
        <span className="text-muted">Account</span>
        <span className="break-words text-foreground">{request.accountId}</span>
        <span className="text-muted">Key</span>
        <span className="text-foreground">{fingerprint}…</span>
      </ModalReviewBlock>

      <p className="mb-4 text-sm leading-relaxed text-muted">
        Approving adds it to this machine only. Your other machines are
        unaffected, and each asks separately.
      </p>

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
