import { useRef } from 'react';
import type { OpenHandler } from 'dor/commands/types';
import { printableExact } from 'dor/commands/terminal-text';
import { ProhibitIcon, WarningIcon, WarningOctagonIcon } from '@phosphor-icons/react';
import { writeTextToClipboard } from '../lib/clipboard';
import type { DisplayMatchVerdict, ExternalUriDecision } from '../lib/external-links';
import {
  MODAL_OVERLAY_INSET,
  modalActionButton,
  ModalCloseButton,
  ModalFrame,
  ModalReviewBlock,
  OVERLAY_MAX_HEIGHT,
} from './design';

export interface ExternalLinkModalRequest {
  uri: string;
  displayText: string;
  verdict: DisplayMatchVerdict;
  decision: ExternalUriDecision;
  /** Why this open is asked about, below the target. */
  note?: string;
}

// "Open ___" button label suffix: the scheme noun sits next to the cursor, so
// the user sees what they're committing to. Another app's scheme is shown as is.
const STANDARD_NOUNS: Record<string, string> = { http: 'URL', https: 'URL', file: 'file', mailto: 'email' };

function pickOpenButtonNoun({ scheme, uri, otherApp }: { scheme: string; uri: string; otherApp: boolean }): React.ReactNode {
  return otherApp ? <code className="font-mono">{schemePrefix(scheme, uri)}</code> : STANDARD_NOUNS[scheme];
}

function schemePrefix(scheme: string, uri: string): string {
  return uri.slice(scheme.length + 1).startsWith('//') ? `${scheme}://` : `${scheme}:`;
}

export function ExternalLinkModal({
  request,
  onCancel,
  onConfirm,
  handlers = [],
  selected = 0,
  onSelect,
  busy = false,
  error,
}: {
  request: ExternalLinkModalRequest;
  onCancel: () => void;
  onConfirm: () => void;
  handlers?: OpenHandler[];
  /** The chosen index into `handlers`; the first is the default. */
  selected?: number;
  onSelect?: (index: number) => void;
  busy?: boolean;
  error?: string;
}) {
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  const secondaryButtonRef = useRef<HTMLButtonElement>(null);

  const openableDecision = request.decision.status === 'openable' ? request.decision : null;
  const blockedDecision = request.decision.status === 'blocked' ? request.decision : null;
  // Terminal text, shown exactly: a blocked URL keeps whatever got it blocked.
  const displayUri = printableExact(request.decision.displayUri || request.uri);
  const verdict = request.verdict;
  const isDeceptive = verdict === 'deceptive';
  const buttonNoun = openableDecision ? pickOpenButtonNoun(openableDecision) : 'URL';

  const handleCopy = () => {
    void writeTextToClipboard(request.uri);
    onCancel();
  };

  return (
    <ModalFrame
      titleId="external-link-modal-title"
      layer="critical"
      backdrop="strong"
      elevation="modal"
      overlayClassName={MODAL_OVERLAY_INSET}
      className={`${OVERLAY_MAX_HEIGHT.modal} w-full max-w-[34rem] overflow-y-auto`}
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
          ) : openableDecision?.otherApp ? (
            <OtherAppTitle scheme={openableDecision.scheme} displayText={verdict === 'plain' ? request.displayText.trim() : ''} />
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

      {request.note && openableDecision && !isDeceptive && (
        <p className="mt-3 text-xs text-muted">{request.note}</p>
      )}
      {openableDecision?.otherApp && !isDeceptive && (
        <p className="mt-3 text-xs text-muted">
          Dormouse hands this link to whichever app is registered for{' '}
          <code className="font-mono">{openableDecision.scheme}:</code> links, and cannot check what that app does
          with it. Open it only if you trust the program that printed it.
        </p>
      )}
      {openableDecision && !isDeceptive && handlers.length > 0 && (
        <div className="mt-3 text-xs">
          <label className="flex items-center gap-2">
            Open with
            <select
              aria-label="File viewer"
              value={selected}
              disabled={busy}
              onChange={event => onSelect?.(Number(event.target.value))}
              className="min-w-0 flex-1 rounded border border-input-border bg-input-bg p-1 text-foreground"
            >
              {handlers.map((handler, index) => (
                <option key={handler.tool} value={index}>
                  {handler.tool}{index === 0 ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-1 break-words text-muted">
            {handlers[selected].description}
            {' — '}
            {handlers[selected].reason}
          </p>
        </div>
      )}
      {error && <p role="alert" className="mt-3 break-words text-xs text-error">{printableExact(error)}</p>}

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
              disabled={busy}
              className={`${modalActionButton({ tone: 'primary' })} min-w-[5rem]`}
            >
              {busy ? 'Please wait…' : <>Open {buttonNoun}</>}
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
        Confirm open: <span className="font-semibold">{printableExact(displayText.trim())}</span>
      </>
    );
  }
  return <>Confirm open</>;
}

function IconTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="flex items-start gap-1.5">
      {icon}
      <span className="leading-snug">{children}</span>
    </span>
  );
}

const TITLE_ICON = 'mt-px shrink-0 text-error';

function OtherAppTitle({ scheme, displayText }: { scheme: string; displayText: string }) {
  return (
    <IconTitle icon={<WarningIcon size={14} weight="fill" className={TITLE_ICON} aria-hidden />}>
      This link opens another app: <code className="font-mono font-semibold">{scheme}:</code>
      {displayText && <> — <span className="font-semibold">{printableExact(displayText)}</span></>}
    </IconTitle>
  );
}

function DeceptiveTitle({ displayText }: { displayText: string }) {
  return (
    <IconTitle icon={<WarningOctagonIcon size={14} weight="fill" className={TITLE_ICON} aria-hidden />}>
      Deceptive link text was{' '}
      <span className="font-semibold">{printableExact(displayText.trim())}</span>, URL was:
    </IconTitle>
  );
}

function BlockedTitle({ reason }: { reason: string }) {
  return (
    <IconTitle icon={<ProhibitIcon size={14} weight="bold" className={TITLE_ICON} aria-hidden />}>
      Blocked. <span className="text-muted">{reason}</span>
    </IconTitle>
  );
}
