import { useRef } from 'react';
import { ModalFrame, modalActionButton } from './design';
import { resolvePaneElement } from './wall/resolve-pane-element';

/** The Surface whose closure was refused, and why. */
export interface NotepadArchiveFailure {
  id: string;
  message: string;
}

/**
 * The escape hatch for a closure the archive refused
 * (docs/specs/notepad.md → "Closure"). Anchored over the Surface that stayed
 * open, like the kill confirmation, so it is obvious which one is still there —
 * and at the critical layer, because without a way through it an unwritable
 * archive would make every Surface unclosable.
 *
 * Keep open is the default: Close anyway discards this Surface's notes for good.
 */
export function NotepadArchiveFailureModal({
  failure,
  paneElements,
  onKeepOpen,
  onCloseAnyway,
}: {
  failure: NotepadArchiveFailure;
  paneElements: Map<string, HTMLElement>;
  onKeepOpen: () => void;
  onCloseAnyway: () => void;
}) {
  const keepOpenRef = useRef<HTMLButtonElement>(null);
  return (
    <ModalFrame
      titleId="notepad-archive-failure-title"
      targetElement={resolvePaneElement(paneElements.get(failure.id))}
      layer="critical"
      align="start"
      className="w-full max-w-[24rem]"
      initialFocusRef={keepOpenRef}
      onEscape={onKeepOpen}
    >
      <h2 id="notepad-archive-failure-title" className="text-sm leading-5 text-foreground">
        Notes could not be archived
      </h2>
      <p className="mt-2 text-sm text-muted">{failure.message}</p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          ref={keepOpenRef}
          type="button"
          onClick={onKeepOpen}
          className={`${modalActionButton({ tone: 'primary' })} min-w-[5rem]`}
        >
          Keep open
        </button>
        <button
          type="button"
          onClick={onCloseAnyway}
          className={`${modalActionButton({ tone: 'secondary' })} min-w-[5rem]`}
        >
          Close anyway
        </button>
      </div>
    </ModalFrame>
  );
}
