import { useRef, useState } from 'react';
import { ModalFrame, ModalReviewBlock, modalActionButton } from '../../components/design';
import { PAIRING_CODE_LENGTH } from 'remote-lib-common';
import type { ApprovalKind } from '../../host/remote/service-protocol';

/**
 * What differs between the two ceremonies the modal confirms. The warning
 * about a phone showing no code is the same for both: it names the one failure
 * mode either request can hide behind.
 */
const COPY: Record<ApprovalKind, { title: string; consequence: string; confirm: string }> = {
  pairing: {
    title: 'Pair a new device',
    consequence:
      'Approving adds it to this machine only. Your other machines are unaffected, and each asks separately.',
    confirm: 'Confirm and authorize',
  },
  // A one-time connection writes nothing, so the copy says what it grants
  // instead: all of it, for as long as it lasts (docs/specs/one-time.md).
  'one-time': {
    title: 'Allow a one-time connection',
    consequence:
      'This phone gets full control of every terminal here until it disconnects or you end it. Nothing is saved.',
    confirm: 'Confirm and allow',
  },
};

/**
 * The Burrow's local pairing confirmation (`docs/specs/burrow-service.md` → "Burrow side";
 * same pattern as KillConfirm). Confirming a pairing here is the only path that
 * writes the ACL; confirming a one-time request authorizes one session and
 * writes nothing.
 *
 * **The direction of the code is the control.** The phone displays two digits
 * and the person types them on the laptop, so authorizing requires holding the
 * device that is asking — a relayed or injected request has no screen to read
 * from, and the copy below tells the user exactly that. The Burrow holds the
 * expected digits and compares them itself; this component never sees them, and
 * gets **one** attempt (`docs/specs/remote-security-model.md` → Pairing).
 */
export function RemotePairingModal({
  kind = 'pairing',
  label,
  onApprove,
  onDeny,
}: {
  /** Which ceremony is asking; a pairing unless told otherwise. */
  kind?: ApprovalKind;
  /**
   * The Client's own name for itself, already bounded by the Burrow; for a
   * one-time request, a member of `ONE_TIME_DEVICE_LABELS` whatever the phone sent.
   */
  label: string;
  onApprove: (code: string) => void;
  onDeny: () => void;
}) {
  const denyButtonRef = useRef<HTMLButtonElement>(null);
  const [code, setCode] = useState('');
  const complete = code.length === PAIRING_CODE_LENGTH;
  const copy = COPY[kind];

  return (
    <ModalFrame
      titleId="remote-pairing-title"
      padding="spacious"
      align="start"
      initialFocusRef={denyButtonRef}
      onEscape={onDeny}
    >
      <h2 id="remote-pairing-title" className="mb-1 text-base font-bold text-foreground">
        {copy.title}
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
          // so anything it accepts that the Burrow cannot match is a dead attempt
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

      <p className="mb-4 text-sm leading-relaxed text-muted">{copy.consequence}</p>

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
          {copy.confirm}
        </button>
      </div>
    </ModalFrame>
  );
}
