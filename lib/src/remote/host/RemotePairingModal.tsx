import { useRef, useState } from 'react';
import { ModalFrame, ModalReviewBlock, modalActionButton } from '../../components/design';
import { PAIRING_CODE_LENGTH } from 'remote-lib-common';

/**
 * The Host's local pairing confirmation (relay.md → "Pairing approval modal";
 * same pattern as KillConfirm). Confirming here is the only path that writes
 * the ACL.
 *
 * **The direction of the code is the control.** The phone displays two digits
 * and the person types them on the laptop, so authorizing requires holding the
 * device that is asking — a relayed or injected request has no screen to read
 * from, and the copy below tells the user exactly that. The Host holds the
 * expected digits and compares them itself; this component never sees them, and
 * gets **one** attempt (`docs/specs/remote-security-model.md` → Pairing).
 */
export function RemotePairingModal({
  label,
  onApprove,
  onDeny,
}: {
  /** The Client's own name for itself, already bounded by the Host. */
  label: string;
  onApprove: (code: string) => void;
  onDeny: () => void;
}) {
  const denyButtonRef = useRef<HTMLButtonElement>(null);
  const [code, setCode] = useState('');
  const complete = code.length === PAIRING_CODE_LENGTH;

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
      {/* The exact copy the spec fixes. It has to name the failure mode — a
          request that shows no code — because that is the only signal a user
          gets when something other than the phone in their hand is asking. */}
      <p className="mb-3 text-sm leading-relaxed text-muted">
        Only authorize if your phone is showing a two-digit code. If it shows an error or no code,
        cancel this request.
      </p>

      <ModalReviewBlock density="default" className="mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <span className="text-muted">Device</span>
        <span className="break-words text-foreground">{label || '(unnamed)'}</span>
      </ModalReviewBlock>

      <label className="mb-4 flex items-center gap-3 text-sm text-muted">
        <span>Code from the phone</span>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-label="Two-digit code from the phone"
          value={code}
          // Digits only, and never more than two: the field is the whole secret,
          // so anything it accepts that the Host cannot match is a dead attempt
          // the user does not get back.
          onChange={(event) =>
            setCode(event.target.value.replace(/\D/g, '').slice(0, PAIRING_CODE_LENGTH))
          }
          onKeyDown={(event) => {
            if (event.key === 'Enter' && complete) onApprove(code);
          }}
          className="w-16 rounded border border-border bg-surface px-2 py-1 text-center font-mono text-base tracking-widest text-foreground"
        />
      </label>

      <p className="mb-4 text-sm leading-relaxed text-muted">
        Approving adds it to this machine only. Your other machines are unaffected, and each asks
        separately.
      </p>

      <div className="flex justify-end gap-2">
        <button
          ref={denyButtonRef}
          type="button"
          onClick={onDeny}
          className={modalActionButton({ tone: 'secondary' })}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!complete}
          onClick={() => onApprove(code)}
          className={modalActionButton({ tone: 'primary' })}
        >
          Confirm and authorize
        </button>
      </div>
    </ModalFrame>
  );
}
