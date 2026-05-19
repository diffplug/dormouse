import { useEffect, useRef, useState } from 'react';
import {
  ModalCloseButton,
  ModalOverlay,
  ModalSurface,
  modalActionButton,
  useModalFocusTrap,
} from '../../lib/src/components/design';
import { openIssueSearch } from './updater';

interface UpdateDebugDialogProps {
  open: boolean;
  onClose: () => void;
  failure: { version: string; error?: string };
  body: string | null;
}

export function UpdateDebugDialog({ open, onClose, failure, body }: UpdateDebugDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);

  useModalFocusTrap(dialogRef, {
    initialFocusRef: closeButtonRef,
    onEscape: onClose,
  });

  useEffect(() => {
    if (open) closeButtonRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(id);
  }, [copied]);

  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

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

  if (!open) return null;

  return (
    <ModalOverlay zIndex={50} backdrop="strong" className="px-4 py-6">
      <ModalSurface
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-debug-dialog-title"
        elevation="modal"
        padding="none"
        className="flex max-h-[80vh] w-full max-w-[35rem] flex-col overflow-hidden"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border bg-surface-raised px-4 py-3">
          <h2 id="update-debug-dialog-title" className="text-sm font-medium">
            Update failed
          </h2>
          <ModalCloseButton ref={closeButtonRef} onClick={onClose} />
        </div>

        <div className="space-y-4 overflow-y-auto px-4 py-3">
          <div className="space-y-1">
            <p className="text-sm">
              We couldn't install v{failure.version}. The error was:
            </p>
            <pre className="max-h-32 overflow-auto rounded border border-border bg-app-bg p-2 text-xs font-mono whitespace-pre-wrap break-words">
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
              className="block h-48 w-full resize-y rounded border border-border bg-app-bg p-2 text-xs font-mono text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring"
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
        </div>
      </ModalSurface>
    </ModalOverlay>
  );
}
