import { useEffect, useRef, useState } from 'react';
import {
  ModalCloseButton,
  ModalFrame,
  modalActionButton,
  modalReviewBlock,
} from '../../lib/src/components/design';
import { openIssueSearch } from './updater';

interface UpdateDebugModalProps {
  onClose: () => void;
  failure: { version: string; error?: string };
  body: string | null;
}

export function UpdateDebugModal({ onClose, failure, body }: UpdateDebugModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(id);
  }, [copied]);

  const handleCopy = async () => {
    if (!body) return;
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
    } catch (e) {
      console.error('[updater] Failed to copy report:', e);
    }
  };

  const errorPreview = failure.error ?? '';

  return (
    <ModalFrame
      titleId="update-debug-modal-title"
      layer="app"
      backdrop="strong"
      elevation="modal"
      padding="none"
      overlayClassName="px-4 py-6"
      className="flex max-h-[80vh] w-full max-w-[35rem] flex-col overflow-hidden"
      initialFocusRef={closeButtonRef}
      onEscape={onClose}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-surface-raised px-4 py-3">
        <h2 id="update-debug-modal-title" className="text-sm font-medium">
          Update failed
        </h2>
        <ModalCloseButton ref={closeButtonRef} onClick={onClose} />
      </div>

      <div className="space-y-4 overflow-y-auto px-4 py-3">
        <div className="space-y-1">
          <p className="text-sm">
            We couldn't install v{failure.version}. The error was:
          </p>
          <pre className={modalReviewBlock({ density: 'compact', overflow: 'short' })}>
            {errorPreview || '(no error captured)'}
          </pre>
        </div>

        <div className="space-y-1">
          <p className="text-sm font-medium">1. Search existing reports</p>
          <p className="text-xs text-muted">
            Someone may have already hit this. A quick search saves a duplicate report.
          </p>
          <button
            type="button"
            onClick={() => openIssueSearch(errorPreview)}
            className={modalActionButton({ tone: 'secondary' })}
          >
            Search GitHub issues
          </button>
        </div>

        <div className="space-y-1">
          <p className="text-sm font-medium">2. File a new bug</p>
          <p className="text-xs text-muted">
            If you can't find an existing bug, copy this report and paste it into a new issue.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              disabled={!body}
              className={modalActionButton({ tone: 'secondary' })}
            >
              Copy report
            </button>
            {copied && <span className="text-xs text-foreground">Copied</span>}
          </div>
          <textarea
            readOnly
            value={body ?? 'Gathering diagnostic info...'}
            className="block h-48 w-full resize-y rounded border border-border bg-app-bg p-2 font-mono text-xs text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring"
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      </div>
    </ModalFrame>
  );
}
