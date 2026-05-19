import { useRef } from 'react';
import { ProhibitIcon, WarningOctagonIcon, XIcon } from '@phosphor-icons/react';
import type { DisplayMatchVerdict, ExternalUriDecision } from '../lib/external-links';
import {
  ModalOverlay,
  ModalSurface,
  modalActionButton,
  modalIconButton,
  useModalFocusTrap,
} from './design';

export interface ExternalLinkDialogRequest {
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

export function ExternalLinkDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: ExternalLinkDialogRequest;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
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

  useModalFocusTrap(dialogRef, {
    // Deceptive case: focus the copy action so a default Enter doesn't dismiss
    // silently. Everywhere else: focus the safe affordance (Cancel/Close).
    initialFocusRef: isDeceptive ? primaryButtonRef : secondaryButtonRef,
    onEscape: onCancel,
  });

  const handleCopy = () => {
    void navigator.clipboard.writeText(request.uri);
    onCancel();
  };

  return (
    <ModalOverlay zIndex={9999} backdrop="strong" className="px-4 py-6">
      <ModalSurface
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="external-link-dialog-title"
        elevation="modal"
        className="w-full max-w-[34rem]"
      >
        <div className="flex items-start gap-3">
          <h2
            id="external-link-dialog-title"
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
          <button
            type="button"
            aria-label="Close"
            className={modalIconButton()}
            onClick={onCancel}
          >
            <XIcon size={13} weight="bold" />
          </button>
        </div>

        {/* Bordered nested box: explicit exception to the bg-only chrome rule
            in DESIGN.md. The URL is the literal artifact the user is being
            asked to scrutinize, and a framed box reads better than a bare
            bg-shift in this high-stakes context. */}
        <div className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-app-bg px-2.5 py-2 text-sm leading-relaxed text-foreground">
          {displayUri}
        </div>

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
      </ModalSurface>
    </ModalOverlay>
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
