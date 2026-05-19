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

interface OpenNoun {
  // The noun phrase that follows "Open " in titles and buttons (e.g. "URL",
  // "file"). For custom protocols this is JSX so we can render the scheme
  // prefix as inline code.
  title: React.ReactNode;
  // The button label noun. May differ from the title noun for compactness
  // (e.g. custom protocol uses just the prefix without "custom protocol").
  button: React.ReactNode;
}

function pickOpenNoun(scheme: string, uri: string): OpenNoun {
  switch (scheme) {
    case 'http':
    case 'https':
      return { title: 'URL', button: 'URL' };
    case 'file':
      return { title: 'file', button: 'file' };
    case 'mailto':
      return { title: 'email', button: 'email' };
    case 'tel':
      return { title: 'phone app', button: 'phone app' };
    case 'sms':
      return { title: 'SMS app', button: 'SMS app' };
    default: {
      const prefix = schemePrefix(scheme, uri);
      return {
        title: <>custom protocol <code className="font-mono">{prefix}</code></>,
        button: <code className="font-mono">{prefix}</code>,
      };
    }
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
  const noun = openableDecision ? pickOpenNoun(openableDecision.scheme, openableDecision.uri) : null;

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
              <OpenTitle noun={noun?.title ?? 'URL'} verdict={verdict} displayText={request.displayText} />
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
                {'Open '}{noun?.button ?? 'URL'}
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
  noun,
  verdict,
  displayText,
}: {
  noun: React.ReactNode;
  verdict: DisplayMatchVerdict;
  displayText: string;
}) {
  if (verdict === 'plain' && displayText.trim()) {
    return (
      <>
        Open {noun}: <span className="font-semibold">{displayText.trim()}</span>?
      </>
    );
  }
  return <>Open {noun}?</>;
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
