/**
 * Approve (or decline) a repo's `dormouse.yml`
 * (`docs/specs/dor-tool.md` -> Trust).
 *
 * This dialog is the *only* way trust is granted. It is drawn in Dormouse's own
 * chrome rather than in the terminal because an agent holding the control token
 * can `dor send` keystrokes indistinguishable from a human typing — a prompt
 * rendered as terminal output would be answerable by the very caller it is
 * meant to gate. A click here is not reachable from inside a PTY.
 *
 * Both answers are recorded. Remembering the decline is what stops a hostile
 * repo re-asking on every invocation.
 */
import { useRef } from 'react';
import {
  MODAL_OVERLAY_INSET,
  ModalFrame,
  ModalReviewBlock,
  OVERLAY_MAX_HEIGHT,
  modalActionButton,
} from '../design';

export interface ToolTrustRequest {
  projectRoot: string;
  path: string;
  name: string;
  run: string;
}

export function ToolTrustDialog({
  request,
  onDecision,
}: {
  request: ToolTrustRequest;
  onDecision: (decision: 'trusted' | 'denied') => void;
}) {
  // Focus the safe affordance: a reflexive Enter declines rather than approving
  // code from a repo the user has not looked at.
  const declineRef = useRef<HTMLButtonElement>(null);

  return (
    <ModalFrame
      titleId="tool-trust-modal-title"
      layer="critical"
      backdrop="strong"
      elevation="modal"
      overlayClassName={MODAL_OVERLAY_INSET}
      className={`${OVERLAY_MAX_HEIGHT.modal} w-full max-w-[34rem] overflow-y-auto`}
      initialFocusRef={declineRef}
      onEscape={() => onDecision('denied')}
    >
      <div className="flex flex-col gap-3 font-mono text-xs">
        <h2 id="tool-trust-modal-title" className="text-sm text-foreground">
          Run tools from this repo?
        </h2>
        <p className="text-muted">
          <span className="text-foreground">{request.path}</span> decides what{' '}
          <span className="text-foreground">dor tool</span> runs here. Approving lets it start
          commands this repo chose.
        </p>
        <ModalReviewBlock density="compact">
          {request.name}: {request.run}
        </ModalReviewBlock>
        <p className="text-muted">
          Approval covers this directory and is remembered, including for tools added to the file
          later. Declining is remembered too.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            ref={declineRef}
            className={modalActionButton()}
            onClick={() => onDecision('denied')}
          >
            Don't run
          </button>
          <button
            type="button"
            className={modalActionButton({ tone: 'primary' })}
            onClick={() => onDecision('trusted')}
          >
            Approve this repo
          </button>
        </div>
      </div>
    </ModalFrame>
  );
}
