import { useEffect, useRef } from 'react';
import { XIcon } from '@phosphor-icons/react';
import type { ExternalUriDecision } from '../lib/external-links';

export interface ExternalLinkDialogRequest {
  uri: string;
  decision: ExternalUriDecision;
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
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openable = request.decision.status === 'openable';
  const blockedDecision = request.decision.status === 'blocked' ? request.decision : null;
  const scheme = request.decision.scheme ?? 'invalid';
  const displayUri = request.decision.displayUri || request.uri;

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      );
      if (focusables.length === 0) return;

      const currentIndex = focusables.findIndex((item) => item === document.activeElement);
      const nextIndex = currentIndex === -1
        ? 0
        : (currentIndex + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length;

      event.preventDefault();
      focusables[nextIndex]?.focus();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[9999] grid place-items-center bg-app-bg/55 px-4 py-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="external-link-dialog-title"
        className="w-full max-w-[34rem] rounded-lg border border-border bg-surface-raised p-4 font-mono text-foreground shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="external-link-dialog-title" className="text-sm font-semibold leading-5 text-foreground">
              Open URL?
            </h2>
            <div className="mt-1 text-xs leading-snug text-muted">
              Terminal output can hide a different target behind link text.
            </div>
          </div>
          <button
            type="button"
            aria-label="Cancel"
            className="shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring"
            onClick={onCancel}
          >
            <XIcon size={13} weight="bold" />
          </button>
        </div>

        <div className="mt-4 grid gap-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted">scheme</span>
            <span className="rounded border border-border bg-app-bg px-1.5 py-0.5 text-foreground">
              {scheme}
            </span>
          </div>
          <div className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-app-bg px-2.5 py-2 text-sm leading-relaxed text-foreground">
            {displayUri}
          </div>
        </div>

        {blockedDecision && (
          <div className="mt-3 rounded border border-border bg-app-bg px-2.5 py-2 text-xs leading-snug text-muted">
            {blockedDecision.reason}
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-2 py-1.5 text-muted transition-colors hover:bg-header-inactive-bg hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!openable}
            className="rounded bg-header-active-bg px-2 py-1.5 text-header-active-fg transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-45"
          >
            Open URL
          </button>
        </div>
      </div>
    </div>
  );
}
