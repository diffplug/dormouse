import type { DocumentState } from './document-session';

/** A page's Save: enabled while the document has unsaved edits and no save is running. */
export function SaveButton({ state, onSave, className = 'ie-save' }: { state: DocumentState; onSave(): void; className?: string }) {
  return (
    <button type="button" className={className} aria-disabled={!state.dirty || state.saving} data-tip="Save [Cmd/Ctrl+S]" onClick={onSave}>
      {state.saving ? 'Saving…' : 'Save'}
    </button>
  );
}
