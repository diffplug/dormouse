import { useRef } from 'react';
import { ProhibitIcon, WarningOctagonIcon } from '@phosphor-icons/react';
import type { DisplayMatchVerdict, ExternalUriDecision } from '../lib/external-links';
import {
  ModalCloseButton,
  ModalFrame,
  ModalReviewBlock,
  modalActionButton,
} from './design';

export interface ExternalLinkModalRequest {
  uri: string;
  displayText: string;
  verdict: DisplayMatchVerdict;
  decision: ExternalUriDecision;
}

// "Open ___" button label suffix. The title is uniformly "Confirm open" and
// doesn't vary with scheme; the button is the only place the scheme noun
// appears, so the user sees what they're committing to next to their cursor.
function pickOpenButtonNoun(scheme: string, uri: string): React.ReactNode {
  switch (scheme) {
    case 'http':
    case 'https':
      return 'URL';
    case 'file':
      return 'file';
    case 'mailto':
      return 'email';
    case 'tel':
      return 'phone app';
    case 'sms':
      return 'SMS app';
    default:
      return <code className="font-mono">{schemePrefix(scheme, uri)}</code>;
  }
}

function schemePrefix(scheme: string, uri: string): string {
  return uri.slice(scheme.length + 1).startsWith('//') ? `${scheme}://` : `${scheme}:`;
}

export function ExternalLinkModal({
  request,
  onCancel,
  onConfirm,
}: {
  request: ExternalLinkModalRequest;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  const secondaryButtonRef = useRef<HTMLButtonElement>(null);

  const openableDecision = request.decision.status === 'openable' ? request.decision : null;
  const blockedDecision = request.decision.status === 'blocked' ? request.decision : null;
  const displayUri = request.decision.displayUri || request.uri;
  const verdict = request.verdict;
  const isDeceptive = verdict === 'deceptive';
  const buttonNoun = openableDecision
    ? pickOpenButtonNoun(openableDecision.scheme, openableDecision.uri)
    : 'URL';

  const handleCopy = () => {
    void navigator.clipboard.writeText(request.uri);
    onCancel();
  };

  return (
    <ModalFrame
      titleId="external-link-modal-title"
      layer="critical"
      backdrop="strong"
      elevation="modal"
      overlayClassName="px-4 py-6"
      className="w-full max-w-[34rem]"
      // Deceptive case: focus the copy action so a default Enter doesn't dismiss
      // silently. Everywhere else: focus the safe affordance (Cancel/Close).
      initialFocusRef={isDeceptive ? primaryButtonRef : secondaryButtonRef}
      onEscape={onCancel}
    >
      <div className="flex items-start gap-3">
        <h2
          id="external-link-modal-title"
          className="min-w-0 flex-1 text-sm leading-5 text-foreground"
        >
          {isDeceptive ? (
            <DeceptiveTitle displayText={request.displayText} />
          ) : blockedDecision ? (
            <BlockedTitle reason={blockedDecision.reason} />
          ) : (
            <OpenTitle verdict={verdict} displayText={request.displayText} />
          )}
        </h2>
        <ModalCloseButton onClick={onCancel} />
      </div>

      {/* Bordered nested box: explicit exception to the bg-only chrome rule
          in DESIGN.md. The URL is the literal artifact the user is being
          asked to scrutinize, and a framed box reads better than a bare
          bg-shift in this high-stakes context. */}
      <ModalReviewBlock className="mt-3" wrap="breakAll">
        {displayUri}
      </ModalReviewBlock>

      <div className="mt-4 flex justify-end gap-2 text-xs">
        {isDeceptive ? (
          <>
            <button
              ref={secondaryButtonRef}
              type="button"
              onClick={onCancel}
              className={`${modalActionButton({ tone: 'secondary' })} min-w-[5rem]`}
            >
              Close
            </button>
            <button
              ref={primaryButtonRef}
              type="button"
              onClick={handleCopy}
              className={modalActionButton({ tone: 'primary' })}
            >
              Copy deceptive URL to clipboard
            </button>
          </>
        ) : openableDecision ? (
          <>
            <button
              ref={secondaryButtonRef}
              type="button"
              onClick={onCancel}
              className={`${modalActionButton({ tone: 'secondary' })} min-w-[5rem]`}
            >
              Cancel
            </button>
            <button
              ref={primaryButtonRef}
              type="button"
              onClick={onConfirm}
              className={`${modalActionButton({ tone: 'primary' })} min-w-[5rem]`}
            >
              {'Open '}{buttonNoun}
            </button>
          </>
        ) : (
          <button
            ref={secondaryButtonRef}
            type="button"
            onClick={onCancel}
            className={`${modalActionButton({ tone: 'primary' })} min-w-[6rem]`}
          >
            Close
          </button>
        )}
      </div>
    </ModalFrame>
  );
}

function OpenTitle({
  verdict,
  displayText,
}: {
  verdict: DisplayMatchVerdict;
  displayText: string;
}) {
  if (verdict === 'plain' && displayText.trim()) {
    return (
      <>
        Confirm open: <span className="font-semibold">{displayText.trim()}</span>
      </>
    );
  }
  return <>Confirm open</>;
}

function DeceptiveTitle({ displayText }: { displayText: string }) {
  return (
    <span className="flex items-start gap-1.5">
      <WarningOctagonIcon
        size={14}
        weight="fill"
        className="mt-px shrink-0 text-error"
        aria-hidden
      />
      <span className="leading-snug">
        Deceptive link text was{' '}
        <span className="font-semibold">{displayText.trim()}</span>, URL was:
      </span>
    </span>
  );
}

function BlockedTitle({ reason }: { reason: string }) {
  return (
    <span className="flex items-start gap-1.5">
      <ProhibitIcon size={14} weight="bold" className="mt-px shrink-0 text-error" aria-hidden />
      <span className="leading-snug">
        Blocked.{' '}
        <span className="text-muted">{reason}</span>
      </span>
    </span>
  );
}
