import { useRef } from 'react';
import { XIcon } from '@phosphor-icons/react';
import type { ExternalUriDecision } from '../lib/external-links';
import {
  ModalOverlay,
  ModalSurface,
  modalActionButton,
  modalIconButton,
  useModalFocusTrap,
} from './design';

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

  useModalFocusTrap(dialogRef, { initialFocusRef: cancelRef, onEscape: onCancel });

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
            className={modalIconButton()}
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
            className={modalActionButton({ tone: 'secondary' })}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!openable}
            className={modalActionButton({ tone: 'primary' })}
          >
            Open URL
          </button>
        </div>
      </ModalSurface>
    </ModalOverlay>
  );
}
