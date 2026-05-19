import { useRef } from 'react';
import {
  AppWindowIcon,
  ArrowSquareOutIcon,
  EnvelopeIcon,
  FileTextIcon,
  PhoneIcon,
  ProhibitIcon,
  XIcon,
  type Icon,
} from '@phosphor-icons/react';
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

interface SchemeAction {
  Icon: Icon;
  label: string;
}

function describeOpenable(scheme: string): SchemeAction {
  switch (scheme) {
    case 'http':
    case 'https':
      return { Icon: ArrowSquareOutIcon, label: 'Opens in your browser' };
    case 'file':
      return { Icon: FileTextIcon, label: 'Opens a local file' };
    case 'mailto':
      return { Icon: EnvelopeIcon, label: 'Opens your email app' };
    case 'tel':
    case 'sms':
      return { Icon: PhoneIcon, label: 'Opens your phone app' };
    default:
      return { Icon: AppWindowIcon, label: `Opens with your ${scheme}: handler` };
  }
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
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openableDecision = request.decision.status === 'openable' ? request.decision : null;
  const blockedDecision = request.decision.status === 'blocked' ? request.decision : null;
  const openable = openableDecision !== null;
  const displayUri = request.decision.displayUri || request.uri;
  const action = openableDecision ? describeOpenable(openableDecision.scheme) : null;

  useModalFocusTrap(dialogRef, {
    initialFocusRef: openable ? cancelButtonRef : closeButtonRef,
    onEscape: onCancel,
  });

  return (
    <ModalOverlay zIndex={9999} backdrop="strong" className="px-4 py-6">
      <ModalSurface
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="external-link-dialog-title"
        aria-describedby="external-link-dialog-status"
        elevation="modal"
        className="w-full max-w-[34rem]"
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2
              id="external-link-dialog-title"
              className="text-sm font-semibold leading-5 text-foreground"
            >
              Open URL?
            </h2>
            <div id="external-link-dialog-status" className="mt-1 flex items-start gap-1.5 text-xs leading-snug">
              {action ? (
                <>
                  <action.Icon
                    size={13}
                    weight="regular"
                    className="mt-px shrink-0 text-muted"
                    aria-hidden
                  />
                  <span className="text-muted">{action.label}</span>
                </>
              ) : (
                <>
                  <ProhibitIcon
                    size={13}
                    weight="bold"
                    className="mt-px shrink-0 text-error"
                    aria-hidden
                  />
                  <span className="text-foreground">
                    <span className="font-semibold">Blocked.</span>{' '}
                    <span className="text-muted">{blockedDecision?.reason}</span>
                  </span>
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            className={modalIconButton()}
            onClick={onCancel}
          >
            <XIcon size={13} weight="bold" />
          </button>
        </div>

        <div className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-app-bg px-2.5 py-2 text-sm leading-relaxed text-foreground">
          {displayUri}
        </div>

        <p className="mt-3 text-xs leading-snug text-muted">
          Terminal output can hide a different target behind link text.
        </p>

        {openable ? (
          <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <button
              ref={cancelButtonRef}
              type="button"
              onClick={onCancel}
              className={modalActionButton({ tone: 'secondary' })}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className={modalActionButton({ tone: 'primary' })}
            >
              Open URL
            </button>
          </div>
        ) : (
          <div className="mt-4 flex justify-end text-xs">
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onCancel}
              className={`${modalActionButton({ tone: 'primary' })} min-w-[6rem]`}
            >
              Close
            </button>
          </div>
        )}
      </ModalSurface>
    </ModalOverlay>
  );
}
