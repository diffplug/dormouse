import { useRef } from 'react';
import { MODAL_OVERLAY_INSET, modalActionButton, ModalFrame } from './design';

/** What a close is asking, in the desktop's words (`docs/specs/mobile-terminal-ui.md` -> "Browser"). */
export type MobileCloseDialogState =
  | { kind: 'confirm'; char: string; onConfirm: () => void; onCancel: () => void }
  | {
      kind: 'unsaved';
      labels: readonly string[];
      saving?: boolean;
      error?: string;
      onSave: () => void;
      onDiscard: () => void;
      onCancel: () => void;
    }
  | { kind: 'refused'; message: string; onDismiss: () => void };

const TITLE: Record<MobileCloseDialogState['kind'], string> = {
  confirm: 'Confirm kill',
  unsaved: 'Save changes?',
  refused: 'Not closed',
};

const ESCAPE: Record<MobileCloseDialogState['kind'], (state: never) => () => void> = {
  confirm: (state: { onCancel: () => void }) => state.onCancel,
  unsaved: (state: { onCancel: () => void }) => state.onCancel,
  refused: (state: { onDismiss: () => void }) => state.onDismiss,
};

export function MobileCloseDialog({ state }: { state: MobileCloseDialogState }) {
  const firstButton = useRef<HTMLButtonElement>(null);
  return (
    <ModalFrame
      titleId="mobile-close-title"
      layer="critical"
      overlayClassName={MODAL_OVERLAY_INSET}
      className="w-full max-w-72 font-mono"
      initialFocusRef={firstButton}
      onEscape={ESCAPE[state.kind](state as never)}
    >
      <h2 id="mobile-close-title" className="text-sm font-semibold">{TITLE[state.kind]}</h2>
      <DialogBody state={state} firstButton={firstButton} />
    </ModalFrame>
  );
}

function DialogBody({ state, firstButton }: { state: MobileCloseDialogState; firstButton: React.RefObject<HTMLButtonElement | null> }) {
  switch (state.kind) {
    case 'confirm':
      // The letter stands where a double-tap on the header's close cannot reach,
      // which is what typing it guards on the desktop.
      return (
        <div className="mt-3 grid justify-items-center gap-3">
          <button
            type="button"
            aria-label={`Confirm with ${state.char}`}
            onClick={state.onConfirm}
            className="grid size-14 place-items-center rounded border border-border bg-app-bg text-xl font-bold text-error"
          >
            {state.char}
          </button>
          <div className="text-xs text-muted">Tap {state.char} to confirm</div>
          <button ref={firstButton} type="button" onClick={state.onCancel} className={modalActionButton({ class: 'min-h-10 w-full' })}>Cancel</button>
        </div>
      );
    case 'unsaved':
      return (
        <>
          <ul className="mt-2 break-words text-xs">
            {state.labels.map((label) => <li key={label}>{label}</li>)}
          </ul>
          {state.error ? <p role="alert" className="mt-2 text-xs text-error">{state.error}</p> : null}
          <div className="mt-3 grid grid-cols-3 gap-2">
            <button ref={firstButton} type="button" disabled={state.saving} onClick={state.onCancel} className={modalActionButton({ class: 'min-h-10' })}>Cancel</button>
            <button type="button" disabled={state.saving} onClick={state.onDiscard} className={modalActionButton({ class: 'min-h-10' })}>Discard</button>
            <button type="button" disabled={state.saving} onClick={state.onSave} className={modalActionButton({ tone: 'primary', class: 'min-h-10' })}>{state.saving ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      );
    case 'refused':
      return (
        <>
          <p className="mt-2 break-words text-xs text-muted">{state.message}</p>
          <button ref={firstButton} type="button" onClick={state.onDismiss} className={modalActionButton({ class: 'mt-3 min-h-10 w-full' })}>OK</button>
        </>
      );
  }
}
