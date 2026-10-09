import { useRef, useState, useSyncExternalStore } from 'react';
import { writeTextToClipboard } from '../lib/clipboard';
import {
  CLIPBOARD_FAILURE_ISSUE_URL,
  dismissClipboardFailure,
  getClipboardFailure,
  subscribeToClipboardFailure,
  type ClipboardFailure,
} from '../lib/clipboard-failure';
import { ExternalTextLink } from './ExternalTextLink';
import { MODAL_OVERLAY_INSET, modalActionButton, ModalCloseButton, ModalFrame, OVERLAY_MAX_HEIGHT } from './design';

/** Opens on a clipboard write that failed every way it could, asking the user
 *  to post its report to the tracking issue. */
export function ClipboardFailureGlobal() {
  const failure = useSyncExternalStore(subscribeToClipboardFailure, getClipboardFailure, getClipboardFailure);
  return failure ? <ClipboardFailureDialog failure={failure} onClose={dismissClipboardFailure} /> : null;
}

export function ClipboardFailureDialog({ failure, onClose }: { failure: ClipboardFailure; onClose: () => void }) {
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyDetails = async () => {
    // Reporting this one would replace the evidence on screen.
    setCopyState(await writeTextToClipboard(failure.report, { reportFailure: false }) ? 'copied' : 'failed');
  };

  return (
    <ModalFrame
      titleId="clipboard-failure-title"
      layer="critical"
      backdrop="strong"
      elevation="modal"
      overlayClassName={MODAL_OVERLAY_INSET}
      className={`${OVERLAY_MAX_HEIGHT.modal} w-full max-w-[36rem] overflow-y-auto`}
      initialFocusRef={copyButtonRef}
      onEscape={onClose}
    >
      <div className="flex items-start gap-3">
        <h2 id="clipboard-failure-title" className="min-w-0 flex-1 text-sm leading-5 text-foreground">
          Copy failed{failure.count > 1 ? ` (${failure.count} times so far)` : ''}
        </h2>
        <ModalCloseButton onClick={onClose} />
      </div>
      <div className="mt-2 space-y-2 text-xs leading-5 text-muted">
        <p>
          Dormouse could not write to your clipboard. This happens rarely and we have not been able to reproduce it, so the details below are valuable.
        </p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Copy the details below.</li>
          <li>
            Add them as a comment on{' '}
            <ExternalTextLink href={CLIPBOARD_FAILURE_ISSUE_URL}>{CLIPBOARD_FAILURE_ISSUE_URL}</ExternalTextLink>
            , along with what you clicked and what you were doing just before.
          </li>
          <li>Then try your copy again; it usually works on a retry.</li>
        </ol>
        <p>The details describe the attempt (timing, focus, browser engine), never what you were copying.</p>
      </div>
      <textarea
        readOnly
        aria-label="Copy failure details"
        value={failure.report}
        className="mt-3 h-40 w-full resize-none rounded border border-border bg-app-bg p-2 font-mono text-xs text-foreground outline-none"
      />
      {copyState === 'failed' && (
        <p role="alert" className="mt-2 text-xs text-error">That copy failed too. Select the details above and copy them with the keyboard.</p>
      )}
      <div className="mt-4 flex justify-end gap-2 text-xs">
        <button type="button" onClick={onClose} className={`${modalActionButton({ tone: 'secondary' })} min-w-[5rem]`}>
          Close
        </button>
        <button ref={copyButtonRef} type="button" onClick={() => void copyDetails()} className={`${modalActionButton({ tone: 'primary' })} min-w-[7rem]`}>
          {copyState === 'copied' ? 'Copied' : 'Copy details'}
        </button>
      </div>
    </ModalFrame>
  );
}
